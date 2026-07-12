# Custom Agent Workflows — SP2 (Tier-2: SDK + per-project worker + authorization) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Tier 2 of the custom-agent-workflows design — a public `@agentops/engine-sdk` and a per-project worker convention that lets a project author its own Temporal workflow, delegate all privileged work back to the engine, and be provably unable to act on another project's repo.

**Architecture:** Two phases. **Phase A** (engine-side, all mergeable in-repo): a shared `ENGINE_QUEUE` constant, a semver'd `EngineActivities` contract, project-identity binding (reconciler stamps `project` in memo + search-attributes → a workflow interceptor propagates it as a Temporal header → the engine validates `repo ∈ project` before touching a scoped token), continuous-agent reconciliation, and project-prompt provenance. **Phase B** (packaging): the `@agentops/engine-sdk` package (tsup dual-entry), an in-repo reference project worker + cross-worker e2e, the npm publish, and the authoring guide/skill.

**Tech Stack:** Node 22, pnpm workspaces, TypeScript strict, Temporal TS SDK (`@temporalio/*`), zod (`packages/contracts`), tsup, vitest + `@temporalio/testing`.

**Design authority:** `docs/superpowers/specs/2026-07-12-custom-agent-workflows-sp2-design.md` (SP2). Master model: `docs/superpowers/specs/2026-07-12-custom-agent-workflows-design.md`.

## Global Constraints

