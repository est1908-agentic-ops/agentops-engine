# Custom Agent Workflows — SP3 (Triggers + run-from-UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the built (but dormant) custom-agent machinery into a running loop — the `ConfigSync` reconciler fires on push + on a periodic safety Schedule, agent-filed `agent:fix` issues become deduped `devCycle` PRs with an `agent:working` label lifecycle, cron Tier-2 agents run on the right queue, and an operator can trigger any scheduled agent from the control console.

**Architecture:** Gateway gains `push` (→ reconcile) and generalized issue triggering (`opened`+`labeled`). A `reconcileAllProjects` workflow fired by a worker-ensured periodic Schedule provides drift safety. `devCycle` stamps/drops `agent:working` via a new `removeLabel` port capability. Schedules target the agent's own queue. The control server lists `agent:*` Temporal Schedules and triggers them (`schedule.trigger()`), gated behind the CRUD token; the UI adds an "Agents" page.

**Tech Stack:** Node 22, pnpm workspaces, TypeScript strict, Temporal TS SDK, zod (`packages/contracts`), vitest + `@temporalio/testing`, React/Vite (`packages/ui`).

**Design authority:** `docs/superpowers/specs/2026-07-12-custom-agent-workflows-sp3-design.md`.

## Global Constraints

- **Determinism boundary:** `packages/workflows` does no I/O; side effects via proxied activities. **`packages/policies` stays pure** (100% coverage).
- **Contracts first:** new shapes are zod schemas in `packages/contracts`, re-exported from its `index.ts`. No `any`.
- **Ports, not vendors:** only `packages/ports/**` calls a forge/tracker SDK. **No secrets** in code/fixtures; tests use `stub`/`memory`.
- **Every task ends green:** `pnpm lint && pnpm typecheck && pnpm test`; `pnpm e2e` for workflows/policies/activities/backends/gateway.
- Conventional commits; unit tests beside source; e2e in root `e2e/*.e2e.test.ts`.

---

### Task 1: `TrackerPort.removeLabel` + memory/github impls

**Files:**
- Modify: `packages/ports/src/tracker-port.ts`, `packages/ports/src/memory/memory-tracker.ts`, `packages/ports/src/github/github-tracker-port.ts`
- Modify: `packages/ports/src/memory/memory-tracker.test.ts`, `packages/ports/src/github/github-tracker-port.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// add to packages/ports/src/memory/memory-tracker.test.ts
it('removeLabel drops a label; getLabels reflects it', async () => {
  const t = new MemoryTrackerPort();
  await t.label('o/r#1', 'agent:working');
  await t.removeLabel('o/r#1', 'agent:working');
  expect(t.getLabels('o/r#1')).not.toContain('agent:working');
});
it('removeLabel on a missing label is a no-op', async () => {
  const t = new MemoryTrackerPort();
  await expect(t.removeLabel('o/r#1', 'nope')).resolves.toBeUndefined();
});
```

```ts
// add to packages/ports/src/github/github-tracker-port.test.ts (mirror the label test's octokit mock)
it('removeLabel calls issues.removeLabel with owner/repo/number/name', async () => {
  const removeLabel = vi.fn().mockResolvedValue({});
  const port = new GithubTrackerPort({ rest: { issues: { removeLabel } } } as any);
  await port.removeLabel('o/r#7', 'agent:working');
  expect(removeLabel).toHaveBeenCalledWith({ owner: 'o', repo: 'r', issue_number: 7, name: 'agent:working' });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @agentops/ports test -- tracker`
Expected: FAIL — `removeLabel` not on `TrackerPort`.

- [ ] **Step 3: Implement**

In `tracker-port.ts`, add to the interface: `removeLabel(ref: string, label: string): Promise<void>;`

In `memory-tracker.ts`:
```ts
async removeLabel(ref: string, label: string): Promise<void> {
  this.labels.get(ref)?.delete(label);
}
```

In `github-tracker-port.ts` (mirror `label`, which parses `ref` into owner/repo/number):
```ts
async removeLabel(ref: string, label: string): Promise<void> {
  const { owner, repo, number } = parseRef(ref); // same helper `label` uses
  // 404 when the label isn't present is not an error for an idempotent drop.
  await this.client.rest.issues.removeLabel({ owner, repo, issue_number: number, name: label }).catch((err) => {
    if ((err as { status?: number }).status !== 404) throw err;
  });
}
```

