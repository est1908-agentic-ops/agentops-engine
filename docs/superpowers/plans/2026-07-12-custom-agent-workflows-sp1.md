# Custom Agent Workflows — SP1 (Tier 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Tier 1 of the custom-agent-workflows design: a git-committed `agents.json` manifest, a `ConfigSync` reconciler that turns it into Temporal Schedules, a `createIssue` activity with fingerprint dedup, prompt-provenance on run stats, and the first built-in finder workflow `whiteboxBugHunt`.

**Architecture:** New built-in Temporal TS workflows run on the shared engine fleet, parameterized by `ProjectConfig`. A strict zod manifest (`AgentsManifestSchema`) is validated and reconciled into Temporal Schedules by a `ConfigSync` workflow (I/O in activities, the create/update/delete/pause decision in a pure `reconcileAgents` policy). `whiteboxBugHunt` runs a read-only agent, parses findings fail-safe, and files `bug`-labeled issues deduped by a Postgres `filed_findings` projection.

**Tech Stack:** Node 22, pnpm workspaces, TypeScript strict, Temporal TS SDK (`@temporalio/*`), zod (`packages/contracts`), vitest + `@temporalio/testing`.

## Global Constraints

- **Determinism boundary:** `packages/workflows` code does no I/O, no `Date.now()`/`Math.random()`/timers, no imports from `activities`/`ports`/`backends`. All side effects go through proxied activities.
- **`packages/policies` is pure** (no Temporal, no I/O) and is held to **100% coverage** (`pnpm test:policies-coverage`, `vitest.coverage.config.ts`).
- **Contracts first:** every new cross-package shape is a zod schema in `packages/contracts` (`<Thing>Schema` + `export type <Thing> = z.infer<typeof <Thing>Schema>`), re-exported from `packages/contracts/src/index.ts`. No `any`.
- **Ports, not vendors:** only `packages/ports/**` may call a tracker/forge SDK.
- **No secrets** in code or fixtures; tests use the `stub` backend and `memory` ports.
- **Adding a `Stage` value is a deliberate contract change** — this plan adds `bughunt` (sanctioned by the design's §7).
- **Every task ends green:** `pnpm lint && pnpm typecheck && pnpm test`; `pnpm e2e` for tasks touching workflows/policies/activities/backends.
- **Conventional commits** (`feat:`, `test:`, `docs:`, …). Unit tests live next to source as `*.test.ts`; e2e lives in root `e2e/*.e2e.test.ts`.
- Design authority: `docs/superpowers/specs/2026-07-12-custom-agent-workflows-design.md` (SP1 = §10 row 1, done-when = §11).

---

### Task 1: Manifest contract — `AgentsManifestSchema` + `parseAgentsManifest`

**Files:**
- Create: `packages/contracts/src/agents-manifest.ts`
- Create: `packages/contracts/src/agents-manifest.test.ts`
- Modify: `packages/contracts/src/index.ts` (add `export * from './agents-manifest';`)

**Interfaces:**
- Produces: `AgentSpecSchema`, `AgentsManifestSchema`, `type AgentSpec`, `type AgentsManifest`, `parseAgentsManifest(raw: unknown, opts: { workflowInputs: Record<string, z.ZodTypeAny> }): AgentsManifest`, `InvalidAgentsManifestError`, `WhiteboxBugHuntManifestInputSchema`, `BUILTIN_WORKFLOW_INPUTS`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/contracts/src/agents-manifest.test.ts
import { describe, it, expect } from 'vitest';
import { parseAgentsManifest, BUILTIN_WORKFLOW_INPUTS, InvalidAgentsManifestError } from './agents-manifest';

const opts = { workflowInputs: BUILTIN_WORKFLOW_INPUTS };

describe('parseAgentsManifest', () => {
  it('accepts a valid whiteboxBugHunt entry', () => {
    const m = parseAgentsManifest(
      { agents: [{ name: 'nightly-bughunt', workflow: 'whiteboxBugHunt', schedule: '0 2 * * *', input: { focus: 'auth' } }] },
      opts,
    );
    expect(m.agents[0]).toMatchObject({ name: 'nightly-bughunt', enabled: true, timezone: 'UTC', overlap: 'skip' });
  });

  it('rejects unknown top-level/entry keys (strict)', () => {
    expect(() => parseAgentsManifest({ agents: [], oops: 1 }, opts)).toThrow(InvalidAgentsManifestError);
  });

  it('rejects a bad cron and a bad name', () => {
    expect(() => parseAgentsManifest({ agents: [{ name: 'x', workflow: 'whiteboxBugHunt', schedule: 'not cron' }] }, opts)).toThrow(InvalidAgentsManifestError);
    expect(() => parseAgentsManifest({ agents: [{ name: 'Bad_Name', workflow: 'whiteboxBugHunt', schedule: '0 2 * * *' }] }, opts)).toThrow(InvalidAgentsManifestError);
  });

  it('accepts "continuous" as a schedule', () => {
    const m = parseAgentsManifest({ agents: [{ name: 'mon', workflow: 'whiteboxBugHunt', schedule: 'continuous' }] }, opts);
    expect(m.agents[0].schedule).toBe('continuous');
  });

  it('validates per-workflow input against the workflow schema', () => {
    // whiteboxBugHunt input rejects unknown keys
    expect(() => parseAgentsManifest({ agents: [{ name: 'b', workflow: 'whiteboxBugHunt', schedule: '0 2 * * *', input: { nope: 1 } }] }, opts)).toThrow(InvalidAgentsManifestError);
  });

  it('passes input through for an unknown (Tier-2) workflow', () => {
    const m = parseAgentsManifest({ agents: [{ name: 'r', workflow: 'rollbarMonitor', schedule: 'continuous', input: { anything: true } }] }, opts);
    expect(m.agents[0].input).toEqual({ anything: true });
  });

  it('rejects duplicate names', () => {
    expect(() => parseAgentsManifest({ agents: [
      { name: 'dup', workflow: 'whiteboxBugHunt', schedule: '0 2 * * *' },
      { name: 'dup', workflow: 'whiteboxBugHunt', schedule: '0 3 * * *' },
    ] }, opts)).toThrow(/duplicate/i);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @agentops/contracts test -- agents-manifest`
Expected: FAIL — module `./agents-manifest` not found.

- [ ] **Step 3: Implement the schema + parser**

```ts
// packages/contracts/src/agents-manifest.ts
import { z, ZodError } from 'zod';

// A 5-field cron, loosely validated (field count + allowed chars). The
// reconciler hands the exact string to Temporal, which does the strict parse;
// this catches obvious typos at PR time.
const CRON_FIELD = String.raw`[\d*/,\-A-Za-z?]+`;
const CRON_RE = new RegExp(`^${CRON_FIELD}(\\s+${CRON_FIELD}){4}$`);
const scheduleSchema = z.union([z.literal('continuous'), z.string().regex(CRON_RE, 'must be a 5-field cron or "continuous"')]);

export const AgentSpecSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'name must be kebab-case DNS-safe'),
    workflow: z.string().min(1),
    schedule: scheduleSchema,
    input: z.record(z.string(), z.unknown()).default({}),
    enabled: z.boolean().default(true),
    timezone: z.string().default('UTC'),
    overlap: z.enum(['skip', 'bufferOne', 'allow']).default('skip'),
  })
  .strict();
export type AgentSpec = z.infer<typeof AgentSpecSchema>;

export const AgentsManifestSchema = z.object({ agents: z.array(AgentSpecSchema) }).strict();
export type AgentsManifest = z.infer<typeof AgentsManifestSchema>;

// Manifest-facing input schemas for built-ins (the reconciler injects `repo`).
export const WhiteboxBugHuntManifestInputSchema = z.object({ focus: z.string().optional() }).strict();
export const BUILTIN_WORKFLOW_INPUTS: Record<string, z.ZodTypeAny> = {
  whiteboxBugHunt: WhiteboxBugHuntManifestInputSchema,
};

export class InvalidAgentsManifestError extends Error {
  constructor(message: string, public readonly issues?: unknown) {
    super(message);
  }
}

function fmt(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

export function parseAgentsManifest(
  raw: unknown,
  opts: { workflowInputs: Record<string, z.ZodTypeAny> },
): AgentsManifest {
  let manifest: AgentsManifest;
  try {
    manifest = AgentsManifestSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) throw new InvalidAgentsManifestError(fmt(err), err.issues);
    throw err;
  }
  const seen = new Set<string>();
  for (const agent of manifest.agents) {
    if (seen.has(agent.name)) throw new InvalidAgentsManifestError(`duplicate agent name "${agent.name}"`);
    seen.add(agent.name);
    const inputSchema = opts.workflowInputs[agent.workflow];
    if (inputSchema) {
      const res = inputSchema.safeParse(agent.input);
      if (!res.success) throw new InvalidAgentsManifestError(`agent "${agent.name}" input: ${fmt(res.error)}`);
    }
  }
  return manifest;
}
```

- [ ] **Step 4: Wire the export**

Add to `packages/contracts/src/index.ts`: `export * from './agents-manifest';`

- [ ] **Step 5: Run tests, verify pass**

Run: `pnpm --filter @agentops/contracts test -- agents-manifest`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/agents-manifest.ts packages/contracts/src/agents-manifest.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): strict agents.json manifest schema + parser"
```

---

### Task 2: Contracts — `bughunt` stage, routing, run-stats provenance, findings

**Files:**
- Modify: `packages/contracts/src/stage.ts` (add `'bughunt'` to `StageSchema`)
- Modify: `packages/contracts/src/model.ts` (add `bughunt` to `RoutingSchema`)
- Modify: `packages/contracts/src/run-stats.ts` (+ provenance/attribution fields)
- Modify: `packages/contracts/src/agent-run.ts` (`AgentRunResult` += `promptHash`/`promptSource`)
- Create: `packages/contracts/src/whitebox-finding.ts` + `.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Produces: `Stage` now includes `'bughunt'`; `RunStats` += `promptHash?`, `promptSource?`, `project?`, `workflowType?`; `AgentRunResult` += `promptHash: string`, `promptSource: string`; `WhiteboxFindingSchema`, `type WhiteboxFinding`.

- [ ] **Step 1: Write the failing test (findings + stage presence)**

```ts
// packages/contracts/src/whitebox-finding.test.ts
import { describe, it, expect } from 'vitest';
import { WhiteboxFindingSchema } from './whitebox-finding';
import { StageSchema } from './stage';

describe('WhiteboxFinding + bughunt stage', () => {
  it('parses a finding', () => {
    const f = WhiteboxFindingSchema.parse({ title: 'SQLi', detail: '...', severity: 'high', location: 'src/db.ts:42' });
    expect(f.severity).toBe('high');
  });
  it('bughunt is a valid stage', () => {
    expect(StageSchema.parse('bughunt')).toBe('bughunt');
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @agentops/contracts test -- whitebox-finding`
Expected: FAIL — `./whitebox-finding` missing and `StageSchema.parse('bughunt')` throws.

- [ ] **Step 3: Implement the changes**

In `packages/contracts/src/stage.ts`, add `'bughunt'` to the `StageSchema` enum list (after `'platform'`).

In `packages/contracts/src/model.ts`, add to `RoutingSchema`: `bughunt: ModelRefSchema.optional(),`.

In `packages/contracts/src/run-stats.ts`, extend `RunStatsSchema`:

```ts
export const RunStatsSchema = z.object({
  taskId: z.string().min(1),
  stage: StageSchema,
  backend: z.string().min(1),
  model: z.string().min(1),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  wallMs: z.number().int().nonnegative(),
  outcome: StageOutcomeSchema,
  // provenance + attribution (design §7) — optional so existing call sites compile
  promptHash: z.string().optional(),
  promptSource: z.string().optional(),
  project: z.string().optional(),
  workflowType: z.string().optional(),
});
```

In `packages/contracts/src/agent-run.ts`, extend `AgentRunResultSchema`:

```ts
export const AgentRunResultSchema = z.object({
  output: z.string(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  wallMs: z.number().int().nonnegative(),
  promptHash: z.string(),
  promptSource: z.string(),
});
```

Create `packages/contracts/src/whitebox-finding.ts`:

```ts
import { z } from 'zod';

export const WhiteboxFindingSchema = z.object({
  title: z.string().min(1),
  detail: z.string().min(1),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  location: z.string().min(1), // e.g. "src/db.ts:42"
});
export type WhiteboxFinding = z.infer<typeof WhiteboxFindingSchema>;
```

Add to `packages/contracts/src/index.ts`: `export * from './whitebox-finding';`.

- [ ] **Step 4: Fix the now-broken backend/stub result shape**

`AgentRunResult` gained two required fields. Update the stub and any in-repo constructors of `AgentRunResult`:
- `packages/backends/src/stub/stub-backend.ts` — `DEFAULT_RESPONSE`/`run` must return `promptHash` and `promptSource`. Set `promptHash: '', promptSource: 'stub'` in the returned object (the real values are computed by `runAgent`, Task 5 — the backend doesn't know them; but the type requires them). **Decision:** move `promptHash`/`promptSource` OUT of `AgentRunResult` (backend result) and have `runAgent` add them — see Task 5. So instead: define a separate `AgentRunResult` (backend) without them, and the activity returns an extended type. To keep this task self-contained, revert the `agent-run.ts` change here and instead add the two fields only to `RunStats`; `runAgent` will compute `promptHash`/`promptSource` and pass them straight into `recordRunStats` via the workflow (Task 5/6). **Do not** modify `AgentRunResultSchema`.

  (Net for Step 3: keep the `RunStatsSchema` and `whitebox-finding.ts` and `stage`/`model` edits; drop the `AgentRunResultSchema` edit.)

- [ ] **Step 5: Run tests, verify pass**

Run: `pnpm --filter @agentops/contracts test`
Expected: PASS (new tests + existing `stage`/`model`/`run-stats` tests still green).

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/stage.ts packages/contracts/src/model.ts packages/contracts/src/run-stats.ts packages/contracts/src/whitebox-finding.ts packages/contracts/src/whitebox-finding.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): bughunt stage, whitebox finding, run-stats provenance fields"
```

---

### Task 3: Policies — `reconcileAgents`, `parseFindings`, `findingFingerprint`

**Files:**
- Create: `packages/policies/src/reconcile-agents.ts` + `.test.ts`
- Create: `packages/policies/src/parse-findings.ts` + `.test.ts`
- Modify: `packages/policies/src/index.ts`

**Interfaces:**
- Consumes: `AgentSpec` (Task 1), `WhiteboxFinding` (Task 2), `sha256` (`packages/contracts/src/sha256.ts`).
- Produces: `reconcileAgents(declared: AgentSpec[], existing: ExistingSchedule[]): ReconcilePlan`; `type ExistingSchedule = { id: string; scheduleSpec: string; workflow: string; paused: boolean }`; `type ReconcilePlan = { toCreate: AgentSpec[]; toUpdate: AgentSpec[]; toDelete: string[]; toPause: string[]; toResume: string[] }`; `scheduleId(project: string, name: string): string`; `parseFindings(output: string): WhiteboxFinding[]`; `findingFingerprint(f: WhiteboxFinding): string`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/policies/src/reconcile-agents.test.ts
import { describe, it, expect } from 'vitest';
import { reconcileAgents, scheduleId } from './reconcile-agents';
import type { AgentSpec } from '@agentops/contracts';

const spec = (over: Partial<AgentSpec>): AgentSpec => ({
  name: 'a', workflow: 'whiteboxBugHunt', schedule: '0 2 * * *', input: {}, enabled: true, timezone: 'UTC', overlap: 'skip', ...over,
});

describe('reconcileAgents', () => {
  it('creates when nothing exists', () => {
    const plan = reconcileAgents([spec({ name: 'a' })], []);
    expect(plan.toCreate.map((s) => s.name)).toEqual(['a']);
  });
  it('deletes orphans not in the manifest', () => {
    const plan = reconcileAgents([], [{ id: scheduleId('p', 'gone'), scheduleSpec: '0 2 * * *', workflow: 'whiteboxBugHunt', paused: false }]);
    expect(plan.toDelete).toEqual([scheduleId('p', 'gone')]);
  });
  it('updates when the cron changed', () => {
    const existing = [{ id: scheduleId('p', 'a'), scheduleSpec: '0 2 * * *', workflow: 'whiteboxBugHunt', paused: false }];
    const plan = reconcileAgents([spec({ name: 'a', schedule: '0 5 * * *' })], existing, 'p');
    expect(plan.toUpdate.map((s) => s.name)).toEqual(['a']);
  });
  it('pauses a disabled agent and resumes a re-enabled one', () => {
    const idA = scheduleId('p', 'a');
    expect(reconcileAgents([spec({ name: 'a', enabled: false })], [{ id: idA, scheduleSpec: '0 2 * * *', workflow: 'whiteboxBugHunt', paused: false }], 'p').toPause).toEqual([idA]);
    expect(reconcileAgents([spec({ name: 'a', enabled: true })], [{ id: idA, scheduleSpec: '0 2 * * *', workflow: 'whiteboxBugHunt', paused: true }], 'p').toResume).toEqual([idA]);
  });
});
```

```ts
// packages/policies/src/parse-findings.test.ts
import { describe, it, expect } from 'vitest';
import { parseFindings, findingFingerprint } from './parse-findings';

describe('parseFindings', () => {
  it('parses a FINDINGS: json array', () => {
    const out = 'blah\nFINDINGS: [{"title":"X","detail":"d","severity":"high","location":"src/a.ts:1"}]\n';
    expect(parseFindings(out)).toHaveLength(1);
  });
  it('returns [] on unparseable / missing / bad json (never throws)', () => {
    expect(parseFindings('nothing here')).toEqual([]);
    expect(parseFindings('FINDINGS: not json')).toEqual([]);
    expect(parseFindings('FINDINGS: [{"title":"x"}]')).toEqual([]); // fails schema -> dropped
  });
  it('fingerprint is stable and location-derived', () => {
    const f = { title: 'X', detail: 'd', severity: 'high' as const, location: 'src/a.ts:1' };
    expect(findingFingerprint(f)).toBe(findingFingerprint({ ...f, detail: 'different' }));
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @agentops/policies test -- reconcile-agents parse-findings`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

```ts
// packages/policies/src/reconcile-agents.ts
import type { AgentSpec } from '@agentops/contracts';

export interface ExistingSchedule { id: string; scheduleSpec: string; workflow: string; paused: boolean }
export interface ReconcilePlan { toCreate: AgentSpec[]; toUpdate: AgentSpec[]; toDelete: string[]; toPause: string[]; toResume: string[] }

export function scheduleId(project: string, name: string): string {
  return `agent:${project}:${name}`;
}

// `continuous` agents are singleton workflows, not Schedules — the reconciler
// handles them separately, so they are excluded here.
export function reconcileAgents(declared: AgentSpec[], existing: ExistingSchedule[], project = 'p'): ReconcilePlan {
  const scheduled = declared.filter((a) => a.schedule !== 'continuous');
  const byId = new Map(existing.map((e) => [e.id, e]));
  const plan: ReconcilePlan = { toCreate: [], toUpdate: [], toDelete: [], toPause: [], toResume: [] };
  const declaredIds = new Set<string>();

  for (const spec of scheduled) {
    const id = scheduleId(project, spec.name);
    declaredIds.add(id);
    const cur = byId.get(id);
    if (!cur) { plan.toCreate.push(spec); continue; }
    if (cur.scheduleSpec !== spec.schedule || cur.workflow !== spec.workflow) plan.toUpdate.push(spec);
    if (spec.enabled && cur.paused) plan.toResume.push(id);
    if (!spec.enabled && !cur.paused) plan.toPause.push(id);
  }
  for (const e of existing) if (!declaredIds.has(e.id)) plan.toDelete.push(e.id);
  return plan;
}
```

```ts
// packages/policies/src/parse-findings.ts
import { WhiteboxFindingSchema, sha256, type WhiteboxFinding } from '@agentops/contracts';

// Fail-safe like parse-platform-result: last `FINDINGS:` line wins, JSON parsed,
// each element validated; anything unparseable yields [] (never throws, never
// a silent bad file). Per-call RegExp (g-flag is stateful).
export function parseFindings(output: string): WhiteboxFinding[] {
  const re = /^FINDINGS:\s*(.+)$/gm;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(output); m !== null; m = re.exec(output)) last = m;
  if (!last) return [];
  let json: unknown;
  try { json = JSON.parse(last[1]); } catch { return []; }
  if (!Array.isArray(json)) return [];
  const out: WhiteboxFinding[] = [];
  for (const item of json) {
    const res = WhiteboxFindingSchema.safeParse(item);
    if (res.success) out.push(res.data);
  }
  return out;
}

export function findingFingerprint(f: WhiteboxFinding): string {
  return sha256(`${f.location}::${f.title}`.toLowerCase().replace(/\s+/g, ' ').trim());
}
```

Confirm `packages/contracts/src/sha256.ts` exports `sha256(input: string): string`; if the export name differs, adapt the import. Add both modules to `packages/policies/src/index.ts`.

- [ ] **Step 4: Run tests + coverage, verify pass at 100%**

Run: `pnpm --filter @agentops/policies test -- reconcile-agents parse-findings`
Then: `pnpm test:policies-coverage`
Expected: PASS; coverage stays 100% (add cases for any uncovered branch the coverage run flags — e.g. `toUpdate` on workflow-name change, empty output).

- [ ] **Step 5: Commit**

```bash
git add packages/policies/src/reconcile-agents.ts packages/policies/src/reconcile-agents.test.ts packages/policies/src/parse-findings.ts packages/policies/src/parse-findings.test.ts packages/policies/src/index.ts
git commit -m "feat(policies): reconcileAgents diff + fail-safe parseFindings/fingerprint"
```

---

### Task 4: Ports — `TrackerPort.createIssue` + adapters

**Files:**
- Modify: `packages/ports/src/tracker-port.ts`
- Modify: `packages/ports/src/memory/memory-tracker.ts` (+ `.test.ts`)
- Modify: `packages/ports/src/github/github-tracker-port.ts` (+ `.test.ts`)

**Interfaces:**
- Produces: `interface CreateIssueRequest { repo: string; title: string; body: string; labels: string[] }`, `interface CreatedIssue { ref: string; url: string }`, `TrackerPort.createIssue(req: CreateIssueRequest): Promise<CreatedIssue>`.

- [ ] **Step 1: Write the failing tests**

```ts
// add to packages/ports/src/memory/memory-tracker.test.ts
it('createIssue stores the issue and returns a ref retrievable via getIssue', async () => {
  const t = new MemoryTrackerPort();
  const created = await t.createIssue({ repo: 'o/r', title: 'Bug', body: 'b', labels: ['bug'] });
  expect(created.ref).toMatch(/^o\/r#\d+$/);
  const issue = await t.getIssue(created.ref);
  expect(issue).toMatchObject({ title: 'Bug', labels: ['bug'] });
});
```

```ts
// add to packages/ports/src/github/github-tracker-port.test.ts (mirror existing mock-client style)
it('createIssue calls issues.create and returns owner/repo#number + html_url', async () => {
  const create = vi.fn().mockResolvedValue({ data: { number: 7, html_url: 'https://x/7' } });
  const client = { rest: { issues: { create } } } as unknown as GithubClient;
  const port = new GithubTrackerPort(client);
  const res = await port.createIssue({ repo: 'o/r', title: 'T', body: 'B', labels: ['bug'] });
  expect(create).toHaveBeenCalledWith({ owner: 'o', repo: 'r', title: 'T', body: 'B', labels: ['bug'] });
  expect(res).toEqual({ ref: 'o/r#7', url: 'https://x/7' });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @agentops/ports test -- tracker`
Expected: FAIL — `createIssue` not defined.

- [ ] **Step 3: Implement**

`packages/ports/src/tracker-port.ts`:

```ts
export interface CreateIssueRequest { repo: string; title: string; body: string; labels: string[] }
export interface CreatedIssue { ref: string; url: string }

export interface TrackerPort {
  getIssue(ref: string): Promise<Issue>;
  comment(ref: string, body: string): Promise<void>;
  label(ref: string, label: string): Promise<void>;
  createIssue(req: CreateIssueRequest): Promise<CreatedIssue>;
}
```

`MemoryTrackerPort.createIssue` (auto-incrementing number keyed by repo):

```ts
private seq = 0;
async createIssue(req: CreateIssueRequest): Promise<CreatedIssue> {
  this.seq += 1;
  const ref = `${req.repo}#${this.seq}`;
  this.issues.set(ref, { ref, title: req.title, body: req.body, labels: [...req.labels] });
  return { ref, url: `memory://${ref}` };
}
```

`GithubTrackerPort.createIssue` (mirror `comment`/`label`, parse `owner/repo` — reuse the repo splitter used by `github-scm-port`/`parse-ref`; if only `parseRef` exists for `owner/repo#n`, split on `/` directly):

```ts
async createIssue(req: CreateIssueRequest): Promise<CreatedIssue> {
  const [owner, repo] = req.repo.split('/');
  const { data } = await this.client.rest.issues.create({ owner, repo, title: req.title, body: req.body, labels: req.labels });
  return { ref: `${req.repo}#${data.number}`, url: data.html_url };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @agentops/ports test -- tracker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ports/src/tracker-port.ts packages/ports/src/memory/memory-tracker.ts packages/ports/src/memory/memory-tracker.test.ts packages/ports/src/github/github-tracker-port.ts packages/ports/src/github/github-tracker-port.test.ts
git commit -m "feat(ports): TrackerPort.createIssue + memory/github adapters"
```

---

### Task 5: Activities — `filed_findings` dedup store + `createIssue` activity + `runAgent` provenance

**Files:**
- Create: `packages/activities/src/filed-finding-store.ts` + `.test.ts` (InMemory)
- Create: `packages/activities/src/postgres-filed-finding-store.ts` + `.test.ts` (mirror `postgres-managed-project-store.ts`)
- Modify: `packages/activities/src/create-activities.ts` (add `filedFindings` dep; `createIssue` activity; `runAgent` provenance)
- Modify: `packages/activities/src/create-activities.test.ts`

**Interfaces:**
- Consumes: `TrackerPort.createIssue` (Task 4), `sha256` (contracts).
- Produces: `interface FiledFindingStore { find(project: string, fingerprint: string): Promise<FiledFinding | null>; record(f: FiledFinding): Promise<void> }`; `interface FiledFinding { project: string; fingerprint: string; issueRef: string }`; a `createIssue` activity `(req: { repo: string; project: string; title: string; body: string; labels: string[]; dedupeFingerprint?: string }) => Promise<{ ref: string; url: string; deduped: boolean }>`; `runAgent` now returns `AgentRunResult & { promptHash: string; promptSource: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/activities/src/create-activities.test.ts (add)
it('createIssue dedups by fingerprint within a project', async () => {
  const tracker = new MemoryTrackerPort();
  const filedFindings = new InMemoryFiledFindingStore();
  const acts = createActivities({ ...baseDeps, tracker, filedFindings });
  const a = await acts.createIssue({ repo: 'o/r', project: 'p', title: 'T', body: 'B', labels: ['bug'], dedupeFingerprint: 'fp1' });
  const b = await acts.createIssue({ repo: 'o/r', project: 'p', title: 'T2', body: 'B2', labels: ['bug'], dedupeFingerprint: 'fp1' });
  expect(a.deduped).toBe(false);
  expect(b).toEqual({ ref: a.ref, url: a.url, deduped: true });
});

it('runAgent returns a stable promptHash and a promptSource', async () => {
  const acts = createActivities(baseDeps);
  const r = await acts.runAgent({ /* minimal valid AgentRunRequest, stage: 'bughunt' */ } as AgentRunRequest);
  expect(r.promptHash).toMatch(/^[0-9a-f]{64}$/);
  expect(r.promptSource).toContain('bughunt'); // e.g. "builtin:bughunt.md"
});
```

(`baseDeps` = the deps object the existing test already builds; add `filedFindings: new InMemoryFiledFindingStore()` to `ActivityDependencies` construction everywhere it's built.)

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @agentops/activities test -- create-activities`
Expected: FAIL — `filedFindings`/`createIssue` missing, `promptHash` undefined.

- [ ] **Step 3: Implement the store**

```ts
// packages/activities/src/filed-finding-store.ts
export interface FiledFinding { project: string; fingerprint: string; issueRef: string }
export interface FiledFindingStore {
  find(project: string, fingerprint: string): Promise<FiledFinding | null>;
  record(f: FiledFinding): Promise<void>;
}
export class InMemoryFiledFindingStore implements FiledFindingStore {
  private readonly byKey = new Map<string, FiledFinding>();
  private key(p: string, fp: string) { return `${p}:${fp}`; }
  async find(project: string, fingerprint: string) { return this.byKey.get(this.key(project, fingerprint)) ?? null; }
  async record(f: FiledFinding) { this.byKey.set(this.key(f.project, f.fingerprint), f); }
}
```

`postgres-filed-finding-store.ts`: mirror `postgres-managed-project-store.ts` (same pool pattern, `ensureSchema`). Table:

```sql
CREATE TABLE IF NOT EXISTS filed_findings (
  project TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  issue_ref TEXT NOT NULL,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project, fingerprint)
);
```
`find` → `SELECT ... WHERE project=$1 AND fingerprint=$2`; `record` → `INSERT ... ON CONFLICT (project, fingerprint) DO UPDATE SET last_seen = now()`.

- [ ] **Step 4: Implement the activity + provenance**

In `create-activities.ts`, add `filedFindings: FiledFindingStore` to `ActivityDependencies`. Add the activity:

```ts
async createIssue(req: { repo: string; project: string; title: string; body: string; labels: string[]; dedupeFingerprint?: string }): Promise<{ ref: string; url: string; deduped: boolean }> {
  if (req.dedupeFingerprint) {
    const existing = await deps.filedFindings.find(req.project, req.dedupeFingerprint);
    if (existing) {
      await deps.filedFindings.record({ project: req.project, fingerprint: req.dedupeFingerprint, issueRef: existing.issueRef });
      return { ref: existing.issueRef, url: '', deduped: true };
    }
  }
  const created = await deps.tracker.createIssue({ repo: req.repo, title: req.title, body: req.body, labels: req.labels });
  if (req.dedupeFingerprint) {
    await deps.filedFindings.record({ project: req.project, fingerprint: req.dedupeFingerprint, issueRef: created.ref });
  }
  return { ref: created.ref, url: created.url, deduped: false };
}
```

In `runAgent`, compute provenance from the already-rendered prompt (`const prompt = deps.prompts.render(...)`), before the try:

```ts
const promptHash = sha256(prompt);                 // import { sha256 } from '@agentops/contracts'
const promptSource = `builtin:${req.promptRef}`;   // project-prompt source (repo@sha) is SP2
```
Add `'agentops.prompt.hash': promptHash, 'agentops.prompt.source': promptSource` to the `setAttributes` call, and change the return to `return { ...result, promptHash, promptSource };`. Widen `runAgent`'s return type to `Promise<AgentRunResult & { promptHash: string; promptSource: string }>`.

- [ ] **Step 5: Thread `filedFindings` through the wiring**

Add `filedFindings` to every `createActivities({...})` construction: `packages/worker/src/main.ts` (a `buildFiledFindingStore()` mirroring `buildManagedProjectStore()`, `InMemory` fallback when no DB) and `e2e/helpers.ts` (`new InMemoryFiledFindingStore()`).

- [ ] **Step 6: Run tests, verify pass**

Run: `pnpm --filter @agentops/activities test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/activities/src/filed-finding-store.ts packages/activities/src/postgres-filed-finding-store.ts packages/activities/src/*.test.ts packages/activities/src/create-activities.ts packages/worker/src/main.ts e2e/helpers.ts
git commit -m "feat(activities): createIssue with filed_findings dedup + runAgent prompt provenance"
```

---

### Task 6: Workflow — `whiteboxBugHunt` (+ prompt template) + gate e2e

**Files:**
- Create: `packages/workflows/src/whitebox-bughunt.ts`
- Modify: `packages/workflows/src/index.ts` (`export * from './whitebox-bughunt';`)
- Modify: `packages/workflows/src/activities-api.ts` (add `createIssue` to the activities interface the workflow proxies)
- Create: `packages/prompts/templates/whitebox-bughunt.md`
- Create: `e2e/whitebox-bughunt.e2e.test.ts`

**Interfaces:**
- Consumes: `runAgent` (stage `bughunt`, returns `promptHash`/`promptSource`), `createIssue` activity (Task 5), `resolveRepoConfig`, `recordRunStats`, `prepareWorkspace`/`cleanupWorkspace`, `parseFindings`/`findingFingerprint` (Task 3).
- Produces: `whiteboxBugHunt(input: { repo: string; focus?: string }): Promise<{ filed: number; deduped: number }>`.

- [ ] **Step 1: Add `createIssue` to the workflow's activity interface**

In `packages/workflows/src/activities-api.ts`, add to `DevCycleActivities` (or a new `FinderActivities` the workflow proxies):

```ts
createIssue(req: { repo: string; project: string; title: string; body: string; labels: string[]; dedupeFingerprint?: string }): Promise<{ ref: string; url: string; deduped: boolean }>;
```

- [ ] **Step 2: Write the failing e2e (the SP1 gate)**

```ts
// e2e/whitebox-bughunt.e2e.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { whiteboxBugHunt } from '@agentops/workflows';
import { buildTestEnv, teardownTestEnv, type TestEnv } from './helpers';

const FINDINGS = 'FINDINGS: [{"title":"SQLi in login","detail":"...","severity":"high","location":"src/auth.ts:42"}]';

describe('whiteboxBugHunt (SP1 gate)', () => {
  let t: TestEnv;
  beforeEach(async () => {
    t = await buildTestEnv({ registry: [{ project: 'acme', repo: 'acme/webapp' /* + whatever ResolvedProjectEntry needs */ } as never] });
  });
  afterEach(async () => teardownTestEnv(t));

  it('files a deduped bug issue; a second identical run files no duplicate', async () => {
    t.stub.scriptResponse('bughunt', 1, { output: FINDINGS });

    const first = await t.worker.runUntil(async () => {
      const h = await t.env.client.workflow.start(whiteboxBugHunt, { taskQueue: t.taskQueue, workflowId: 'wbh-1', args: [{ repo: 'acme/webapp' }] });
      return h.result();
    });
    expect(first).toEqual({ filed: 1, deduped: 0 });
    const issues = t.tracker.listCreated?.() ?? [];   // add a listCreated() test helper to MemoryTrackerPort if absent
    expect(issues).toHaveLength(1);
    expect(issues[0].labels).toContain('bug');

    const second = await t.worker.runUntil(async () => {
      const h = await t.env.client.workflow.start(whiteboxBugHunt, { taskQueue: t.taskQueue, workflowId: 'wbh-2', args: [{ repo: 'acme/webapp' }] });
      return h.result();
    });
    expect(second).toEqual({ filed: 0, deduped: 1 });   // same fingerprint -> no new issue
  });
});
```

(If `MemoryTrackerPort` has no `listCreated()`, add one returning the created issues, mirroring `getLabels()`.)

- [ ] **Step 3: Run, verify fail**

Run: `pnpm e2e -- whitebox-bughunt`
Expected: FAIL — `whiteboxBugHunt` not exported.

- [ ] **Step 4: Implement the workflow**

```ts
// packages/workflows/src/whitebox-bughunt.ts
import { proxyActivities, workflowInfo } from '@temporalio/workflow';
import type { ModelRef } from '@agentops/contracts';
import { findingFingerprint, parseFindings } from '@agentops/policies';
import type { DevCycleActivities } from './activities-api';

const activities = proxyActivities<DevCycleActivities>({ startToCloseTimeout: '10 minutes', retry: { maximumAttempts: 5 } });
const agentActivities = proxyActivities<Pick<DevCycleActivities, 'runAgent'>>({ startToCloseTimeout: '45 minutes', heartbeatTimeout: '15s', retry: { maximumAttempts: 5 } });

const FALLBACK_MODEL: ModelRef = { backend: 'claude', model: 'claude-sonnet-5', effort: 'high' };

export async function whiteboxBugHunt(input: { repo: string; focus?: string }): Promise<{ filed: number; deduped: number }> {
  const taskId = workflowInfo().workflowId;
  const workflowType = workflowInfo().workflowType;
  const { project, config } = await activities.resolveRepoConfig(input.repo);
  const ws = await activities.prepareWorkspace({ taskId, repo: input.repo });
  let filed = 0, deduped = 0;
  try {
    const model = config.routing.bughunt ?? FALLBACK_MODEL;
    const result = await agentActivities.runAgent({
      taskId, stage: 'bughunt', attempt: 1, callIndex: 1,
      backend: model.backend, model: model.model, effort: model.effort,
      promptRef: 'whitebox-bughunt.md',
      promptContext: { focus: input.focus ?? 'security & correctness across the whole codebase' },
      workspaceRef: ws.workspaceRef,
      limits: { maxTokens: config.brakes.maxTokens, timeoutMs: 1_800_000 },
    });
    await activities.recordRunStats({
      taskId, stage: 'bughunt', backend: model.backend, model: model.model,
      tokensIn: result.tokensIn, tokensOut: result.tokensOut, wallMs: result.wallMs, outcome: 'pass',
      promptHash: result.promptHash, promptSource: result.promptSource, project, workflowType,
    });
    for (const f of parseFindings(result.output)) {
      const res = await activities.createIssue({
        repo: input.repo, project, title: `[bughunt] ${f.title}`,
        body: `${f.detail}\n\n**Severity:** ${f.severity}\n**Location:** ${f.location}`,
        labels: ['bug', 'whitebox'], dedupeFingerprint: findingFingerprint(f),
      });
      if (res.deduped) deduped += 1; else filed += 1;
    }
  } finally {
    await activities.cleanupWorkspace(ws.workspaceRef, input.repo);
  }
  return { filed, deduped };
}
```

Create `packages/prompts/templates/whitebox-bughunt.md` — a read-only bug-hunting prompt that instructs the agent to emit findings as a single `FINDINGS: <json array>` line matching `WhiteboxFindingSchema` (`title`, `detail`, `severity` ∈ low|medium|high|critical, `location`), with `{{focus}}` interpolated.

- [ ] **Step 5: Run e2e + full suite, verify pass**

Run: `pnpm e2e -- whitebox-bughunt` then `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/workflows/src/whitebox-bughunt.ts packages/workflows/src/index.ts packages/workflows/src/activities-api.ts packages/prompts/templates/whitebox-bughunt.md e2e/whitebox-bughunt.e2e.test.ts packages/ports/src/memory/memory-tracker.ts
git commit -m "feat(workflows): whiteboxBugHunt built-in files deduped bug issues (SP1 gate)"
```

---

### Task 7: Reconciler — `ConfigSync` workflow + Schedule activities

**Files:**
- Create: `packages/workflows/src/config-sync.ts` + export
- Modify: `packages/workflows/src/activities-api.ts` (add reconciler activities)
- Modify: `packages/activities/src/create-activities.ts` (implement `loadAgentsManifest`, `listAgentSchedules`, `applyScheduleChanges`)
- Create: `packages/activities/src/schedule-ops.ts` + `.test.ts` (the `ScheduleClient` wrapper, unit-tested with a mock)

**Interfaces:**
- Consumes: `parseAgentsManifest` + `BUILTIN_WORKFLOW_INPUTS` (Task 1), `reconcileAgents`/`scheduleId` (Task 3), `ScmPort.readFile` (as `load-project-config` uses).
- Produces: `configSync(input: { project: string; repo: string }): Promise<ReconcilePlan>`; activities `loadAgentsManifest`, `listAgentSchedules`, `applyScheduleChanges`.

- [ ] **Step 1: Write the failing tests (activities with a mocked ScheduleClient + manifest load)**

```ts
// packages/activities/src/schedule-ops.test.ts — assert applyScheduleChanges calls create/update/delete/pause
// with agent:<project>:<name> ids and the right cron/action, using a vi.fn()-mocked ScheduleClient
// (mirror control's create-control-server.test.ts client mocking).
```
```ts
// loadAgentsManifest test: a MemoryScmPort seeded with agents.json -> returns parsed AgentSpec[];
// malformed agents.json -> throws (so the ConfigSync workflow's whole reconcile fails; fail-safe).
```

- [ ] **Step 2: Run, verify fail.** `pnpm --filter @agentops/activities test -- schedule-ops` → FAIL.

- [ ] **Step 3: Implement the activities**

- `loadAgentsManifest(project, repo)`: read `agents.json` via `deps.scm` (mirror `loadProjectConfig`); `parseAgentsManifest(raw, { workflowInputs: BUILTIN_WORKFLOW_INPUTS })`; return `agents`. A read-miss = empty manifest `{ agents: [] }`; a parse error throws (fail-safe: reconcile aborts, Schedules untouched).
- `listAgentSchedules(project)`: `scheduleClient.list()` filtered to IDs starting `agent:${project}:`, mapped to `ExistingSchedule`.
- `applyScheduleChanges(project, plan)`: for `toCreate`/`toUpdate` call `scheduleClient.create`/`handle.update` with `scheduleId(project, spec.name)`, `spec.schedule` (cron), timezone, `overlap` policy, `catchupWindow: '1h'`, action = start `spec.workflow` on `ENGINE_QUEUE` with args `[{ repo, ...spec.input }]` + memo `{ project, agentName: spec.name }`; `toPause`/`toResume` → `handle.pause()`/`handle.unpause()`; `toDelete` → `handle.delete()`. Get the `ScheduleClient` from a new dep (`deps.scheduleClient`) built in `worker/src/main.ts` from the Temporal `Client`.

- [ ] **Step 4: Implement the `configSync` workflow**

```ts
// packages/workflows/src/config-sync.ts
import { proxyActivities } from '@temporalio/workflow';
import { reconcileAgents, scheduleId, type ReconcilePlan } from '@agentops/policies';
import type { ConfigSyncActivities } from './activities-api';

const acts = proxyActivities<ConfigSyncActivities>({ startToCloseTimeout: '2 minutes', retry: { maximumAttempts: 5 } });

export async function configSync(input: { project: string; repo: string }): Promise<ReconcilePlan> {
  const declared = await acts.loadAgentsManifest(input.project, input.repo);       // throws -> reconcile fails, nothing applied
  const existing = await acts.listAgentSchedules(input.project);
  const plan = reconcileAgents(declared, existing, input.project);
  await acts.applyScheduleChanges(input.project, plan);
  return plan;
}
```

Note in the file: `"continuous"` agents (singleton workflows) are out of SP1 scope — the reconciler handles only Schedules here (SP2 adds the singleton-start path).

- [ ] **Step 5: Run tests, verify pass.** `pnpm --filter @agentops/activities test && pnpm lint && pnpm typecheck` → PASS. (No stub e2e for Schedule firing — time-skipping Schedule support is uncertain; coverage is: pure `reconcileAgents` (Task 3) + mocked `applyScheduleChanges` here + the `configSync` orchestration.)

- [ ] **Step 6: Commit**

```bash
git add packages/workflows/src/config-sync.ts packages/workflows/src/index.ts packages/workflows/src/activities-api.ts packages/activities/src/create-activities.ts packages/activities/src/schedule-ops.ts packages/activities/src/schedule-ops.test.ts packages/worker/src/main.ts
git commit -m "feat(workflows): ConfigSync reconciler turns agents.json into Temporal Schedules"
```

---

### Task 8: Docs — `agents.json` reference + close-out

**Files:**
- Create: `docs/agents-json.md` (project-facing reference)
- Modify: `docs/superpowers/specs/2026-07-12-custom-agent-workflows-design.md` (tick SP1 done-when items that are complete)

- [ ] **Step 1:** Write `docs/agents-json.md`: the manifest fields (from Task 1's schema, verbatim), the built-in catalog and each built-in's manifest input, the `agent:<project>:<name>` Schedule-ID convention, `enabled:false`=pause, `overlap` default, and that removing an entry deletes its Schedule. Note the Tier-2 SDK / per-project worker authoring path lives in SP2 (`@agentops/engine-sdk`) — the "author a project workflow" skill lands there.
- [ ] **Step 2:** In the design spec §11, check off the delivered items.
- [ ] **Step 3: Full green + commit**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e`
Expected: all PASS.

```bash
git add docs/agents-json.md docs/superpowers/specs/2026-07-12-custom-agent-workflows-design.md
git commit -m "docs: agents.json reference; mark SP1 done-when items complete"
```

---

## Self-Review

**Spec coverage (design §11 done-when):**
- `AgentsManifestSchema` + tests (strict/cron/continuous/per-workflow-input/name) → Task 1. ✓
- `createIssue` + fingerprint dedup vs `filed_findings` → Tasks 4–5. ✓
- `StageSchema += bughunt`; `runAgent` stamps `promptHash`/`promptSource`/`project`/`workflowType` on stats + span → Tasks 2, 5, 6. ✓
- `whiteboxBugHunt` exported, routed by config, files deduped `bug` issues → Task 6. ✓
- `ConfigSync` reconciler (read/validate/diff/apply, fail-safe) → Tasks 3, 7. ✓
- e2e reconcile→run→file→no-duplicate → Task 6 covers run→file→no-duplicate; reconcile→Schedule covered by Task 7 unit tests (stub e2e for Schedule firing intentionally omitted — see Task 7 note). ✓ (deviation documented)
- lint/typecheck/test/e2e green → every task. ✓

**Placeholder scan:** Task 6's e2e references `ResolvedProjectEntry` fields as `as never` — the implementer fills the real shape from `packages/contracts/src/resolved-project-entry.ts` (and `buildTestEnv`'s `registry` option). Flagged, not hidden.

**Type consistency:** `AgentSpec`/`ReconcilePlan`/`ExistingSchedule` names match across Tasks 1/3/7; `createIssue` activity signature matches between Task 5 (impl), Task 6 (`activities-api.ts` interface), and the workflow call; `runAgent` return widening (Task 5) is consumed in Task 6's `recordRunStats` call.

**Scope:** SP1 only — no SDK/per-project worker (SP2), no `qaProbe`/triggers (SP3), no Mission Control (SP4). `"continuous"` agents explicitly deferred in Task 7.

## Open decisions carried into implementation
- **Custom Temporal search attributes** (`agentName`, `workflowType`, `project`) require registration (`temporal operator search-attribute create`) — an operational step, not in the stub e2e; the workflow stamps them best-effort. Confirm during Task 7 whether to add `upsertSearchAttributes` calls now or defer to the deploy runbook.
- **`ScheduleClient` in tests** — `applyScheduleChanges` is unit-tested with a mock; a live reconcile→fire test is an integration check against a real Temporal (out of the stub e2e).