- **Determinism boundary:** `packages/workflows` (and the SDK's `/workflow` entry) do no I/O, no `Date.now()`/`Math.random()`/timers, no imports from `activities`/`ports`/`backends`. Interceptors in the workflow sandbox use only `@temporalio/workflow` + `@temporalio/common`.
- **`packages/policies` stays pure** (no Temporal, no I/O, no `ports`/`activities` imports); held to 100% coverage (`pnpm test:policies-coverage`).
- **Contracts first:** every new cross-package shape is a zod schema (or a types-only interface for activity surfaces) in `packages/contracts`, re-exported from its `index.ts`. No `any`.
- **Ports, not vendors; no secrets** in code or fixtures; tests use the `stub` backend and `memory` ports.
- **Adding a `Stage` value is a deliberate contract change** — this plan adds `agent` (sanctioned by design §7 / SP2 §10).
- **Every task ends green:** `pnpm lint && pnpm typecheck && pnpm test`; `pnpm e2e` for tasks touching workflows/policies/activities/backends.
- **Conventional commits.** Unit tests live next to source as `*.test.ts`; e2e in root `e2e/*.e2e.test.ts`.

---

# Phase A — engine-side

### Task 1: `ENGINE_QUEUE` constant + queue rename cutover

Renames the shared engine task queue `agentops-devcycle` → `agentops-engine` behind a constant, before it is frozen into the public SDK. The engine polls both queues during the transition; the reconciler re-points legacy Schedules.

**Files:**
- Create: `packages/contracts/src/engine-queue.ts` + `packages/contracts/src/engine-queue.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/worker/src/main.ts` (queue literals at ~429/440; add legacy worker)
- Modify: `packages/activities/src/create-activities.ts` (`applyScheduleChanges` default `tq` at ~266)

- [ ] **Step 1: Write the failing test**

```ts
// packages/contracts/src/engine-queue.test.ts
import { describe, it, expect } from 'vitest';
import { ENGINE_QUEUE, LEGACY_ENGINE_QUEUE } from './engine-queue';

describe('ENGINE_QUEUE', () => {
  it('is the canonical engine queue name', () => {
    expect(ENGINE_QUEUE).toBe('agentops-engine');
  });
  it('exposes the legacy name for the one-time cutover', () => {
    expect(LEGACY_ENGINE_QUEUE).toBe('agentops-devcycle');
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @agentops/contracts test -- engine-queue`
Expected: FAIL — module `./engine-queue` not found.

- [ ] **Step 3: Implement**

```ts
// packages/contracts/src/engine-queue.ts

// The single Temporal task queue the engine fleet polls: all built-in
// workflows (devCycle, platform, whiteboxBugHunt, configSync) and every
// engine activity. Tier-2 project workflows target it via the SDK's
// engineActivities()/childDevCycle() so privileged work runs on the engine's
// credential-holding workers. This VALUE is part of the published SDK's
// semver compatibility contract — do not change it without a major bump.
export const ENGINE_QUEUE = 'agentops-engine';

// The pre-SP2 queue name. The engine polls it too during the cutover so any
// Schedule still pointing here is served until the reconciler re-points it
// (see reconcile-agents ExistingSchedule.taskQueue). Remove in a follow-up.
export const LEGACY_ENGINE_QUEUE = 'agentops-devcycle';
```

Add to `packages/contracts/src/index.ts`: `export * from './engine-queue';`

- [ ] **Step 4: Run test, verify pass**

Run: `pnpm --filter @agentops/contracts test -- engine-queue`
Expected: PASS.

- [ ] **Step 5: Wire the worker to poll both queues**

In `packages/worker/src/main.ts`: import `{ ENGINE_QUEUE, LEGACY_ENGINE_QUEUE }` from `@agentops/contracts`. Replace the two `taskQueue: 'agentops-devcycle'` literals (the `createActivities({ ..., taskQueue })` call and the `createWorker({ taskQueue })` call) with `ENGINE_QUEUE`. After the primary worker is created, create a second worker on the legacy queue with the same activities/workflows, and run both:

```ts
const worker = await createWorker({ taskQueue: ENGINE_QUEUE, activities, connection, namespace: process.env.TEMPORAL_NAMESPACE, tracing });
const legacyWorker = await createWorker({ taskQueue: LEGACY_ENGINE_QUEUE, activities, connection, namespace: process.env.TEMPORAL_NAMESPACE, tracing });
console.log(`agentops worker started on "${ENGINE_QUEUE}" (+ legacy "${LEGACY_ENGINE_QUEUE}" during cutover)`);
try {
  await Promise.all([worker.run(), legacyWorker.run()]);
} finally {
  await tracing?.shutdown();
}
```

In `create-activities.ts` `applyScheduleChanges`, change `const tq = deps.taskQueue ?? 'agentops-devcycle';` to `const tq = deps.taskQueue ?? ENGINE_QUEUE;` (import `ENGINE_QUEUE`).

- [ ] **Step 6: Run typecheck + worker tests**

Run: `pnpm --filter @agentops/worker typecheck && pnpm --filter @agentops/worker test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/engine-queue.ts packages/contracts/src/engine-queue.test.ts packages/contracts/src/index.ts packages/worker/src/main.ts packages/activities/src/create-activities.ts
git commit -m "feat: ENGINE_QUEUE constant + agentops-engine rename with dual-queue cutover"
```

---

### Task 2: `ExistingSchedule.taskQueue` — self-healing re-point of legacy Schedules

`reconcileAgents` currently diffs only cron/workflow, so a Schedule pointing at the legacy queue never updates. Add `taskQueue` to the comparison so it re-points on the next reconcile.

**Files:**
- Modify: `packages/policies/src/reconcile-agents.ts`
- Modify: `packages/policies/src/reconcile-agents.test.ts`
- Modify: `packages/activities/src/create-activities.ts` (`listAgentSchedules` at ~241 to read `taskQueue`; `applyScheduleChanges` to compare)

- [ ] **Step 1: Write the failing test**

```ts
// add to packages/policies/src/reconcile-agents.test.ts
import { reconcileAgents, scheduleId } from './reconcile-agents';
import { ENGINE_QUEUE, LEGACY_ENGINE_QUEUE } from '@agentops/contracts';

it('re-points a schedule still on the legacy queue', () => {
  const declared = [{ name: 'nb', workflow: 'whiteboxBugHunt', schedule: '0 2 * * *', input: {}, enabled: true, timezone: 'UTC', overlap: 'skip' as const }];
  const existing = [{ id: scheduleId('p', 'nb'), scheduleSpec: '0 2 * * *', workflow: 'whiteboxBugHunt', paused: false, taskQueue: LEGACY_ENGINE_QUEUE }];
  const plan = reconcileAgents(declared, existing, 'p');
  expect(plan.toUpdate.map((s) => s.name)).toContain('nb');
});

it('does not update a schedule already on the engine queue', () => {
  const declared = [{ name: 'nb', workflow: 'whiteboxBugHunt', schedule: '0 2 * * *', input: {}, enabled: true, timezone: 'UTC', overlap: 'skip' as const }];
  const existing = [{ id: scheduleId('p', 'nb'), scheduleSpec: '0 2 * * *', workflow: 'whiteboxBugHunt', paused: false, taskQueue: ENGINE_QUEUE }];
  const plan = reconcileAgents(declared, existing, 'p');
  expect(plan.toUpdate).toHaveLength(0);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm --filter @agentops/policies test -- reconcile-agents`
Expected: FAIL — `taskQueue` not on `ExistingSchedule`; second test may pass, first fails (no re-point).

- [ ] **Step 3: Implement**

In `packages/policies/src/reconcile-agents.ts`, add `taskQueue` to the interface and the diff. `ExistingSchedule` becomes:

```ts
export interface ExistingSchedule { id: string; scheduleSpec: string; workflow: string; paused: boolean; taskQueue?: string }
```

In the `for (const spec of scheduled)` loop, extend the update condition (the built-in scheduled queue is always `ENGINE_QUEUE`):

```ts
import { ENGINE_QUEUE } from '@agentops/contracts';
// ...
const desiredQueue = ENGINE_QUEUE; // built-in scheduled workflows always run on the engine queue
if (cur.scheduleSpec !== spec.schedule || cur.workflow !== spec.workflow || (cur.taskQueue !== undefined && cur.taskQueue !== desiredQueue)) {
  plan.toUpdate.push(spec);
}
```

In `create-activities.ts` `listAgentSchedules`, read the action's task queue: after `const workflow = ...`, add `const taskQueue = (rec.action as any)?.taskQueue as string | undefined;` and push `{ id: sid, scheduleSpec, workflow, paused: false, taskQueue }`.

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @agentops/policies test -- reconcile-agents && pnpm --filter @agentops/activities test -- create-activities`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/policies/src/reconcile-agents.ts packages/policies/src/reconcile-agents.test.ts packages/activities/src/create-activities.ts
git commit -m "feat(policies): re-point legacy-queue schedules onto ENGINE_QUEUE on reconcile"
```

---

### Task 3: `agent` stage + routing/timeouts; `AgentSpec.taskQueue?`

Adds the generic Tier-2 stage (routable + attributable) and the optional manifest task-queue field for continuous Tier-2 agents.

**Files:**
- Modify: `packages/contracts/src/stage.ts`, `packages/contracts/src/model.ts`, `packages/contracts/src/agents-manifest.ts`
- Modify/Create tests: `packages/contracts/src/stage.test.ts` (or add to existing), `packages/contracts/src/agents-manifest.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// add to packages/contracts/src/agents-manifest.test.ts
it('accepts an optional taskQueue and defaults it absent', () => {
  const m = parseAgentsManifest({ agents: [{ name: 'r', workflow: 'rollbarMonitor', schedule: 'continuous', taskQueue: 'proj-acme' }] }, opts);
  expect(m.agents[0].taskQueue).toBe('proj-acme');
  const m2 = parseAgentsManifest({ agents: [{ name: 'nb', workflow: 'whiteboxBugHunt', schedule: '0 2 * * *' }] }, opts);
  expect(m2.agents[0].taskQueue).toBeUndefined();
});
```

```ts
// add to the stage test (StageSchema import)
it('accepts the generic agent stage', () => {
  expect(StageSchema.parse('agent')).toBe('agent');
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @agentops/contracts test -- agents-manifest stage`
Expected: FAIL — `taskQueue` rejected by strict schema; `StageSchema.parse('agent')` throws.

- [ ] **Step 3: Implement**

- `packages/contracts/src/stage.ts`: add `'agent'` to the `StageSchema` enum (after `'bughunt'`).
- `packages/contracts/src/model.ts`: add `agent: ModelRefSchema.optional(),` to `RoutingSchema` and `agent: StageTimeoutSchema.optional(),` to `TimeoutsSchema`.
- `packages/contracts/src/agents-manifest.ts`: add to `AgentSpecSchema` (keep `.strict()`):

```ts
    // Task queue the reconciler starts this agent on. Built-in workflows omit
    // it (they run on ENGINE_QUEUE); a continuous Tier-2 agent sets it to its
    // project worker's queue so the reconciler can start it by name there.
    taskQueue: z.string().min(1).optional(),
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @agentops/contracts test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/stage.ts packages/contracts/src/model.ts packages/contracts/src/agents-manifest.ts packages/contracts/src/agents-manifest.test.ts packages/contracts/src/stage.test.ts
git commit -m "feat(contracts): generic agent stage (+routing/timeouts) and AgentSpec.taskQueue"
```

---

### Task 4: Project-identity header + workflow-outbound propagation interceptor

Defines the header key and the workflow-sandbox interceptor that reads `project` from the workflow's memo and attaches it to every activity call + child workflow (memo/search-attr + header).

**Files:**
- Create: `packages/contracts/src/project-identity.ts` + `.test.ts` (the header key + a pure `readProjectFromMemo` helper)
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/workflows/src/project-interceptor.ts` (the workflow interceptor module)
- Create: `packages/workflows/src/project-interceptor.test.ts`

- [ ] **Step 1: Write the failing test (header key + memo reader)**

```ts
// packages/contracts/src/project-identity.test.ts
import { describe, it, expect } from 'vitest';
import { PROJECT_HEADER_KEY, readProjectFromMemo } from './project-identity';

describe('project identity', () => {
  it('has a stable header key', () => {
    expect(PROJECT_HEADER_KEY).toBe('x-agentops-project');
  });
  it('reads project from a memo, undefined when absent', () => {
    expect(readProjectFromMemo({ project: 'acme' })).toBe('acme');
    expect(readProjectFromMemo({})).toBeUndefined();
    expect(readProjectFromMemo(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @agentops/contracts test -- project-identity`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the contract**

```ts
// packages/contracts/src/project-identity.ts

// Temporal header carrying the caller workflow's project identity into
// activities and child workflows. The reconciler/Schedule/trigger stamp
// `project` in the workflow memo (the trusted origin); the workflow-outbound
// interceptor copies it here so the engine's activity worker can validate
// repo-ownership without the memo (ActivityInfo does not carry memo). See
// SP2 design §7.2.
export const PROJECT_HEADER_KEY = 'x-agentops-project';

export function readProjectFromMemo(memo: Record<string, unknown> | undefined): string | undefined {
  const p = memo?.project;
  return typeof p === 'string' && p.length > 0 ? p : undefined;
}
```

Add to `packages/contracts/src/index.ts`: `export * from './project-identity';`

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @agentops/contracts test -- project-identity`
Expected: PASS.

- [ ] **Step 5: Write the failing interceptor test**

```ts
// packages/workflows/src/project-interceptor.test.ts
import { describe, it, expect, vi } from 'vitest';
import { PROJECT_HEADER_KEY } from '@agentops/contracts';

// The interceptor reads workflowInfo().memo; mock the workflow module.
vi.mock('@temporalio/workflow', () => ({
  workflowInfo: () => ({ memo: { project: 'acme' } }),
}));
import { defaultPayloadConverter } from '@temporalio/common';
import { interceptors } from './project-interceptor';

describe('project-interceptor (outbound)', () => {
  it('stamps the project header on an activity call', async () => {
    const out = interceptors().outbound![0];
    const next = vi.fn(async (input) => ({ result: undefined, ...input }));
    const input = { headers: {}, args: [], activityType: 'createIssue', options: {}, seq: 1 } as any;
    await out.scheduleActivity!(input, next as any);
    const payload = next.mock.calls[0][0].headers[PROJECT_HEADER_KEY];
    expect(defaultPayloadConverter.fromPayload(payload)).toBe('acme');
  });

  it('stamps project memo + search attribute + header on a child workflow', async () => {
    const out = interceptors().outbound![0];
    const next = vi.fn(async (input) => ({ workflowExecution: { workflowId: 'x', runId: 'y' }, ...input }));
    const input = { headers: {}, args: [], workflowType: 'devCycle', options: {}, seq: 1 } as any;
    await out.startChildWorkflowExecution!(input, next as any);
    const passed = next.mock.calls[0][0];
    expect(defaultPayloadConverter.fromPayload(passed.headers[PROJECT_HEADER_KEY])).toBe('acme');
    expect(passed.options.memo.project).toBe('acme');
    expect(passed.options.searchAttributes.project).toEqual(['acme']);
  });
});
```

- [ ] **Step 6: Run, verify fail**

Run: `pnpm --filter @agentops/workflows test -- project-interceptor`
Expected: FAIL — module missing.

- [ ] **Step 7: Implement the interceptor**

```ts
// packages/workflows/src/project-interceptor.ts
import { workflowInfo, type WorkflowInterceptorsFactory, type WorkflowOutboundCallsInterceptor } from '@temporalio/workflow';
import { defaultPayloadConverter } from '@temporalio/common';
import { PROJECT_HEADER_KEY, readProjectFromMemo } from '@agentops/contracts';

// Reads the workflow's own project identity (stamped in memo by the engine at
// start) and propagates it onto every outbound activity + child call. Loaded
// as a workflowModules entry on both the engine worker (createWorker) and the
// SDK's createEngineWorker, so both built-in and project workflows propagate
// identity uniformly. SP2 design §7.2.
class ProjectOutbound implements WorkflowOutboundCallsInterceptor {
  private project(): string | undefined {
    return readProjectFromMemo(workflowInfo().memo as Record<string, unknown> | undefined);
  }
  async scheduleActivity(input: any, next: any) {
    const p = this.project();
    if (p) input.headers = { ...input.headers, [PROJECT_HEADER_KEY]: defaultPayloadConverter.toPayload(p) };
    return next(input);
  }
  async startChildWorkflowExecution(input: any, next: any) {
    const p = this.project();
    if (p) {
      input.headers = { ...input.headers, [PROJECT_HEADER_KEY]: defaultPayloadConverter.toPayload(p) };
      input.options = {
        ...input.options,
        memo: { ...(input.options?.memo ?? {}), project: p },
        searchAttributes: { ...(input.options?.searchAttributes ?? {}), project: [p] },
      };
    }
    return next(input);
  }
}

export const interceptors: WorkflowInterceptorsFactory = () => ({ outbound: [new ProjectOutbound()] });
```

- [ ] **Step 8: Run, verify pass**

Run: `pnpm --filter @agentops/workflows test -- project-interceptor`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts/src/project-identity.ts packages/contracts/src/project-identity.test.ts packages/contracts/src/index.ts packages/workflows/src/project-interceptor.ts packages/workflows/src/project-interceptor.test.ts
git commit -m "feat: project-identity header + workflow-outbound propagation interceptor"
```

---

### Task 5: Engine-side authz — inbound interceptor + `assertProjectOwnsRepo` guard

Reads the header on the engine's activity worker, stashes it per-invocation, and rejects any repo-touching activity whose caller project does not own the target repo.

**Files:**
- Create: `packages/activities/src/project-context.ts` + `.test.ts`
- Modify: `packages/activities/src/create-activities.ts` (guard the repo-scoped activities)
- Modify: `packages/activities/src/index.ts`
- Modify: `packages/worker/src/create-worker.ts` (install the activity-inbound interceptor)

- [ ] **Step 1: Write the failing test (context + guard)**

```ts
// packages/activities/src/project-context.test.ts
import { describe, it, expect } from 'vitest';
import { ApplicationFailure } from '@temporalio/common';
import { projectContext, getCallerProject, assertProjectOwnsRepo } from './project-context';

const registry = [{ project: 'acme', repo: 'acme/web' }, { project: 'globex', repo: 'globex/api' }];

describe('project authorization guard', () => {
  it('allows when the caller project owns the repo', () => {
    projectContext.run({ project: 'acme' }, () => {
      expect(() => assertProjectOwnsRepo('acme/web', registry)).not.toThrow();
    });
  });
  it('rejects a mismatched project', () => {
    projectContext.run({ project: 'acme' }, () => {
      expect(() => assertProjectOwnsRepo('globex/api', registry)).toThrow(ApplicationFailure);
    });
  });
  it('allows when no caller project is present (engine-internal/trusted)', () => {
    expect(getCallerProject()).toBeUndefined();
    expect(() => assertProjectOwnsRepo('globex/api', registry)).not.toThrow();
  });
  it('allows an unregistered repo (no scoped token exists anyway)', () => {
    projectContext.run({ project: 'acme' }, () => {
      expect(() => assertProjectOwnsRepo('nobody/repo', registry)).not.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @agentops/activities test -- project-context`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// packages/activities/src/project-context.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { ApplicationFailure } from '@temporalio/common';
import { normalizeRepo } from '@agentops/ports';

export interface ProjectCallContext { project?: string }

// Populated by the engine worker's activity-inbound interceptor from the
// PROJECT_HEADER_KEY header for the duration of each activity execution.
export const projectContext = new AsyncLocalStorage<ProjectCallContext>();

export function getCallerProject(): string | undefined {
  return projectContext.getStore()?.project;
}

// Rejects a repo-touching activity whose caller project does not own the repo.
// Absent caller project => engine-internal/trusted call (no cross-project
// claim to check). Unregistered repo => the engine holds no scoped token for
// it, so downstream fails naturally; no need to reject here. Only a *mismatch*
// between a stamped project and a registered repo's owner is an authz failure
// (this catches accidental cross-project action). SP2 design §7.2/§7.3.
export function assertProjectOwnsRepo(repo: string, registry: { project: string; repo: string }[]): void {
  const claimed = getCallerProject();
  if (!claimed) return;
  const target = normalizeRepo(repo);
  const owner = registry.find((e) => normalizeRepo(e.repo) === target)?.project;
  if (owner && owner !== claimed) {
    throw ApplicationFailure.nonRetryable(
      `project "${claimed}" is not authorized to act on repo "${repo}" (owned by "${owner}")`,
      'ProjectAuthorizationError',
    );
  }
}
```

Add to `packages/activities/src/index.ts`: `export * from './project-context';`

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @agentops/activities test -- project-context`
Expected: PASS.

- [ ] **Step 5: Guard the repo-scoped activities**

In `create-activities.ts`, import `assertProjectOwnsRepo` from `./project-context`, then call it at the top of the credential-bearing, repo-scoped activities — `createIssue` (`assertProjectOwnsRepo(req.repo, deps.registry)`), `openPr` (`assertProjectOwnsRepo(req.repo, deps.registry)`), `pushBranch` (`assertProjectOwnsRepo(repo, deps.registry)`), and `prepareWorkspace` (`assertProjectOwnsRepo(req.repo, deps.registry)`). `runAgent` is covered transitively — it runs in a workspace already authorized at `prepareWorkspace`. Add a test to `create-activities.test.ts` asserting `createIssue` throws `ProjectAuthorizationError` when run inside `projectContext.run({ project: 'other' }, ...)` against a repo owned by a different registry entry.

- [ ] **Step 6: Install the inbound interceptor on the engine worker**

In `packages/worker/src/create-worker.ts`, add an activity interceptor that decodes the header into the context, and load the outbound workflow interceptor module. Extend the `interceptors` block:

```ts
import { defaultPayloadConverter } from '@temporalio/common';
import { projectContext } from '@agentops/activities';
import { PROJECT_HEADER_KEY } from '@agentops/contracts';

const PROJECT_INTERCEPTOR_MODULE = require.resolve('@agentops/workflows/lib/project-interceptor'); // adjust to build output path

function projectInbound() {
  return {
    async execute(input: any, next: any) {
      const payload = input.headers?.[PROJECT_HEADER_KEY];
      const project = payload ? (defaultPayloadConverter.fromPayload(payload) as string) : undefined;
      return projectContext.run({ project }, () => next(input));
    },
  };
}
```

Then in `Worker.create({...})`, always include the project activity interceptor and the workflow module (independent of tracing):

```ts
interceptors: {
  activity: [
    (ctx) => ({ inbound: projectInbound() }),
    ...(tracing ? [(ctx: any) => ({ inbound: new OpenTelemetryActivityInboundInterceptor(ctx, { tracer: tracing.tracer }) })] : []),
  ],
  workflowModules: [PROJECT_INTERCEPTOR_MODULE, ...(tracing ? [OTEL_WORKFLOW_INTERCEPTOR_MODULE] : [])],
},
```

(Resolve the exact `project-interceptor` module path against the package's build output; `@agentops/workflows` currently ships from `lib/` — confirm against its `package.json` `main`/`exports`.)

- [ ] **Step 7: Run typecheck + tests + e2e**

Run: `pnpm --filter @agentops/worker typecheck && pnpm --filter @agentops/activities test && pnpm e2e`
Expected: PASS (existing e2e still green — absent-project calls are allowed).

- [ ] **Step 8: Commit**

```bash
git add packages/activities/src/project-context.ts packages/activities/src/project-context.test.ts packages/activities/src/create-activities.ts packages/activities/src/create-activities.test.ts packages/activities/src/index.ts packages/worker/src/create-worker.ts
git commit -m "feat: engine-side project authorization (inbound header + repo-ownership guard)"
```

---

### Task 6: Reconciler identity stamping — repo + search attributes on the Schedule action

Fixes the `args: [{ repo: '' }]` gap and stamps `project`/`agentName`/`workflowType` as memo + search attributes so scheduled runs carry a validated identity.

**Files:**
- Modify: `packages/workflows/src/config-sync.ts` (thread `repo` to `applyScheduleChanges`)
- Modify: `packages/workflows/src/activities-api.ts` (the `ConfigSyncActivities` signature)
- Modify: `packages/activities/src/create-activities.ts` (`applyScheduleChanges` signature + action fields)
- Modify: `packages/activities/src/create-activities.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// add to packages/activities/src/create-activities.test.ts — verify the create call
it('applyScheduleChanges stamps repo + project/agentName/workflowType and search attributes', async () => {
  const create = vi.fn().mockResolvedValue({});
  const acts = createActivities({ /* minimal deps */ scheduleClient: { create, getHandle: () => ({}) } as any, registry: [], /* ...other required deps as in existing tests */ } as any);
  const plan = { toCreate: [{ name: 'nb', workflow: 'whiteboxBugHunt', schedule: '0 2 * * *', input: { focus: 'auth' }, enabled: true, timezone: 'UTC', overlap: 'skip' }], toUpdate: [], toDelete: [], toPause: [], toResume: [] };
  await acts.applyScheduleChanges('acme', 'acme/web', plan as any);
  const arg = create.mock.calls[0][0];
  expect(arg.action.args[0]).toMatchObject({ repo: 'acme/web', project: 'acme', focus: 'auth' });
  expect(arg.memo).toMatchObject({ project: 'acme', agentName: 'nb', workflowType: 'whiteboxBugHunt' });
  expect(arg.searchAttributes).toMatchObject({ project: ['acme'], agentName: ['nb'], workflowType: ['whiteboxBugHunt'] });
});
```

(Reuse the existing test file's helper for building minimal `createActivities` deps if present; otherwise construct the deps inline as the other tests in that file do.)

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @agentops/activities test -- create-activities`
Expected: FAIL — `applyScheduleChanges` takes `(project, plan)`, not `(project, repo, plan)`; no repo/searchAttributes.

- [ ] **Step 3: Implement**

In `create-activities.ts`, change the signature to `async applyScheduleChanges(project: string, repo: string, plan: ReconcilePlan): Promise<void>` and inside the create/update loop:

```ts
const args = [{ repo, project, ...spec.input }];
const memo = { project, agentName: spec.name, workflowType: spec.workflow };
const searchAttributes = { project: [project], agentName: [spec.name], workflowType: [spec.workflow] };
// create:
await client.create({ scheduleId: id, spec: { cron: { cronString: spec.schedule, timezone: spec.timezone } },
  action: { type: 'startWorkflow', workflowType: spec.workflow, args, taskQueue: tq, memo, searchAttributes }, memo, searchAttributes } as any);
// update: pass the same action (incl. memo/searchAttributes/taskQueue) inside `schedule.action`.
```

In `activities-api.ts`, update the `ConfigSyncActivities` interface's `applyScheduleChanges` to `(project: string, repo: string, plan: ReconcilePlan) => Promise<void>`.

In `config-sync.ts`, change the call to `await acts.applyScheduleChanges(input.project, input.repo, plan);`.

- [ ] **Step 4: Run tests + e2e**

Run: `pnpm --filter @agentops/activities test -- create-activities && pnpm --filter @agentops/workflows test && pnpm e2e`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/workflows/src/config-sync.ts packages/workflows/src/activities-api.ts packages/activities/src/create-activities.ts packages/activities/src/create-activities.test.ts
git commit -m "fix(reconciler): stamp repo + project/agentName/workflowType (memo + search attributes) on schedules"
```

---

### Task 7: Continuous agents — `reconcileContinuous` policy

Pure diff of declared continuous agents vs. the running singletons.

**Files:**
- Modify: `packages/policies/src/reconcile-agents.ts` (add `reconcileContinuous`)
- Modify: `packages/policies/src/reconcile-agents.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// add to packages/policies/src/reconcile-agents.test.ts
import { reconcileContinuous, scheduleId } from './reconcile-agents';

const cont = (name: string) => ({ name, workflow: 'rollbarMonitor', schedule: 'continuous' as const, input: {}, enabled: true, timezone: 'UTC', overlap: 'skip' as const, taskQueue: 'proj-acme' });

it('starts declared continuous agents that are not running', () => {
  const plan = reconcileContinuous([cont('mon')], [], 'acme');
  expect(plan.toStart.map((s) => s.name)).toEqual(['mon']);
  expect(plan.toTerminate).toEqual([]);
});
it('terminates running singletons no longer declared', () => {
  const plan = reconcileContinuous([], [scheduleId('acme', 'mon')], 'acme');
  expect(plan.toStart).toEqual([]);
  expect(plan.toTerminate).toEqual([scheduleId('acme', 'mon')]);
});
it('is idempotent for an already-running declared agent', () => {
  const plan = reconcileContinuous([cont('mon')], [scheduleId('acme', 'mon')], 'acme');
  expect(plan.toStart).toEqual([]);
  expect(plan.toTerminate).toEqual([]);
});
it('excludes a disabled continuous agent (treated as terminate)', () => {
  const plan = reconcileContinuous([{ ...cont('mon'), enabled: false }], [scheduleId('acme', 'mon')], 'acme');
  expect(plan.toTerminate).toEqual([scheduleId('acme', 'mon')]);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @agentops/policies test -- reconcile-agents`
Expected: FAIL — `reconcileContinuous` not exported.

- [ ] **Step 3: Implement**

```ts
// add to packages/policies/src/reconcile-agents.ts
export interface ContinuousPlan { toStart: AgentSpec[]; toTerminate: string[] }

// Continuous agents are singleton long-lived workflows keyed by the same
// deterministic id as schedules (agent:<project>:<name>). Enabled + declared
// but not running => start; running but not declared (or disabled) =>
// terminate. SP2 design §8.
export function reconcileContinuous(declared: AgentSpec[], running: string[], project: string): ContinuousPlan {
  const wanted = declared.filter((a) => a.schedule === 'continuous' && a.enabled);
  const runningSet = new Set(running);
  const wantedIds = new Set(wanted.map((a) => scheduleId(project, a.name)));
  return {
    toStart: wanted.filter((a) => !runningSet.has(scheduleId(project, a.name))),
    toTerminate: running.filter((id) => !wantedIds.has(id)),
  };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @agentops/policies test -- reconcile-agents`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/policies/src/reconcile-agents.ts packages/policies/src/reconcile-agents.test.ts
git commit -m "feat(policies): reconcileContinuous — singleton start/terminate diff"
```

---

### Task 8: Continuous agents — activities + `configSync` workflow wiring

Lists running singletons, starts missing ones (deterministic id, identity stamped, on the agent's `taskQueue`), terminates orphans.

**Files:**
- Modify: `packages/activities/src/create-activities.ts` (add `listContinuousAgents`, `startContinuousAgent`, `terminateContinuousAgent`; add `workflowClient` to deps)
- Modify: `packages/workflows/src/activities-api.ts` (`ConfigSyncActivities` += the three)
- Modify: `packages/workflows/src/config-sync.ts`
- Modify: `packages/worker/src/main.ts` (pass `workflowClient` from the Temporal `Client`)
- Modify: `packages/activities/src/create-activities.test.ts`

- [ ] **Step 1: Write the failing test (activities)**

```ts
// add to packages/activities/src/create-activities.test.ts
it('startContinuousAgent starts a singleton by deterministic id with identity + taskQueue, tolerating AlreadyStarted', async () => {
  const start = vi.fn().mockResolvedValue({});
  const acts = createActivities({ workflowClient: { start, list: async function* () {} } as any, registry: [], /* ...other deps */ } as any);
  const spec = { name: 'mon', workflow: 'rollbarMonitor', schedule: 'continuous', input: {}, enabled: true, timezone: 'UTC', overlap: 'skip', taskQueue: 'proj-acme' };
  await acts.startContinuousAgent('acme', 'acme/web', spec as any);
  const [wf, opts] = start.mock.calls[0];
  expect(wf).toBe('rollbarMonitor');
  expect(opts.workflowId).toBe('agent:acme:mon');
  expect(opts.taskQueue).toBe('proj-acme');
  expect(opts.memo).toMatchObject({ project: 'acme', agentName: 'mon', workflowType: 'rollbarMonitor' });
  expect(opts.searchAttributes).toMatchObject({ project: ['acme'] });
  expect(opts.args[0]).toMatchObject({ repo: 'acme/web', project: 'acme' });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @agentops/activities test -- create-activities`
Expected: FAIL — `startContinuousAgent` undefined; `workflowClient` not on deps.

- [ ] **Step 3: Implement the activities**

Add `workflowClient?: WorkflowClientLike` to `ActivityDependencies` (define a minimal `WorkflowClientLike` interface next to `ScheduleClientLike` with `start(workflowType, opts)` and `list(query?)` and `getHandle(id).terminate()`). Then:

```ts
async listContinuousAgents(project: string): Promise<string[]> {
  const client = deps.workflowClient;
  if (!client?.list) return [];
  const ids: string[] = [];
  const prefix = `agent:${project}:`;
  try {
    for await (const wf of client.list(`ExecutionStatus="Running"`)) {
      const id = (wf as any).workflowId as string | undefined;
      if (id && id.startsWith(prefix)) ids.push(id);
    }
  } catch { /* best effort */ }
  return ids;
},
async startContinuousAgent(project: string, repo: string, spec: AgentSpec): Promise<void> {
  const client = deps.workflowClient;
  if (!client?.start) return;
  const id = scheduleId(project, spec.name);
  const memo = { project, agentName: spec.name, workflowType: spec.workflow };
  try {
    await client.start(spec.workflow, {
      workflowId: id,
      taskQueue: spec.taskQueue ?? ENGINE_QUEUE,
      args: [{ repo, project, ...spec.input }],
      memo,
      searchAttributes: { project: [project], agentName: [spec.name], workflowType: [spec.workflow] },
    });
  } catch (err) {
    // Singleton already running is the success case for a reconcile.
    if (!(err instanceof Error && err.name === 'WorkflowExecutionAlreadyStartedError')) throw err;
  }
},
async terminateContinuousAgent(id: string): Promise<void> {
  await deps.workflowClient?.getHandle?.(id)?.terminate?.('agent removed from manifest').catch(() => {});
},
```

- [ ] **Step 4: Wire the workflow**

In `activities-api.ts`, add the three to `ConfigSyncActivities`. In `config-sync.ts`, after the schedule reconcile:

```ts
const runningContinuous = await acts.listContinuousAgents(input.project);
const contPlan = reconcileContinuous(declared, runningContinuous, input.project);
for (const spec of contPlan.toStart) await acts.startContinuousAgent(input.project, input.repo, spec);
for (const id of contPlan.toTerminate) await acts.terminateContinuousAgent(id);
return { ...plan, continuous: contPlan };
```

(Import `reconcileContinuous`; widen the workflow return type to include `continuous`.)

- [ ] **Step 5: Wire the worker**

In `packages/worker/src/main.ts`, pass `workflowClient: tc.workflow as unknown as WorkflowClientLike` into `createActivities({...})` (the `Client` `tc` is already built for the ScheduleClient).

- [ ] **Step 6: Run tests + e2e**

Run: `pnpm --filter @agentops/activities test && pnpm --filter @agentops/workflows test && pnpm e2e`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/activities/src/create-activities.ts packages/activities/src/create-activities.test.ts packages/workflows/src/activities-api.ts packages/workflows/src/config-sync.ts packages/worker/src/main.ts
git commit -m "feat: reconcile continuous agents (singleton start/terminate) in ConfigSync"
```

---

### Task 9: Project-prompt provenance in `runAgent`

`runAgent` records `<repo>@<sha>:agentops/prompts/x.md` when the prompt comes from a project repo.

**Files:**
- Modify: `packages/contracts/src/agent-run.ts` (`AgentRunRequestSchema` += optional `promptSource`)
- Modify: `packages/activities/src/create-activities.ts` (`runAgent` uses it)
- Modify: `packages/activities/src/create-activities.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// add to packages/activities/src/create-activities.test.ts
it('runAgent records a project-repo promptSource when provided', async () => {
  const acts = createActivities({ /* stub backend + minimal deps as existing tests */ } as any);
  const res = await acts.runAgent({ /* ...valid AgentRunRequest fields... */, promptRef: 'x', promptSource: { repo: 'acme/web', commit: 'abc123', path: 'agentops/prompts/x.md' } } as any);
  expect(res.promptSource).toBe('acme/web@abc123:agentops/prompts/x.md');
});
it('runAgent defaults to builtin:<ref> when no project source is given', async () => {
  const acts = createActivities({ /* ... */ } as any);
  const res = await acts.runAgent({ /* ... */, promptRef: 'design' } as any);
  expect(res.promptSource).toBe('builtin:design');
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @agentops/activities test -- create-activities`
Expected: FAIL — `promptSource` rejected / not used.

- [ ] **Step 3: Implement**

In `agent-run.ts`, add to `AgentRunRequestSchema`:

```ts
  promptSource: z.object({ repo: z.string().min(1), commit: z.string().min(1), path: z.string().min(1) }).optional(),
```

In `create-activities.ts` `runAgent`, replace the fixed line with:

```ts
const promptSource = req.promptSource
  ? `${req.promptSource.repo}@${req.promptSource.commit}:${req.promptSource.path}`
  : `builtin:${req.promptRef}`;
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm --filter @agentops/activities test -- create-activities`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/agent-run.ts packages/activities/src/create-activities.ts packages/activities/src/create-activities.test.ts
git commit -m "feat: project-prompt provenance (<repo>@<sha>:path) in runAgent"
```

---

### Task 10: `EngineActivities` contract + `satisfies` assertion

Locks the delegatable surface (deliberately minimal: the capabilities a Tier-2 workflow calls directly). Heavy SCM/workspace ops stay internal to `devCycle`, reached via `childDevCycle`.

**Files:**
- Modify: `packages/contracts/src/tracker-types.ts` (new — move `Issue`/`CreatedIssue` shapes into contracts) OR add schemas; and `packages/ports/src/tracker-port.ts` imports the type
- Create: `packages/contracts/src/engine-activities.ts` + `.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/activities/src/create-activities.ts` (append a compile-time `satisfies` assertion)

- [ ] **Step 1: Write the failing test (contract presence)**

```ts
// packages/contracts/src/engine-activities.test.ts
import { describe, it, expectTypeOf } from 'vitest';
import type { EngineActivities } from './engine-activities';

describe('EngineActivities', () => {
  it('exposes the minimal delegatable surface', () => {
    expectTypeOf<EngineActivities>().toHaveProperty('runAgent');
    expectTypeOf<EngineActivities>().toHaveProperty('createIssue');
    expectTypeOf<EngineActivities>().toHaveProperty('getIssue');
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @agentops/contracts test -- engine-activities`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the contract**

Add the tracker data shapes to contracts (mirror `packages/ports/src/tracker-port.ts`):

```ts
// packages/contracts/src/tracker-types.ts
export interface Issue { ref: string; title: string; body: string; labels: string[] }
export interface CreateIssueInput { repo: string; project: string; title: string; body: string; labels: string[]; dedupeFingerprint?: string }
export interface CreateIssueResult { ref: string; url: string; deduped: boolean }
```

In `packages/ports/src/tracker-port.ts`, replace the local `Issue` with `import type { Issue } from '@agentops/contracts'; export type { Issue };` (type-only, no runtime change) so ports and contracts share one `Issue`.

```ts
// packages/contracts/src/engine-activities.ts
import type { AgentRunRequest, AgentRunResult } from './agent-run';
import type { Issue, CreateIssueInput, CreateIssueResult } from './tracker-types';

// The delegatable engine activity surface exposed to Tier-2 project workflows
// via @agentops/engine-sdk/workflow. This interface + the child-workflow names
// (devCycle) + ENGINE_QUEUE are the published semver compatibility contract
// (SP2 design §3.2). Deliberately minimal — heavy SCM/workspace ops stay
// internal to devCycle, reached via childDevCycle.
export interface EngineActivities {
  runAgent(req: AgentRunRequest): Promise<AgentRunResult & { promptHash: string; promptSource: string }>;
  createIssue(req: CreateIssueInput): Promise<CreateIssueResult>;
  getIssue(ref: string): Promise<Issue>;
  commentOnIssue(ref: string, body: string): Promise<void>;
  labelIssue(ref: string, label: string): Promise<void>;
}
```

Add to `packages/contracts/src/index.ts`: `export * from './tracker-types';` and `export * from './engine-activities';`

- [ ] **Step 4: Add the drift-guard assertion**

At the bottom of `packages/activities/src/create-activities.ts`:

```ts
import type { EngineActivities } from '@agentops/contracts';
// Compile-time guarantee: the engine's activity implementation stays a
// superset of the published EngineActivities surface. If a signature drifts,
// typecheck fails here. SP2 design §3.2.
type _Acts = ReturnType<typeof createActivities>;
type _AssertEngineSurface = _Acts extends EngineActivities ? true : false;
const _engineSurfaceOk: _AssertEngineSurface = true;
void _engineSurfaceOk;
```

(If the assertion fails, reconcile the `createIssue`/`getIssue` signatures so the engine returns the contract shapes — adjust `CreateIssueInput`/`CreateIssueResult` to match the existing implementation exactly.)

- [ ] **Step 5: Run typecheck + tests across affected packages**

Run: `pnpm --filter @agentops/contracts test && pnpm --filter @agentops/ports typecheck && pnpm --filter @agentops/activities typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/tracker-types.ts packages/contracts/src/engine-activities.ts packages/contracts/src/engine-activities.test.ts packages/contracts/src/index.ts packages/ports/src/tracker-port.ts packages/activities/src/create-activities.ts
git commit -m "feat(contracts): EngineActivities semver surface + drift-guard assertion"
```

---

### Task 11: Search-attribute registration script + docs

Registers the custom search attributes an environment needs before the reconciler stamps them.

**Files:**
- Create: `scripts/register-search-attributes.sh`
- Modify: `docs/agents-json.md` (note the required attributes)

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Register the custom Temporal search attributes the reconciler/Schedule/
# continuous-start stamp (SP2 design §7). Idempotent: "already exists" is fine.
# Usage: TEMPORAL_ADDRESS=... TEMPORAL_NAMESPACE=... ./scripts/register-search-attributes.sh
set -euo pipefail
NS="${TEMPORAL_NAMESPACE:?set TEMPORAL_NAMESPACE}"
for attr in project agentName workflowType; do
  temporal operator search-attribute create --namespace "$NS" --name "$attr" --type Keyword || true
done
echo "registered: project, agentName, workflowType (Keyword) in $NS"
```

- [ ] **Step 2: Make it executable + document**

Run: `chmod +x scripts/register-search-attributes.sh`
Add a short "Search attributes" subsection to `docs/agents-json.md`: the three Keyword attributes, that they must be registered per environment before reconcile, and that they let the board/cost dashboards slice per agent instance.

- [ ] **Step 3: Commit**

```bash
git add scripts/register-search-attributes.sh docs/agents-json.md
git commit -m "chore: search-attribute registration script + docs (project/agentName/workflowType)"
```

---

# Phase B — packaging & external

### Task 12: Scaffold `@agentops/engine-sdk`

**Files:**
- Create: `packages/engine-sdk/package.json`, `tsup.config.ts`, `tsconfig.json`, `src/workflow.ts` (stub), `src/worker.ts` (stub), `README.md`
- Modify: `pnpm-workspace.yaml` only if packages are not globbed (check first)

- [ ] **Step 1: Create the package manifest**

```jsonc
// packages/engine-sdk/package.json
{
  "name": "@agentops/engine-sdk",
  "version": "0.1.0",
  "description": "Thin, secret-free facade for authoring Tier-2 agentops project workflows.",
  "license": "MIT",
  "type": "module",
  "files": ["dist"],
  "exports": {
    "./workflow": { "types": "./dist/workflow.d.ts", "import": "./dist/workflow.js", "require": "./dist/workflow.cjs" },
    "./worker": { "types": "./dist/worker.d.ts", "import": "./dist/worker.js", "require": "./dist/worker.cjs" }
  },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "peerDependencies": { "@temporalio/workflow": "*", "@temporalio/worker": "*", "@temporalio/common": "*", "@temporalio/client": "*" },
  "dependencies": { "zod": "^3.23.0" },
  "publishConfig": { "access": "public" }
}
```

- [ ] **Step 2: tsup + tsconfig**

```ts
// packages/engine-sdk/tsup.config.ts
import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { workflow: 'src/workflow.ts', worker: 'src/worker.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  // Self-contained: bundle the used bits of contracts/policies. Keep Temporal
  // external — it is a peer dep provided by the consumer's worker.
  noExternal: [/@agentops\//],
  external: [/@temporalio\//],
});
```

`tsconfig.json` extends the repo base; stub `src/workflow.ts`/`src/worker.ts` with `export {};` so the build succeeds.

- [ ] **Step 3: Verify it builds**

Run: `pnpm --filter @agentops/engine-sdk install && pnpm --filter @agentops/engine-sdk build`
Expected: PASS — `dist/workflow.*` and `dist/worker.*` emitted.

- [ ] **Step 4: Commit**

```bash
git add packages/engine-sdk/
git commit -m "chore(engine-sdk): scaffold public package (tsup dual-entry, peer Temporal)"
```

---

### Task 13: SDK `/workflow` entry — proxies, `childDevCycle`, parsers, interceptor

**Files:**
- Modify: `packages/engine-sdk/src/workflow.ts`
- Create: `packages/engine-sdk/src/project-interceptor.ts` (SDK-local copy; see note)
- Create: `packages/engine-sdk/src/workflow.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine-sdk/src/workflow.test.ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('@temporalio/workflow', () => ({
  proxyActivities: (opts: any) => ({ __opts: opts }),
  executeChild: vi.fn(),
  workflowInfo: () => ({ memo: { project: 'acme' } }),
}));
import { engineActivities, engineAgent, ENGINE_QUEUE } from './workflow';

describe('engine-sdk/workflow', () => {
  it('proxies engine activities to ENGINE_QUEUE', () => {
    expect(ENGINE_QUEUE).toBe('agentops-engine');
    expect((engineActivities() as any).__opts.taskQueue).toBe(ENGINE_QUEUE);
    expect((engineAgent() as any).__opts.taskQueue).toBe(ENGINE_QUEUE);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @agentops/engine-sdk test`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement**

```ts
// packages/engine-sdk/src/workflow.ts
import { proxyActivities, executeChild } from '@temporalio/workflow';
import type { EngineActivities } from '@agentops/contracts';
import { ENGINE_QUEUE } from '@agentops/contracts';
export { ENGINE_QUEUE };
export type { EngineActivities } from '@agentops/contracts';
export { parseFindings } from '@agentops/policies';
export { parseVerdict } from '@agentops/policies';
import type { DevCycleState, TaskInput } from '@agentops/contracts';

// Proxy the engine's activities onto ENGINE_QUEUE so privileged, credential-
// holding work runs on the engine's workers, not the project worker.
export function engineActivities(opts: { startToCloseTimeout?: string } = {}) {
  return proxyActivities<EngineActivities>({ taskQueue: ENGINE_QUEUE, startToCloseTimeout: opts.startToCloseTimeout ?? '10 minutes' });
}
// Longer default for agent runs.
export function engineAgent(opts: { startToCloseTimeout?: string } = {}) {
  return proxyActivities<EngineActivities>({ taskQueue: ENGINE_QUEUE, startToCloseTimeout: opts.startToCloseTimeout ?? '1 hour' });
}
// Run the built-in devCycle pipeline on the engine, started by name.
export function childDevCycle(input: TaskInput): Promise<DevCycleState> {
  return executeChild('devCycle', { taskQueue: ENGINE_QUEUE, args: [input] });
}
export { interceptors } from './project-interceptor';
```

`src/project-interceptor.ts` — an SDK-local copy of `packages/workflows/src/project-interceptor.ts` (identical logic; duplicated deliberately so the SDK stays self-contained and does not depend on `@agentops/workflows` at runtime — the shared invariant is `PROJECT_HEADER_KEY`, bundled from contracts). Verify with a test mirroring Task 4's interceptor test.

(Confirm `TaskInput`/`DevCycleState` are exported from contracts; they are used by `devCycle`. If `childDevCycle`'s input differs, mirror `devCycle`'s actual argument shape.)

- [ ] **Step 4: Run test + build**

Run: `pnpm --filter @agentops/engine-sdk test && pnpm --filter @agentops/engine-sdk build`
Expected: PASS; `dist/workflow.*` self-contained (grep the bundle: no `require('@agentops`).

- [ ] **Step 5: Commit**

```bash
git add packages/engine-sdk/src/workflow.ts packages/engine-sdk/src/project-interceptor.ts packages/engine-sdk/src/workflow.test.ts
git commit -m "feat(engine-sdk): /workflow entry — engine proxies, childDevCycle, parsers, interceptor"
```

---

### Task 14: SDK `/worker` entry — `createEngineWorker`

**Files:**
- Modify: `packages/engine-sdk/src/worker.ts`
- Create: `packages/engine-sdk/src/worker.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine-sdk/src/worker.test.ts
import { describe, it, expect, vi } from 'vitest';
const create = vi.fn().mockResolvedValue({ run: vi.fn() });
vi.mock('@temporalio/worker', () => ({ Worker: { create } }));
import { createEngineWorker } from './worker';

describe('createEngineWorker', () => {
  it('registers the project header inbound interceptor + the outbound workflow module', async () => {
    await createEngineWorker({ taskQueue: 'proj-acme', workflowsPath: '/x', activities: {} });
    const opts = create.mock.calls[0][0];
    expect(opts.taskQueue).toBe('proj-acme');
    expect(opts.interceptors.activity).toHaveLength(1);
    expect(opts.interceptors.workflowModules).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @agentops/engine-sdk test -- worker`
Expected: FAIL — missing.

- [ ] **Step 3: Implement**

```ts
// packages/engine-sdk/src/worker.ts
import { Worker, type NativeConnection } from '@temporalio/worker';
import { defaultPayloadConverter } from '@temporalio/common';
import { PROJECT_HEADER_KEY } from '@agentops/contracts';

export interface CreateEngineWorkerOptions {
  taskQueue: string;
  workflowsPath: string;
  activities: Record<string, (...args: never[]) => Promise<unknown>>;
  connection?: NativeConnection;
  namespace?: string;
}

// Creates a project worker that: (1) runs the project's own workflows +
// activities; (2) propagates project identity outbound via the bundled
// interceptor module; (3) exposes the inbound header so the engine can
// validate repo-ownership. The project identity itself is stamped at start by
// the engine reconciler (memo), never chosen here. SP2 design §7.2.
export function createEngineWorker(options: CreateEngineWorkerOptions) {
  return Worker.create({
    connection: options.connection,
    namespace: options.namespace,
    taskQueue: options.taskQueue,
    workflowsPath: options.workflowsPath,
    activities: options.activities,
    interceptors: {
      activity: [
        () => ({
          inbound: {
            async execute(input: any, next: any) {
              // Project workers do not consume the inbound project header
              // themselves (they hold no credentials); the engine's own worker
              // enforces it. This inbound is a no-op passthrough kept for
              // symmetry / future project-side auditing.
              return next(input);
            },
          },
        }),
      ],
      workflowModules: [require.resolve('./project-interceptor')],
    },
  });
}
```

(The header VALUE is decoded and enforced on the *engine* worker, Task 5. The project worker only needs the outbound propagation, which the workflow module provides.)

- [ ] **Step 4: Run test + build**

Run: `pnpm --filter @agentops/engine-sdk test && pnpm --filter @agentops/engine-sdk build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine-sdk/src/worker.ts packages/engine-sdk/src/worker.test.ts
git commit -m "feat(engine-sdk): /worker entry — createEngineWorker with identity propagation"
```

---

### Task 15: Tarball-install typecheck (proves bundling + peer deps + `.d.ts`)

**Files:**
- Create: `packages/engine-sdk/scripts/verify-tarball.sh`

- [ ] **Step 1: Write the verification script**

```bash
#!/usr/bin/env bash
# Pack the SDK and typecheck a throwaway consumer against BOTH entry points —
# proves the published tarball (not the workspace path) resolves, bundles
# contracts/policies, and ships correct .d.ts. SP2 design §13.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm build
TARBALL="$(pnpm pack | tail -1)"
TMP="$(mktemp -d)"
cp "$TARBALL" "$TMP/"
cd "$TMP"
cat > package.json <<'JSON'
{ "name": "sdk-consumer", "private": true, "type": "module" }
JSON
npm init -y >/dev/null 2>&1 || true
npm i "./$(basename "$TARBALL")" @temporalio/workflow @temporalio/worker @temporalio/common @temporalio/client typescript >/dev/null
cat > check.ts <<'TS'
import { engineActivities, childDevCycle, ENGINE_QUEUE } from '@agentops/engine-sdk/workflow';
import { createEngineWorker } from '@agentops/engine-sdk/worker';
const _ = { engineActivities, childDevCycle, ENGINE_QUEUE, createEngineWorker };
TS
npx tsc --noEmit --moduleResolution bundler --module esnext check.ts
echo "tarball verify OK"
```

- [ ] **Step 2: Run it**

Run: `chmod +x packages/engine-sdk/scripts/verify-tarball.sh && packages/engine-sdk/scripts/verify-tarball.sh`
Expected: `tarball verify OK`. (If module resolution fails, adjust `exports`/`tsconfig` until both imports typecheck.)

- [ ] **Step 3: Commit**

```bash
git add packages/engine-sdk/scripts/verify-tarball.sh
git commit -m "test(engine-sdk): tarball-install typecheck for both entry points"
```

---

### Task 16: Reference project worker + cross-worker e2e

A minimal Rollbar-style Tier-2 project worker exercising delegation, authz rejection, and continuous-singleton idempotency, all on `@temporalio/testing`.

**Files:**
- Create: `examples/project-worker/agentops/workflows/rollbar-monitor.ts`, `worker.ts`, `agents.json`, `README.md`
- Create: `e2e/tier2-project-worker.e2e.test.ts`

- [ ] **Step 1: Write the reference workflow + worker**

`rollbar-monitor.ts`: a workflow using `engineAgent()`/`engineActivities()` from `@agentops/engine-sdk/workflow` (via `workspace:*`) that, given a synthetic finding, calls `engineActivities().createIssue({ repo, project, title, body, labels: ['bug'], dedupeFingerprint })`. Keep it deterministic (finding passed as input) so the e2e is stable. `worker.ts` uses `createEngineWorker`.

- [ ] **Step 2: Write the failing e2e**

```ts
// e2e/tier2-project-worker.e2e.test.ts (sketch — mirror existing e2e harness setup)
// - Start a TestWorkflowEnvironment.
// - Engine worker on ENGINE_QUEUE with stub backend + memory ports + a registry [{project:'acme', repo:'acme/web'}].
// - Project worker (createEngineWorker) on 'proj-acme' with the rollbarMonitor workflow.
// (a) delegation: start rollbarMonitor with memo {project:'acme'} + args {repo:'acme/web'}; assert an issue is filed via the engine.
// (b) authz reject: start it with memo {project:'acme'} but args {repo:'globex/api'}; assert it fails with ProjectAuthorizationError and NO issue is filed.
// (c) continuous idempotency: start the same workflowId 'agent:acme:mon' twice; assert the second start observes WorkflowExecutionAlreadyStarted.
```

- [ ] **Step 3: Run, verify fail then implement to green**

Run: `pnpm e2e -- tier2-project-worker`
Expected: FAIL first (workflow/worker not wired), then PASS after implementation.

- [ ] **Step 4: Run full e2e**

Run: `pnpm e2e`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add examples/project-worker/ e2e/tier2-project-worker.e2e.test.ts
git commit -m "test(e2e): reference Tier-2 project worker — delegation, authz reject, continuous idempotency"
```

---

### Task 17: Authoring guide + agent-runner skill

The project-facing "how to write a custom project workflow" instructions the user asked for.

**Files:**
- Create: `docs/authoring-project-workflows.md`
- Create: the baked-in agent-runner skill (mirror the existing devcycle stage-skills location; confirm the path from `docs/superpowers/specs/2026-07-08-devcycle-stage-skills-design.md`)

- [ ] **Step 1: Write the guide**

`docs/authoring-project-workflows.md` — a complete walkthrough:
1. **When you need Tier 2** (a workflow shape no built-in provides; else use `agents.json` Tier 1).
2. **Install:** `pnpm add @agentops/engine-sdk @temporalio/workflow @temporalio/worker @temporalio/common @temporalio/client`.
3. **Author `agentops/workflows/<name>.ts`** — a worked `rollbarMonitor` example: `import { engineAgent, engineActivities, childDevCycle } from '@agentops/engine-sdk/workflow'`; poll your own activity; per finding `engineActivities().createIssue({ repo, project, labels:['bug'], dedupeFingerprint })`; use `childDevCycle(input)` to drive a fix to a merged PR.
4. **Author `agentops/activities/*.ts`** for your own externals (e.g. `rollbarFetch`) holding *your* secret — never an engine secret.
5. **`agentops/worker.ts`** — `createEngineWorker({ taskQueue: 'proj-<name>', namespace, workflowsPath: require.resolve('./workflows'), activities })`.
6. **`agents.json`** — add the entry (`"schedule": "continuous"` or a cron, and `"taskQueue": "proj-<name>"` for continuous Tier-2).
7. **Deploy** — a normal Deployment in the shared `proj` namespace, mounting only Temporal connection config + your own externals (no engine secrets).
8. **What the engine enforces** — identity is stamped by the reconciler; you cannot act on another project's repo; every `runAgent` is telemetered/provenance-stamped.
Link to `examples/project-worker/`.

- [ ] **Step 2: Write the skill**

A concise agent-runner skill ("author-project-workflow") pointing at the guide + example, so an agent asked to add a Tier-2 workflow follows the SDK + per-project-worker pattern. Match the format of the existing stage skills.

- [ ] **Step 3: Commit**

```bash
git add docs/authoring-project-workflows.md <skill path>
git commit -m "docs: authoring guide + agent-runner skill for Tier-2 project workflows"
```

---

### Task 18: Publish `@agentops/engine-sdk` to public npm

> Outward-facing, irreversible. Do only after Tasks 12–16 are green and the PR (Task 19) is approved/merged, or as an explicit release step the human confirms.

**Files:** none (release action).

- [ ] **Step 1: Dry run**

Run: `pnpm --filter @agentops/engine-sdk build && cd packages/engine-sdk && npm publish --access public --dry-run`
Expected: the packed file list contains only `dist/**` + `package.json` + `README.md` (no `src`, no secrets).

- [ ] **Step 2: Confirm the `@agentops` org + auth**

Verify `npm whoami` and that the `@agentops` scope is owned/available. If not yet claimed, claim it (human step) before publishing.

- [ ] **Step 3: Publish**

Run (human-confirmed): `cd packages/engine-sdk && npm publish --access public`
Expected: `@agentops/engine-sdk@0.1.0` live. Verify `npm view @agentops/engine-sdk`.

- [ ] **Step 4: Record the release**

Note the published version in `packages/engine-sdk/README.md` / CHANGELOG and commit.

```bash
git add packages/engine-sdk/README.md
git commit -m "chore(engine-sdk): publish 0.1.0 to public npm"
```

---

### Task 19: Ship the change (PR + CI)

> REQUIRED SUB-SKILL: use the `shipping-changes` skill for the mechanics. This repo's automated Bugbot review is inactive (confirmed removed) — **skip the Bugbot wait/resolve step**; land on green CI + human review.

**Files:** none (integration).

- [ ] **Step 1: Sync main**

```bash
git fetch origin && git rebase origin/main
```
Resolve any conflicts; re-run the full suite after.

- [ ] **Step 2: Full local verification**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e && pnpm --filter @agentops/policies test:policies-coverage`
Expected: all green.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin HEAD
gh pr create --repo est1908-agentic-ops/agentops-engine --title "feat: SP2 — Tier-2 SDK + per-project worker + authorization" --body "Implements docs/superpowers/specs/2026-07-12-custom-agent-workflows-sp2-design.md (SP2, #31). Phase A engine-side (ENGINE_QUEUE rename, EngineActivities, project-identity authz, continuous agents, project-prompt provenance, agent stage) + Phase B (@agentops/engine-sdk, reference worker, authoring guide). Publish (Task 18) is a separate release step."
```

- [ ] **Step 4: Get CI green**

Watch checks (`gh pr checks --watch`); fix failures; push; repeat until green.

- [ ] **Step 5: Merge after human review**

Merge once approved and green. Delete the branch.

---

## Self-Review

**Spec coverage** (SP2 design §):
- §2 phasing → Phase A (Tasks 1–11) / Phase B (Tasks 12–18). ✓
- §3.1 ENGINE_QUEUE + rename cutover → Tasks 1, 2. ✓
- §3.2 EngineActivities + satisfies → Task 10. ✓
- §4 SDK (tsup dual-entry, peer deps, self-contained) → Tasks 12–14. ✓
- §5 per-project worker convention + reference impl → Tasks 14, 16, 17. ✓
- §6 activity routing / childDevCycle → Task 13. ✓
- §7.1 topology (shared `proj` namespace, no NetworkPolicy) → documented in Task 17 guide (no manifest work, per the simplification). ✓
- §7.2 identity binding (memo→header→registry) → Tasks 4, 5, 6. ✓
- §7.3 threat model → encoded in the guard's "absent → allow / mismatch → reject" (Task 5) + guide. ✓
- §8 continuous agents → Tasks 7, 8; `AgentSpec.taskQueue` Task 3. ✓
- §9 project-prompt provenance → Task 9. ✓
- §10 `agent` stage (+routing/timeouts) → Task 3. ✓
- §12 search-attribute registration → Task 11; stamping Tasks 6, 8. ✓
- §13 testing (unit/e2e/tarball/publish) → Tasks 10, 15, 16, 18. ✓

**Placeholder scan:** the `create-activities` test steps say "minimal deps as existing tests" — the implementer must copy the deps-builder already used in `create-activities.test.ts`; this is a pointer to concrete existing code, not an unspecified blank. All schema/interceptor/guard code is complete.

**Type consistency:** `ENGINE_QUEUE`/`LEGACY_ENGINE_QUEUE`, `PROJECT_HEADER_KEY`, `readProjectFromMemo`, `assertProjectOwnsRepo`, `projectContext`/`getCallerProject`, `reconcileContinuous`/`ContinuousPlan`, `ExistingSchedule.taskQueue`, `EngineActivities`, `Issue`/`CreateIssueInput`/`CreateIssueResult`, `promptSource` descriptor, `AgentSpec.taskQueue` are used consistently across tasks.

**Shipping task:** Task 19 (PR/CI), Bugbot skipped per repo state. ✓

**Note for the executor:** Phase A (Tasks 1–11) is independently mergeable and delivers value with no packaging risk; if splitting into two PRs is preferred, cut between Task 11 and Task 12.