(Match the exact `ref` parsing `label()` already uses — reuse its helper, don't reinvent.)

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @agentops/ports test -- tracker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ports/src/tracker-port.ts packages/ports/src/memory/memory-tracker.ts packages/ports/src/github/github-tracker-port.ts packages/ports/src/memory/memory-tracker.test.ts packages/ports/src/github/github-tracker-port.test.ts
git commit -m "feat(ports): TrackerPort.removeLabel (memory + github)"
```

---

### Task 2: Activities — `unlabelIssue` + `listManagedProjects`

**Files:**
- Modify: `packages/activities/src/create-activities.ts`, `packages/activities/src/create-activities.test.ts`
- Modify: `packages/workflows/src/activities-api.ts` (`DevCycleActivities` += `unlabelIssue`; `ConfigSyncActivities` += `listManagedProjects`)

- [ ] **Step 1: Write failing test**

```ts
// add to packages/activities/src/create-activities.test.ts
it('unlabelIssue delegates to tracker.removeLabel', async () => {
  const removeLabel = vi.fn().mockResolvedValue(undefined);
  const acts = createActivities({ /* minimal deps as existing tests */ tracker: { removeLabel } as any } as any);
  await acts.unlabelIssue('o/r#1', 'agent:working');
  expect(removeLabel).toHaveBeenCalledWith('o/r#1', 'agent:working');
});
it('listManagedProjects returns registry {project,repo} pairs', async () => {
  const acts = createActivities({ /* ... */ registry: [{ project: 'acme', repo: 'acme/web', token: 't', trackerType: 'github' }] } as any);
  expect(await acts.listManagedProjects()).toEqual([{ project: 'acme', repo: 'acme/web' }]);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @agentops/activities test -- create-activities`
Expected: FAIL — methods undefined.

- [ ] **Step 3: Implement**

In `create-activities.ts` add:
```ts
async unlabelIssue(ref: string, label: string): Promise<void> {
  await deps.tracker.removeLabel(ref, label);
},
async listManagedProjects(): Promise<Array<{ project: string; repo: string }>> {
  return deps.registry.map((e) => ({ project: e.project, repo: e.repo }));
},
```

In `activities-api.ts`: add `unlabelIssue(ref: string, label: string): Promise<void>;` to `DevCycleActivities`, and `listManagedProjects(): Promise<Array<{ project: string; repo: string }>>;` to `ConfigSyncActivities`.

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @agentops/activities test -- create-activities`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/activities/src/create-activities.ts packages/activities/src/create-activities.test.ts packages/workflows/src/activities-api.ts
git commit -m "feat(activities): unlabelIssue + listManagedProjects"
```

---

### Task 3: Policies — scheduled agents target their own queue

**Files:**
- Modify: `packages/policies/src/reconcile-agents.ts`, `packages/policies/src/reconcile-agents.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// add to packages/policies/src/reconcile-agents.test.ts
import { ENGINE_QUEUE } from '@agentops/contracts';
it('re-points a scheduled Tier-2 agent to its own taskQueue', () => {
  const declared = [{ name: 'nightly', workflow: 'projectScan', schedule: '0 2 * * *', input: {}, enabled: true, timezone: 'UTC', overlap: 'skip' as const, taskQueue: 'proj-acme' }];
  const existing = [{ id: scheduleId('acme', 'nightly'), scheduleSpec: '0 2 * * *', workflow: 'projectScan', paused: false, taskQueue: ENGINE_QUEUE }];
  const plan = reconcileAgents(declared, existing, 'acme');
  expect(plan.toUpdate.map((s) => s.name)).toContain('nightly');
});
it('leaves a built-in scheduled agent on ENGINE_QUEUE (no taskQueue set)', () => {
  const declared = [{ name: 'nb', workflow: 'whiteboxBugHunt', schedule: '0 2 * * *', input: {}, enabled: true, timezone: 'UTC', overlap: 'skip' as const }];
  const existing = [{ id: scheduleId('acme', 'nb'), scheduleSpec: '0 2 * * *', workflow: 'whiteboxBugHunt', paused: false, taskQueue: ENGINE_QUEUE }];
  expect(reconcileAgents(declared, existing, 'acme').toUpdate).toHaveLength(0);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @agentops/policies test -- reconcile-agents`
Expected: FAIL — Tier-2 agent not re-pointed (diff uses fixed `ENGINE_QUEUE`).

- [ ] **Step 3: Implement**

In `reconcile-agents.ts`, replace the fixed `desiredQueue`:
```ts
const desiredQueue = spec.taskQueue ?? ENGINE_QUEUE;
if (cur.scheduleSpec !== spec.schedule || cur.workflow !== spec.workflow || (cur.taskQueue !== undefined && cur.taskQueue !== desiredQueue)) {
  plan.toUpdate.push(spec);
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @agentops/policies test && pnpm test:policies-coverage`
Expected: PASS (100% coverage).

- [ ] **Step 5: Commit**

```bash
git add packages/policies/src/reconcile-agents.ts packages/policies/src/reconcile-agents.test.ts
git commit -m "feat(policies): scheduled agents target spec.taskQueue ?? ENGINE_QUEUE"
```

---

### Task 4: Activities — `applyScheduleChanges` scheduled queue = `spec.taskQueue ?? ENGINE_QUEUE`

**Files:**
- Modify: `packages/activities/src/create-activities.ts`, `packages/activities/src/create-activities.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// add to packages/activities/src/create-activities.test.ts
it('applyScheduleChanges uses the agent taskQueue for a scheduled Tier-2 agent', async () => {
  const create = vi.fn().mockResolvedValue({});
  const acts = createActivities({ scheduleClient: { create, getHandle: () => ({}) } as any, taskQueue: 'agentops-engine', registry: [] } as any);
  const plan = { toCreate: [{ name: 'nightly', workflow: 'projectScan', schedule: '0 2 * * *', input: {}, enabled: true, timezone: 'UTC', overlap: 'skip', taskQueue: 'proj-acme' }], toUpdate: [], toDelete: [], toPause: [], toResume: [] };
  await acts.applyScheduleChanges('acme', 'acme/web', plan as any);
  expect(create.mock.calls[0][0].action.taskQueue).toBe('proj-acme');
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @agentops/activities test -- create-activities`
Expected: FAIL — action.taskQueue is `agentops-engine`, not `proj-acme`.

- [ ] **Step 3: Implement**

In `applyScheduleChanges`, inside the create/update loop, compute the per-spec queue instead of the single `tq`:
```ts
const actionQueue = spec.taskQueue ?? deps.taskQueue ?? ENGINE_QUEUE;
// use `actionQueue` in both the create() action and the update() action
```

- [ ] **Step 4: Run, verify pass + e2e**

Run: `pnpm --filter @agentops/activities test -- create-activities && pnpm e2e`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/activities/src/create-activities.ts packages/activities/src/create-activities.test.ts
git commit -m "fix(activities): scheduled agent action targets spec.taskQueue (Tier-2 cron)"
```

---

### Task 5: Workflows — `reconcileAllProjects`

**Files:**
- Create: `packages/workflows/src/reconcile-all-projects.ts` + `.test.ts`
- Modify: `packages/workflows/src/index.ts`

- [ ] **Step 1: Write failing test**

```ts
// packages/workflows/src/reconcile-all-projects.test.ts
import { describe, it, expect, vi } from 'vitest';
const executeChild = vi.fn().mockResolvedValue({});
const listManagedProjects = vi.fn().mockResolvedValue([{ project: 'a', repo: 'o/a' }, { project: 'b', repo: 'o/b' }]);
vi.mock('@temporalio/workflow', () => ({
  proxyActivities: () => ({ listManagedProjects }),
  executeChild,
}));
import { reconcileAllProjects } from './reconcile-all-projects';

describe('reconcileAllProjects', () => {
  it('reconciles each managed project via child configSync', async () => {
    await reconcileAllProjects();
    expect(listManagedProjects).toHaveBeenCalled();
    expect(executeChild).toHaveBeenCalledTimes(2);
    expect(executeChild).toHaveBeenCalledWith('configSync', expect.objectContaining({ args: [{ project: 'a', repo: 'o/a' }] }));
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @agentops/workflows test -- reconcile-all-projects`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// packages/workflows/src/reconcile-all-projects.ts
import { proxyActivities, executeChild } from '@temporalio/workflow';
import { ENGINE_QUEUE } from '@agentops/contracts';
import type { ConfigSyncActivities } from './activities-api';

const acts = proxyActivities<Pick<ConfigSyncActivities, 'listManagedProjects'>>({ startToCloseTimeout: '1 minute', retry: { maximumAttempts: 3 } });

// Periodic safety reconcile (SP3 §3.2): reconcile every managed project's
// agents.json into Temporal Schedules. Fired by the worker-ensured
// `reconcile:all` Schedule (~15 min); complements the push fast path.
export async function reconcileAllProjects(): Promise<{ reconciled: number }> {
  const projects = await acts.listManagedProjects();
  for (const p of projects) {
    await executeChild('configSync', {
      taskQueue: ENGINE_QUEUE,
      workflowId: `configsync:${p.project}`,
      args: [{ project: p.project, repo: p.repo }],
    });
  }
  return { reconciled: projects.length };
}
```

Add to `packages/workflows/src/index.ts`: `export * from './reconcile-all-projects';`

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @agentops/workflows test -- reconcile-all-projects`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/workflows/src/reconcile-all-projects.ts packages/workflows/src/reconcile-all-projects.test.ts packages/workflows/src/index.ts
git commit -m "feat(workflows): reconcileAllProjects (periodic reconcile fan-out)"
```

---

### Task 6: Workflows — `devCycle` `agent:working` label lifecycle

**Files:**
- Modify: `packages/workflows/src/dev-cycle.ts`, `packages/workflows/src/dev-cycle.test.ts` (or the e2e that drives an issue-linked run)

- [ ] **Step 1: Write failing test**

Add a `dev-cycle` unit test (mocking the proxied activities) asserting that, given `input.issueRef`, `labelIssue(issueRef, 'agent:working')` is called near the start and `unlabelIssue(issueRef, 'agent:working')` is called at PR open. Mirror the existing dev-cycle test's activity-mock setup.

```ts
it('stamps agent:working on start and drops it at PR open (issue-linked run)', async () => {
  // ... arrange mocked activities incl. labelIssue/unlabelIssue/openPr spies, input.issueRef set ...
  await devCycle({ taskId: 't', project: 'p', repo: 'o/r', issueRef: 'o/r#5', goal: 'fix', config });
  expect(labelIssue).toHaveBeenCalledWith('o/r#5', 'agent:working');
  expect(unlabelIssue).toHaveBeenCalledWith('o/r#5', 'agent:working');
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @agentops/workflows test -- dev-cycle`
Expected: FAIL — `unlabelIssue` never called / not proxied.

- [ ] **Step 3: Implement**

In `dev-cycle.ts`: after the issue is loaded (near line 150, guarded by `if (input.issueRef)`), add `await activities.labelIssue(input.issueRef, 'agent:working');`. At PR open (near line 354, after `openPr` succeeds), add `if (input.issueRef) await activities.unlabelIssue(input.issueRef, 'agent:working');`. Also drop it on a terminal non-PR exit (blocked/failed) so the label doesn't get stuck — wrap the drop in a small local helper called on both the PR path and the terminal path. `unlabelIssue` is already on `DevCycleActivities` (Task 2).

- [ ] **Step 4: Run, verify pass + e2e**

Run: `pnpm --filter @agentops/workflows test -- dev-cycle && pnpm e2e`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/workflows/src/dev-cycle.ts packages/workflows/src/dev-cycle.test.ts
git commit -m "feat(workflows): devCycle agent:working label lifecycle"
```

---

### Task 7: Gateway — `parseIssueTriggerEvent` (opened + labeled)

**Files:**
- Rename/replace: `packages/gateway/src/parse-issue-labeled.ts` → keep file, add `parseIssueTriggerEvent`; update `parse-issue-labeled.test.ts`
- Modify: `packages/gateway/src/create-gateway-server.ts` (call the new parser)

- [ ] **Step 1: Write failing test**

```ts
// add to packages/gateway/src/parse-issue-labeled.test.ts
import { parseIssueTriggerEvent } from './parse-issue-labeled';
const base = { repository: { full_name: 'o/r' }, issue: { number: 5, title: 'T' }, label: { name: 'agent:fix' } };
it('matches issues.opened carrying the trigger label', () => {
  expect(parseIssueTriggerEvent('issues', { ...base, action: 'opened', issue: { number: 5, title: 'T', labels: [{ name: 'agent:fix' }] } }, 'agent:fix')?.issueNumber).toBe(5);
});
it('still matches issues.labeled with the trigger label', () => {
  expect(parseIssueTriggerEvent('issues', { ...base, action: 'labeled' }, 'agent:fix')?.issueNumber).toBe(5);
});
it('ignores opened without the trigger label', () => {
  expect(parseIssueTriggerEvent('issues', { ...base, action: 'opened', issue: { number: 5, title: 'T', labels: [{ name: 'bug' }] } }, 'agent:fix')).toBeNull();
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @agentops/gateway test -- parse-issue`
Expected: FAIL — `parseIssueTriggerEvent` not exported.

- [ ] **Step 3: Implement**

Add `parseIssueTriggerEvent(githubEvent, payload, triggerLabel)` alongside the existing function. For `action === 'labeled'`, keep the current `label.name === triggerLabel` check. For `action === 'opened'`, match when the issue's `labels[]` contains `triggerLabel` (opened payloads carry `issue.labels`, not a top-level `label`). Return the same `IssueLabeledEvent` shape. Keep `parseIssueLabeledEvent` as a thin wrapper or delete it once callers move.

```ts
interface GithubIssuePayload {
  action?: string;
  label?: { name?: string };
  issue?: { number?: number; title?: string; labels?: Array<{ name?: string }> };
  repository?: { full_name?: string };
}
export function parseIssueTriggerEvent(githubEvent: string | undefined, payload: unknown, triggerLabel: string): IssueLabeledEvent | null {
  if (githubEvent !== 'issues') return null;
  const body = payload as GithubIssuePayload;
  const hasTrigger =
    (body.action === 'labeled' && body.label?.name === triggerLabel) ||
    (body.action === 'opened' && (body.issue?.labels ?? []).some((l) => l.name === triggerLabel));
  if (!hasTrigger) return null;
  const repo = body.repository?.full_name;
  const issueNumber = body.issue?.number;
  if (!repo || issueNumber === undefined) return null;
  return { repo, issueRef: `${repo}#${issueNumber}`, issueNumber, title: body.issue?.title ?? '' };
}
```

In `create-gateway-server.ts`, call `parseIssueTriggerEvent` instead of `parseIssueLabeledEvent`.

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @agentops/gateway test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/parse-issue-labeled.ts packages/gateway/src/parse-issue-labeled.test.ts packages/gateway/src/create-gateway-server.ts
git commit -m "fix(gateway): trigger on issues.opened carrying the label, not just labeled"
```

---

### Task 8: Gateway — fix-dedup id + `AllowDuplicateFailedOnly`

**Files:**
- Modify: `packages/gateway/src/start-dev-cycle.ts`, `packages/gateway/src/start-dev-cycle.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// add/adjust packages/gateway/src/start-dev-cycle.test.ts
it('uses devcycle:<project>:<issueNumber> and AllowDuplicateFailedOnly', async () => {
  const start = vi.fn().mockResolvedValue({});
  const client = { workflow: { start } } as any;
  await startDevCycleForIssue(client, 'agentops-engine', 'acme', { repo: 'acme/web', issueRef: 'acme/web#5', issueNumber: 5, title: 'T' }, {} as any);
  const opts = start.mock.calls[0][1];
  expect(opts.workflowId).toBe('devcycle:acme:5');
  expect(opts.workflowIdReusePolicy).toBe('ALLOW_DUPLICATE_FAILED_ONLY');
});
```

(Use the `WorkflowIdReusePolicy` enum value the SDK expects — import `WorkflowIdReusePolicy` from `@temporalio/client` and assert against its `ALLOW_DUPLICATE_FAILED_ONLY` member.)

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @agentops/gateway test -- start-dev-cycle`
Expected: FAIL — id is `issue-acme-5`, no reuse policy set.

- [ ] **Step 3: Implement**

In `start-dev-cycle.ts`: change `taskId` to `devcycle:${project}:${event.issueNumber}` and pass `workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY` to `client.workflow.start`. Keep the `WorkflowExecutionAlreadyStartedError → { started: false }` handling. (The `taskId` in the args can stay a stable per-issue string; only the `workflowId` convention + reuse policy change.)

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @agentops/gateway test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/start-dev-cycle.ts packages/gateway/src/start-dev-cycle.test.ts
git commit -m "feat(gateway): fix-dedup devcycle:<project>:<issueNumber> + AllowDuplicateFailedOnly"
```

---

### Task 9: Gateway — `push` handler → `configSync`

**Files:**
- Create: `packages/gateway/src/parse-push-event.ts` + `.test.ts`
- Create: `packages/gateway/src/start-config-sync.ts` + `.test.ts`
- Modify: `packages/gateway/src/create-gateway-server.ts`

- [ ] **Step 1: Write failing tests**

```ts
// parse-push-event.test.ts
import { parsePushEvent } from './parse-push-event';
it('extracts the repo from a push payload', () => {
  expect(parsePushEvent('push', { repository: { full_name: 'o/r' } })).toEqual({ repo: 'o/r' });
});
it('ignores non-push events', () => {
  expect(parsePushEvent('issues', { repository: { full_name: 'o/r' } })).toBeNull();
});
```
```ts
// start-config-sync.test.ts
import { startConfigSync } from './start-config-sync';
it('starts configSync with id configsync:<project> (deduped)', async () => {
  const start = vi.fn().mockResolvedValue({});
  await startConfigSync({ workflow: { start } } as any, 'agentops-engine', 'acme', 'acme/web');
  const opts = start.mock.calls[0][1];
  expect(opts.workflowId).toBe('configsync:acme');
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @agentops/gateway test -- parse-push start-config-sync`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

`parse-push-event.ts`: return `{ repo }` when `githubEvent === 'push'` and `repository.full_name` present, else `null`.

`start-config-sync.ts`:
```ts
import type { Client } from '@temporalio/client';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { configSync } from '@agentops/workflows';

export async function startConfigSync(client: Client, taskQueue: string, project: string, repo: string): Promise<{ started: boolean }> {
  try {
    await client.workflow.start(configSync, { taskQueue, workflowId: `configsync:${project}`, args: [{ project, repo }] });
    return { started: true };
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) return { started: false };
    throw err;
  }
}
```

In `create-gateway-server.ts` `handleGithubWebhook`, before the issue-trigger path, check `parsePushEvent`; if a push, resolve `repo → project` (`resolveManagedProjectEntry`) and call `startConfigSync` (on `deps.taskQueue`, i.e. `ENGINE_QUEUE`); respond 202/204. Unregistered repo → 202 ignore.

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @agentops/gateway test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/parse-push-event.ts packages/gateway/src/parse-push-event.test.ts packages/gateway/src/start-config-sync.ts packages/gateway/src/start-config-sync.test.ts packages/gateway/src/create-gateway-server.ts
git commit -m "feat(gateway): push webhook triggers configSync for the project"
```

---

### Task 10: Worker — ensure the `reconcile:all` periodic Schedule at startup

**Files:**
- Create: `packages/worker/src/ensure-reconcile-schedule.ts` + `.test.ts`
- Modify: `packages/worker/src/main.ts`

- [ ] **Step 1: Write failing test**

```ts
// ensure-reconcile-schedule.test.ts
import { ensureReconcileSchedule } from './ensure-reconcile-schedule';
it('creates the reconcile:all schedule if absent', async () => {
  const create = vi.fn().mockResolvedValue({});
  await ensureReconcileSchedule({ create, getHandle: () => ({}) } as any, 'agentops-engine');
  const opts = create.mock.calls[0][0];
  expect(opts.scheduleId).toBe('reconcile:all');
  expect(opts.action.workflowType).toBe('reconcileAllProjects');
  expect(opts.action.taskQueue).toBe('agentops-engine');
});
it('is idempotent when the schedule already exists', async () => {
  const create = vi.fn().mockRejectedValue(new Error('schedule already exists'));
  await expect(ensureReconcileSchedule({ create, getHandle: () => ({}) } as any, 'agentops-engine')).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @agentops/worker test -- ensure-reconcile-schedule`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// packages/worker/src/ensure-reconcile-schedule.ts
export interface ScheduleClientLike {
  create(opts: unknown): Promise<unknown>;
  getHandle(id: string): unknown;
}
// Periodic safety reconcile (SP3 §3.2). Ensured at boot, idempotently, like
// the search-attribute registration — a fresh env self-bootstraps the ~15-min
// drift/missed-webhook net with no manual step.
export async function ensureReconcileSchedule(schedule: ScheduleClientLike, engineQueue: string): Promise<void> {
  try {
    await schedule.create({
      scheduleId: 'reconcile:all',
      spec: { cron: { cronString: '*/15 * * * *', timezone: 'UTC' } },
      action: { type: 'startWorkflow', workflowType: 'reconcileAllProjects', args: [], taskQueue: engineQueue },
    });
  } catch (err) {
    if (!/already exist/i.test(err instanceof Error ? err.message : String(err))) throw err;
  }
}
```

In `main.ts`, after the schedule client is built (the same `try` that ensures search attributes), call `await ensureReconcileSchedule(tc.schedule as unknown as ScheduleClientLike, ENGINE_QUEUE)` with a warn-not-fatal wrapper.

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @agentops/worker test && pnpm --filter @agentops/worker typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/ensure-reconcile-schedule.ts packages/worker/src/ensure-reconcile-schedule.test.ts packages/worker/src/main.ts
git commit -m "feat(worker): ensure the reconcile:all periodic Schedule at startup"
```

---

### Task 11: Contracts — agent-schedule API shapes

**Files:**
- Create: `packages/contracts/src/control-agents-api.ts` + `.test.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: Write failing test**

```ts
// packages/contracts/src/control-agents-api.test.ts
import { AgentScheduleSummarySchema, ListAgentSchedulesResponseSchema, TriggerAgentResponseSchema } from './control-agents-api';
it('parses an agent schedule summary', () => {
  const s = AgentScheduleSummarySchema.parse({ scheduleId: 'agent:acme:nb', project: 'acme', agentName: 'nb', workflow: 'whiteboxBugHunt', cron: '0 2 * * *', paused: false });
  expect(s.project).toBe('acme');
});
it('parses list + trigger responses', () => {
  expect(ListAgentSchedulesResponseSchema.parse({ agents: [] }).agents).toEqual([]);
  expect(TriggerAgentResponseSchema.parse({ scheduleId: 'agent:acme:nb', triggered: true }).triggered).toBe(true);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @agentops/contracts test -- control-agents-api`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// packages/contracts/src/control-agents-api.ts
import { z } from 'zod';
export const AgentScheduleSummarySchema = z.object({
  scheduleId: z.string().min(1),
  project: z.string().min(1),
  agentName: z.string().min(1),
  workflow: z.string().min(1),
  cron: z.string().min(1),
  paused: z.boolean(),
  nextRun: z.string().optional(), // ISO timestamp when available
});
export type AgentScheduleSummary = z.infer<typeof AgentScheduleSummarySchema>;
export const ListAgentSchedulesResponseSchema = z.object({ agents: z.array(AgentScheduleSummarySchema) });
export type ListAgentSchedulesResponse = z.infer<typeof ListAgentSchedulesResponseSchema>;
export const TriggerAgentResponseSchema = z.object({ scheduleId: z.string().min(1), triggered: z.boolean() });
export type TriggerAgentResponse = z.infer<typeof TriggerAgentResponseSchema>;
```

Add to `packages/contracts/src/index.ts`: `export * from './control-agents-api';`

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @agentops/contracts test -- control-agents-api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/control-agents-api.ts packages/contracts/src/control-agents-api.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): agent-schedule list/trigger API shapes"
```

---

### Task 12: Control — list + trigger agent schedules

**Files:**
- Create: `packages/control/src/agents-routes.ts`
- Modify: `packages/control/src/create-control-server.ts` (dispatch + gating)
- Modify: `packages/control/src/create-control-server.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// add to packages/control/src/create-control-server.test.ts
it('GET /api/agents lists agent:* schedules (ungated)', async () => {
  const list = async function* () { yield { scheduleId: 'agent:acme:nb', memo: { project: 'acme', agentName: 'nb', workflowType: 'whiteboxBugHunt' }, schedule: { spec: { cron: { cronString: '0 2 * * *' } } }, info: { paused: false } }; yield { scheduleId: 'reconcile:all' }; };
  // ... build server with deps.client.schedule = { list, getHandle } ...
  const res = await get('/api/agents');
  expect(res.status).toBe(200);
  expect(res.body.agents).toHaveLength(1);
  expect(res.body.agents[0].project).toBe('acme');
});
it('POST /api/agents/:id/run triggers the schedule (gated: 401 without token)', async () => {
  const trigger = vi.fn().mockResolvedValue(undefined);
  // getHandle('agent:acme:nb') -> { trigger }; deps.projectCrudAuthToken set
  const unauth = await post('/api/agents/agent:acme:nb/run', {}, /* no token */);
  expect(unauth.status).toBe(401);
  const ok = await post('/api/agents/agent:acme:nb/run', {}, { 'x-control-crud-token': TOKEN });
  expect(ok.status).toBe(202);
  expect(trigger).toHaveBeenCalled();
});
```

(Match the test harness the existing control tests use to issue requests.)

- [ ] **Step 2: Run, verify fail**

Run: `pnpm --filter @agentops/control test -- create-control-server`
Expected: FAIL — routes 404.

- [ ] **Step 3: Implement**

`agents-routes.ts`:
```ts
import type { URL } from 'node:url';
import { AgentScheduleSummarySchema, ListAgentSchedulesResponseSchema, TriggerAgentResponseSchema } from '@agentops/contracts';
import type { ControlDeps } from './create-control-server';
import type { HandlerResponse } from './handler-util';

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function handleListAgents(deps: ControlDeps): Promise<HandlerResponse> {
  const agents: unknown[] = [];
  const lister = (deps.client.schedule as any).list?.bind(deps.client.schedule);
  if (lister) {
    for await (const s of lister()) {
      const id = (s as any).scheduleId as string | undefined;
      if (!id || !id.startsWith('agent:')) continue; // reconcile:all and others excluded
      const memo = (s as any).memo ?? {};
      const cron = (s as any)?.schedule?.spec?.cron?.cronString ?? (s as any)?.spec?.cron?.[0]?.cronString ?? '';
      agents.push(AgentScheduleSummarySchema.parse({
        scheduleId: id,
        project: memo.project ?? id.split(':')[1] ?? '',
        agentName: memo.agentName ?? id.split(':')[2] ?? '',
        workflow: memo.workflowType ?? '',
        cron,
        paused: Boolean((s as any)?.info?.paused),
      }));
    }
  }
  return { status: 200, body: ListAgentSchedulesResponseSchema.parse({ agents }) };
}

export async function handleTriggerAgent(deps: ControlDeps, scheduleId: string): Promise<HandlerResponse> {
  const handle = (deps.client.schedule as any).getHandle(scheduleId);
  try {
    await handle.trigger();
  } catch {
    return { status: 404, body: { error: `no schedule "${scheduleId}"` } };
  }
  return { status: 202, body: TriggerAgentResponseSchema.parse({ scheduleId, triggered: true }) };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
```

In `create-control-server.ts` `dispatch`, add:
```ts
if (req.method === 'GET' && pathname === '/api/agents') return handleListAgents(deps);
const agentRun = matchPath('/api/agents/:scheduleId/run', pathname);
if (req.method === 'POST' && agentRun) {
  if (!authorizeProjectCrud(deps, req)) return { status: 401, body: { error: 'unauthorized' } };
  return handleTriggerAgent(deps, agentRun.params.scheduleId);
}
```

(The `:scheduleId` contains colons, e.g. `agent:acme:nb`; `matchPath` decodes one segment, so the client must URL-encode the id. Note this in the UI client.)

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @agentops/control test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/control/src/agents-routes.ts packages/control/src/create-control-server.ts packages/control/src/create-control-server.test.ts
git commit -m "feat(control): GET /api/agents + gated POST /api/agents/:id/run (schedule.trigger)"
```

---

### Task 13: UI — "Agents" page (list + Run now)

**Files:**
- Modify: `packages/ui/src/api.ts` (add `listAgents`, `runAgent`)
- Create: `packages/ui/src/pages/Agents.tsx`
- Modify: `packages/ui/src/App.tsx` (route/nav)

- [ ] **Step 1: API client**

In `api.ts`, add `listAgents(): Promise<ListAgentSchedulesResponse>` (`GET /api/agents`) and `runAgent(scheduleId: string): Promise<void>` (`POST /api/agents/${encodeURIComponent(scheduleId)}/run` with the CRUD-token header the other mutating calls use). Reuse the existing fetch helper/error handling.

- [ ] **Step 2: Page**

`Agents.tsx`: fetch `listAgents()` on mount; render a table grouped by project — agent name, workflow, cron, paused badge, and a **Run now** button that calls `runAgent(scheduleId)` and shows a toast/inline result. Follow the existing pages' component conventions (look at the devcycle/runs page).

- [ ] **Step 3: Wire nav**

Add an "Agents" entry to `App.tsx`'s navigation/routes next to the existing pages.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @agentops/ui build` (and `pnpm --filter @agentops/ui typecheck` if defined). Expected: builds clean.
Then drive it with the **proofshot** skill against the control server serving the UI, exercising list + Run now.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/api.ts packages/ui/src/pages/Agents.tsx packages/ui/src/App.tsx
git commit -m "feat(ui): Agents page — list scheduled agents + Run now"
```

---

### Task 14: e2e — reconcile → UI-trigger; opened+agent:fix → deduped devCycle

**Files:**
- Create: `e2e/sp3-triggers.e2e.test.ts`

- [ ] **Step 1: Write the e2e**

Using `@temporalio/testing` + the stub backend + memory ports, cover: (a) a `configSync` reconcile creates an `agent:*` Schedule, then the control trigger path (`handleTriggerAgent`) calls `trigger()` and the built-in workflow starts; (b) an `issues.opened` payload carrying `agent:fix` drives exactly one `devCycle` (a redelivery with the same issue number does not start a second), with `agent:working` stamped then dropped. Mirror the existing e2e harness setup.

- [ ] **Step 2: Run, iterate to green**

Run: `pnpm e2e -- sp3-triggers`
Expected: FAIL first, then PASS after wiring.

- [ ] **Step 3: Full e2e**

Run: `pnpm e2e`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add e2e/sp3-triggers.e2e.test.ts
git commit -m "test(e2e): SP3 triggers — reconcile→trigger, opened+agent:fix→deduped devCycle"
```

---

### Task 15: Ship the change (PR + CI)

> REQUIRED SUB-SKILL: use the `shipping-changes` skill for the mechanics. This repo's automated Bugbot review is inactive (confirmed removed) — **skip the Bugbot step**; land on green CI + human review.

- [ ] **Step 1: Sync main**

```bash
git fetch origin && git rebase origin/main
```
Resolve conflicts; re-run the full suite after.

- [ ] **Step 2: Full local verification**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e && pnpm test:policies-coverage`
Expected: all green.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin HEAD
gh pr create --repo est1908-agentic-ops/agentops-engine --title "feat: SP3 — triggers (auto-fire reconcile/issue-fix) + run agents from control UI" --body "Implements docs/superpowers/specs/2026-07-12-custom-agent-workflows-sp3-design.md (#31 SP3). Push→reconcile + periodic reconcile:all; issues.opened+agent:fix triggering with fix-dedup + agent:working lifecycle; scheduled Tier-2 queue fix; GET /api/agents + gated POST .../run + UI Agents page. Deferred: workflowClosed/self-heal, cross-repo executeChild, qaProbe."
```

- [ ] **Step 4: Get CI green**

`gh pr checks --watch`; fix failures; push; repeat until green.

- [ ] **Step 5: Merge after human review.** Delete the branch.

---

## Self-Review

**Spec coverage** (SP3 design §):
- §3.1 push→reconcile → Task 9. §3.2 periodic reconcile → Tasks 5 (`reconcileAllProjects`) + 10 (`reconcile:all` Schedule). ✓
- §4 opened+labeled → Task 7; fix-dedup → Task 8; `agent:working` lifecycle → Tasks 1+2+6. ✓
- §5 scheduled Tier-2 queue → Tasks 3 (policy) + 4 (activity). ✓
- §6 run-from-UI → Tasks 11 (contracts) + 12 (control) + 13 (UI); both tiers via the Schedule's own queue (Tasks 3/4). ✓
- §8 testing → per-task unit tests + Task 14 e2e. ✓
- Deferred (D self-heal, E cross-repo, qaProbe) → correctly NOT tasked. ✓

**Placeholder scan:** test steps that say "minimal deps as existing tests" / "mirror the existing harness" point at concrete existing setup in the named test files, not blanks. All schema/handler/parser/workflow code is complete.

**Type consistency:** `removeLabel`/`unlabelIssue`, `listManagedProjects`, `reconcileAllProjects`, `parseIssueTriggerEvent`, `startConfigSync`, `parsePushEvent`, `ensureReconcileSchedule`, `AgentScheduleSummary`/`ListAgentSchedulesResponse`/`TriggerAgentResponse`, `handleListAgents`/`handleTriggerAgent`, `devcycle:<project>:<issueNumber>` are used consistently across tasks.

**Shipping task:** Task 15 (PR/CI); Bugbot skipped per repo state. ✓
