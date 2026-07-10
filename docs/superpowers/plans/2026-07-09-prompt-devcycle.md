# Prompt-Started DevCycle from the Console — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start a real `devCycle` run from the console (pick a registered project, type a prompt) with config resolved on the worker, so `control` never holds repo credentials.

**Architecture:** `TaskInput.config` becomes optional; `devCycle` resolves it via the existing `resolveRepoConfig` activity when absent, failing fast with a new `unregistered-repo` block reason for repos the worker doesn't know. `control` gains `POST/GET /api/devcycle/runs`, a run-detail route backed by the workflow's existing `state` query, and an ungated `GET /api/devcycle/targets` (identity only). The UI gains a target selector on the home form, a per-project Run shortcut, a merged recent-runs list, and a `DevCycleRunDetailPage`.

**Tech Stack:** TypeScript strict, zod (`packages/contracts`), Temporal TS SDK, plain `node:http` (`packages/control`), React+Vite (`packages/ui`), vitest (+ `@temporalio/testing` via the `e2e/` suite).

**Design spec:** `docs/superpowers/specs/2026-07-09-prompt-devcycle-design.md` — read it first.

## Global Constraints

- AGENTS.md hard rules apply to every task. Especially: `packages/workflows` may not do I/O, use `Date.now()`/`Math.random()`, or import from `activities`/`ports`/`backends` — all side effects via proxied activities. New data shapes get a zod schema in `packages/contracts` before use; no `any`; no structural duplication of a contract type.
- Every task ends green locally: `pnpm lint && pnpm typecheck && pnpm test`. Tasks touching `packages/workflows` or `e2e/` must also pass `pnpm e2e`.
- Conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`).
- **No new dependencies** — this feature uses only what's already installed.
- Stage/status names are fixed vocabulary. The one addition (`'unregistered-repo'` in `BlockReasonSchema`) is mandated by the design spec §5.
- Error convention in `control`: JSON `{"error": "..."}` on every 4xx/5xx.
- `packages/ui` has no automated tests by repo convention — it is verified by typecheck + the in-browser check in Task 7.

---

### Task 1: Contracts — `DevCycleStateSchema`, `unregistered-repo`, devcycle control API

**Files:**
- Create: `packages/contracts/src/dev-cycle-state.ts`
- Create: `packages/contracts/src/dev-cycle-state.test.ts`
- Create: `packages/contracts/src/control-devcycle-api.ts`
- Create: `packages/contracts/src/control-devcycle-api.test.ts`
- Modify: `packages/contracts/src/stage.ts` (BlockReasonSchema, lines 22-33)
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**
- Consumes: `StageSchema`, `TaskStatusSchema`, `BlockReasonSchema` from `./stage`; `RunStatusSchema` from `./control-api`.
- Produces (later tasks import these from `@agentops/contracts`): `DevCycleStateSchema` / `type DevCycleState`, `StartDevCycleRequestSchema` / `type StartDevCycleRequest { repo: string; prompt: string; taskId?: string }`, `StartDevCycleResponseSchema` / `type StartDevCycleResponse { workflowId: string; runId: string; taskId: string }`, `DevCycleRunDetailSchema` / `type DevCycleRunDetail`, `DevCycleTargetSchema` / `type DevCycleTarget { repo: string; project: string }`, `DevCycleTargetsResponseSchema`, and the `'unregistered-repo'` BlockReason value.

- [ ] **Step 1: Write the failing tests**

`packages/contracts/src/dev-cycle-state.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DevCycleStateSchema } from './dev-cycle-state';

const VALID = {
  taskId: 't-1',
  stage: 'context',
  status: 'running',
  blockReason: null,
  implementAttempts: 0,
  iterations: 0,
  cumulativeTokens: 0,
  babysitRounds: 0,
  prRef: null,
  workspaceRef: '',
  branch: '',
};

describe('DevCycleStateSchema', () => {
  it('accepts a fresh running state', () => {
    expect(DevCycleStateSchema.parse(VALID)).toEqual(VALID);
  });

  it('accepts the unregistered-repo fail-fast state', () => {
    const parsed = DevCycleStateSchema.parse({
      ...VALID,
      stage: 'failed',
      status: 'failed',
      blockReason: 'unregistered-repo',
    });
    expect(parsed.blockReason).toBe('unregistered-repo');
  });

  it('accepts a done state with a PR ref', () => {
    const parsed = DevCycleStateSchema.parse({ ...VALID, stage: 'done', status: 'done', prRef: 'pr-1' });
    expect(parsed.prRef).toBe('pr-1');
  });

  it('rejects an unknown stage', () => {
    expect(DevCycleStateSchema.safeParse({ ...VALID, stage: 'nope' }).success).toBe(false);
  });

  it('rejects a missing taskId', () => {
    const { taskId: _dropped, ...rest } = VALID;
    expect(DevCycleStateSchema.safeParse(rest).success).toBe(false);
  });
});
```

`packages/contracts/src/control-devcycle-api.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DevCycleRunDetailSchema,
  DevCycleTargetsResponseSchema,
  StartDevCycleRequestSchema,
  StartDevCycleResponseSchema,
} from './control-devcycle-api';

describe('StartDevCycleRequestSchema', () => {
  it('accepts repo + prompt, taskId optional', () => {
    expect(StartDevCycleRequestSchema.parse({ repo: 'acme/app', prompt: 'add a widget' })).toEqual({
      repo: 'acme/app',
      prompt: 'add a widget',
    });
    expect(
      StartDevCycleRequestSchema.parse({ repo: 'acme/app', prompt: 'x', taskId: 't-1' }).taskId,
    ).toBe('t-1');
  });

  it('rejects an empty prompt and a missing repo', () => {
    expect(StartDevCycleRequestSchema.safeParse({ repo: 'acme/app', prompt: '' }).success).toBe(false);
    expect(StartDevCycleRequestSchema.safeParse({ prompt: 'x' }).success).toBe(false);
  });
});

describe('StartDevCycleResponseSchema', () => {
  it('requires workflowId, runId, and taskId', () => {
    expect(
      StartDevCycleResponseSchema.parse({ workflowId: 'prompt-demo-t1', runId: 'r1', taskId: 't1' }).taskId,
    ).toBe('t1');
    expect(StartDevCycleResponseSchema.safeParse({ workflowId: 'w', runId: 'r' }).success).toBe(false);
  });
});

describe('DevCycleRunDetailSchema', () => {
  const BASE = {
    workflowId: 'prompt-demo-t1',
    runId: 'r1',
    status: 'RUNNING',
    temporalUrl: 'https://temporal.example/namespaces/default/workflows/prompt-demo-t1/r1/history',
  };

  it('accepts a bare running detail (no state yet)', () => {
    expect(DevCycleRunDetailSchema.parse(BASE).state).toBeUndefined();
  });

  it('accepts an embedded DevCycleState', () => {
    const detail = DevCycleRunDetailSchema.parse({
      ...BASE,
      status: 'COMPLETED',
      prompt: 'add a widget',
      state: {
        taskId: 't1',
        stage: 'done',
        status: 'done',
        blockReason: null,
        implementAttempts: 1,
        iterations: 1,
        cumulativeTokens: 42,
        babysitRounds: 1,
        prRef: 'pr-1',
        workspaceRef: 'ws-1',
        branch: 'task/t1',
      },
    });
    expect(detail.state?.prRef).toBe('pr-1');
  });

  it('rejects an unknown run status', () => {
    expect(DevCycleRunDetailSchema.safeParse({ ...BASE, status: 'BANANAS' }).success).toBe(false);
  });
});

describe('DevCycleTargetsResponseSchema', () => {
  it('accepts a list of repo/project pairs', () => {
    const parsed = DevCycleTargetsResponseSchema.parse({
      targets: [{ repo: 'acme/app', project: 'app' }],
    });
    expect(parsed.targets).toHaveLength(1);
  });

  it('rejects a target missing its project slug', () => {
    expect(DevCycleTargetsResponseSchema.safeParse({ targets: [{ repo: 'acme/app' }] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test packages/contracts/src/dev-cycle-state.test.ts packages/contracts/src/control-devcycle-api.test.ts`
Expected: FAIL — `Cannot find module './dev-cycle-state'` (and `'./control-devcycle-api'`).

- [ ] **Step 3: Implement the schemas**

Create `packages/contracts/src/dev-cycle-state.ts`:

```ts
import { z } from 'zod';
import { BlockReasonSchema, StageSchema, TaskStatusSchema } from './stage';

// The state the devCycle workflow maintains, exposes via its 'state' query,
// and returns as its result. Lives in contracts (not packages/workflows)
// because control reads it across a network boundary (AGENTS.md rule 3);
// packages/workflows re-exports the type for its existing importers.
export const DevCycleStateSchema = z.object({
  taskId: z.string().min(1),
  stage: StageSchema,
  status: TaskStatusSchema,
  blockReason: BlockReasonSchema.nullable(),
  implementAttempts: z.number().int().nonnegative(),
  iterations: z.number().int().nonnegative(),
  cumulativeTokens: z.number().int().nonnegative(),
  babysitRounds: z.number().int().nonnegative(),
  prRef: z.string().nullable(),
  workspaceRef: z.string(),
  branch: z.string(),
});
export type DevCycleState = z.infer<typeof DevCycleStateSchema>;
```

In `packages/contracts/src/stage.ts`, add one value to `BlockReasonSchema` (after `'budget-exceeded'`):

```ts
  // A prompt-started devCycle (no pre-resolved config) whose repo isn't in
  // the worker's merged static+managed registry -- set together with
  // status 'failed' as a fail-fast, not a resumable block (prompt-devcycle
  // design §5/§7).
  'unregistered-repo',
```

Create `packages/contracts/src/control-devcycle-api.ts`:

```ts
import { z } from 'zod';
import { RunStatusSchema } from './control-api';
import { DevCycleStateSchema } from './dev-cycle-state';

// List rows reuse RunListItemSchema from ./control-api -- it is already
// workflow-type-agnostic (workflowId, runId, status, startTime, closeTime?,
// promptSnippet?).

export const StartDevCycleRequestSchema = z.object({
  repo: z.string().min(1), // owner/repo -- must resolve to a registered project (422 otherwise)
  prompt: z.string().min(1), // becomes TaskInput.goal verbatim
  taskId: z.string().min(1).optional(), // default: randomUUID() in control
});
export type StartDevCycleRequest = z.infer<typeof StartDevCycleRequestSchema>;

export const StartDevCycleResponseSchema = z.object({
  workflowId: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().min(1),
});
export type StartDevCycleResponse = z.infer<typeof StartDevCycleResponseSchema>;

export const DevCycleRunDetailSchema = z.object({
  workflowId: z.string().min(1),
  runId: z.string().min(1),
  status: RunStatusSchema,
  prompt: z.string().min(1).optional(), // from the Temporal memo; absent for gateway/CLI-started runs
  state: DevCycleStateSchema.optional(), // live 'state' query while RUNNING, workflow result once COMPLETED
  error: z.string().min(1).optional(),
  temporalUrl: z.string().min(1),
});
export type DevCycleRunDetail = z.output<typeof DevCycleRunDetailSchema>;

export const DevCycleTargetSchema = z.object({
  repo: z.string().min(1),
  project: z.string().min(1),
});
export type DevCycleTarget = z.infer<typeof DevCycleTargetSchema>;

export const DevCycleTargetsResponseSchema = z.object({
  targets: z.array(DevCycleTargetSchema),
});
export type DevCycleTargetsResponse = z.infer<typeof DevCycleTargetsResponseSchema>;
```

In `packages/contracts/src/index.ts`, add (keep the existing order, insert after `export * from './task-input';`):

```ts
export * from './dev-cycle-state';
```

and after `export * from './control-api';`:

```ts
export * from './control-devcycle-api';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test packages/contracts`
Expected: PASS (new tests plus all existing contracts tests — the BlockReason addition is additive).

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean. Nothing imports the new modules yet.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): DevCycleState schema, unregistered-repo block reason, devcycle control API"
```

---

### Task 2: Workflows — in-workflow config resolution + fail-fast; `TaskInput.config` optional

**Files:**
- Modify: `packages/contracts/src/task-input.ts`
- Modify: `packages/contracts/src/task-input.test.ts`
- Modify: `packages/workflows/src/activities-api.ts`
- Modify: `packages/workflows/src/platform-activities-api.ts`
- Modify: `packages/workflows/src/dev-cycle.ts`
- Create: `e2e/prompt-devcycle.e2e.test.ts`

**Interfaces:**
- Consumes: `DevCycleState` + `'unregistered-repo'` from Task 1; the existing `resolveRepoConfig` implementation in `packages/activities/src/create-activities.ts` (already registered on the worker — no activities-package change needed).
- Produces: `TaskInputSchema.config` optional (callers may omit it); `DevCycleActivities.resolveRepoConfig(repo: string): Promise<RepoConfigResolution>` where `RepoConfigResolution = { registered: boolean; project: string; config: ProjectConfig }`; `devCycle` returns/queries the contracts `DevCycleState` (re-exported from `@agentops/workflows` so `e2e/helpers.ts` keeps compiling).

- [ ] **Step 1: Write the failing e2e test**

Create `e2e/prompt-devcycle.e2e.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { StubBackend } from '@agentops/backends';
import type { TaskInput } from '@agentops/contracts';
import { devCycle } from '@agentops/workflows';
import { buildTestEnv, teardownTestEnv, waitForStatus, type TestEnv } from './helpers';

describe('DevCycle e2e: prompt-started run resolves config in-workflow', () => {
  let testEnv: TestEnv | undefined;

  afterEach(async () => {
    await teardownTestEnv(testEnv);
  });

  it('resolves config on the worker for a registered repo and reaches done', async () => {
    // A worker-resolved config carries the FULL default routing
    // (parseProjectConfig merges DEFAULT_PROJECT_CONFIG), which sends
    // `implement` to the `pi` backend -- unlike existing e2e tests, whose
    // hand-passed `routing: {}` bypasses that merge. Register a stub as
    // `pi` so the implement stage has a backend to land on.
    const piStub = new StubBackend();
    testEnv = await buildTestEnv({
      registry: [
        { project: 'demo', repo: 'demo/repo', trackerType: 'github', tokenEnvVar: 'DEMO_TOKEN', token: 'test-token' },
      ],
      extraBackends: { pi: piStub },
    });
    const { env, worker, stub, scm, taskQueue } = testEnv;

    piStub.scriptResponse('implement', 1, { output: 'diff --git a/widget.ts b/widget.ts' });
    stub.scriptResponse('full_verify', 1, { output: 'FULL: PASS' });
    stub.scriptResponse('review', 1, { output: 'VERDICT: PASS' });
    scm.scriptFeedback('pr-1', [{ ciStatus: 'green', unresolvedThreads: 0, comments: [] }]);

    // No config on purpose: this is exactly what control sends.
    const input: TaskInput = {
      taskId: 'prompt-task-1',
      project: 'demo',
      repo: 'demo/repo',
      goal: 'Add a widget from a console prompt',
    };

    const finalState = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(devCycle, {
        taskQueue,
        workflowId: `prompt-demo-${input.taskId}`,
        args: [input],
      });
      await waitForStatus(handle, ['done', 'blocked', 'failed'], 30_000);
      return handle.result();
    });

    expect(finalState.status).toBe('done');
    expect(finalState.stage).toBe('done');
    expect(scm.getOpenedPrs()).toHaveLength(1);
  });

  it('fails fast with unregistered-repo when the worker does not know the repo', async () => {
    testEnv = await buildTestEnv(); // empty registry
    const { env, worker, taskQueue } = testEnv;

    const input: TaskInput = {
      taskId: 'prompt-task-2',
      project: 'default',
      repo: 'nobody/unknown',
      goal: 'Do something',
    };

    const finalState = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(devCycle, {
        taskQueue,
        workflowId: `prompt-default-${input.taskId}`,
        args: [input],
      });
      return handle.result();
    });

    expect(finalState.status).toBe('failed');
    expect(finalState.stage).toBe('failed');
    expect(finalState.blockReason).toBe('unregistered-repo');
    // Fail-fast happens before prepareWorkspace -- nothing was ever prepared.
    expect(finalState.workspaceRef).toBe('');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm e2e e2e/prompt-devcycle.e2e.test.ts`
Expected: FAIL — TypeScript error first (`config` is required on `TaskInput`). That compile error *is* the red state.

- [ ] **Step 3: Make `TaskInput.config` optional**

`packages/contracts/src/task-input.ts` — change one line:

```ts
export const TaskInputSchema = z.object({
  taskId: z.string().min(1),
  project: z.string().min(1),
  repo: z.string().min(1),
  issueRef: z.string().optional(),
  goal: z.string().min(1),
  // Optional since the prompt-devcycle design (2026-07-09): when absent, the
  // devCycle workflow resolves it on the worker via resolveRepoConfig.
  // Gateway/CLI/platform-children keep pre-resolving and passing it.
  config: ProjectConfigSchema.optional(),
});
```

Add to `packages/contracts/src/task-input.test.ts` (inside the existing describe block, matching its style):

```ts
it('accepts an input with no config (prompt-started run)', () => {
  const parsed = TaskInputSchema.parse({
    taskId: 't-1',
    project: 'demo',
    repo: 'demo/repo',
    goal: 'Add a widget',
  });
  expect(parsed.config).toBeUndefined();
});
```

- [ ] **Step 4: Add `resolveRepoConfig` to the devCycle activity surface**

`packages/workflows/src/activities-api.ts` — add `ProjectConfig` to the type import and define the shared resolution type + method:

```ts
import type { AgentRunRequest, AgentRunResult, PrFeedback, ProjectConfig, RunStats, StageResult } from '@agentops/contracts';
```

```ts
// Shared with PlatformActivities -- one declaration for the one activity
// implementation in packages/activities/src/create-activities.ts.
export interface RepoConfigResolution {
  registered: boolean;
  project: string;
  config: ProjectConfig;
}
```

and inside `DevCycleActivities` (after `runAgent`):

```ts
  resolveRepoConfig(repo: string): Promise<RepoConfigResolution>;
```

`packages/workflows/src/platform-activities-api.ts` — replace the whole file body with:

```ts
import type { AgentRunRequest, AgentRunResult, RunStats } from '@agentops/contracts';
import type { RepoConfigResolution } from './activities-api';

export interface PlatformActivities {
  runAgent(req: AgentRunRequest): Promise<AgentRunResult>;
  recordRunStats(stats: RunStats): Promise<void>;
  resolveRepoConfig(repo: string): Promise<RepoConfigResolution>;
  prepareScratchWorkspace(taskId: string): Promise<{ workspaceRef: string }>;
  cleanupScratchWorkspace(workspaceRef: string): Promise<void>;
}
```

(No change in `packages/activities` — `createActivities` already implements `resolveRepoConfig` and the worker already registers it.)

- [ ] **Step 5: Resolve config inside `devCycle`**

In `packages/workflows/src/dev-cycle.ts`:

a. Replace the local `DevCycleState` interface with the contracts type. Change the contracts type-import line to include `DevCycleState` and `ProjectConfig`:

```ts
import type { BlockReason, Brakes, DevCycleState, ModelRef, ProjectConfig, Routing, Stage, TaskInput, TaskStatus, VerdictKind } from '@agentops/contracts';
```

Delete the `export interface DevCycleState { ... }` block (lines 40-52) and add, next to the signal/query exports:

```ts
// Re-exported so existing importers (e2e/helpers.ts, control) keep resolving
// DevCycleState from @agentops/workflows; the schema lives in contracts.
export type { DevCycleState } from '@agentops/contracts';
```

(If `BlockReason`/`TaskStatus`/`Stage` become unused imports after this, remove them from the import list — lint will flag the exact ones.)

b. Change the `effectiveBrakes` declaration (line 98) from

```ts
  let effectiveBrakes: Brakes = { ...input.config.brakes };
```

to

```ts
  // Assigned right after config resolution below. Only the signal handlers
  // close over it before then, and none can meaningfully fire before the
  // first stage can possibly block.
  let effectiveBrakes: Brakes;
```

c. Immediately after `setHandler(stateQuery, () => state);` (line 124), insert:

```ts
  // Prompt-started runs (control BFF) pass no config -- resolve it here on
  // the worker, which holds the credential private key and the merged
  // static+managed registry (prompt-devcycle design §3/§5). Gateway, CLI,
  // and platform-children keep pre-resolving and passing config as before.
  let config: ProjectConfig;
  if (input.config) {
    config = input.config;
  } else {
    const resolved = await activities.resolveRepoConfig(input.repo);
    if (!resolved.registered) {
      // Repo unknown to this worker's registry -- e.g. registered in the
      // console after the worker last booted (design §7). Fail fast with an
      // explicit reason instead of crashing later in prepareWorkspace.
      state.stage = 'failed';
      state.status = 'failed';
      state.blockReason = 'unregistered-repo';
      return state;
    }
    config = resolved.config;
  }
  effectiveBrakes = { ...config.brakes };
```

d. Replace every remaining `input.config` reference in the file with `config`. As of the current file these are on lines 129 (`initCommands`), 154 (`routing[stage]`), 170 (`image`), 171 (`services`), 175 (`brakes.maxTokens` and `resolveStageLimits(input.config, stage)`), 243 (`preImplementStages({ config: input.config, ... })`), 270 (`escalation`), 281 (`fastVerifyCommands`/`fullVerifyCommands`), 306 (`escalation != null`). Verify none remain:

Run: `grep -n "input\.config" packages/workflows/src/dev-cycle.ts`
Expected: no output.

- [ ] **Step 6: Run the new e2e tests to verify they pass**

Run: `pnpm e2e e2e/prompt-devcycle.e2e.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Run the full gate**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e`
Expected: all green — existing e2e tests still pass because they all pass `config` explicitly.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts packages/workflows e2e/prompt-devcycle.e2e.test.ts
git commit -m "feat(workflows): resolve project config in-workflow for prompt-started devCycle runs"
```

---

### Task 3: Control — registry entries with project slugs

The start handler (Task 4) must map `repo → project` slug for static-registry repos, but `ControlDeps.registry` is bare `string[]`. Replace it with `{ project, repo }` pairs end-to-end.

**Files:**
- Create: `packages/control/src/read-registry-entries.ts` (replaces `read-registry-repos.ts` — delete it)
- Create: `packages/control/src/read-registry-entries.test.ts` (replaces `read-registry-repos.test.ts` — delete it)
- Modify: `packages/control/src/create-control-server.ts` (`ControlDeps`, `handleListRepos`)
- Modify: `packages/control/src/main.ts`
- Modify: `packages/control/src/create-control-server.test.ts` (deps fixture only)

**Interfaces:**
- Produces: `RegistryEntrySummary { project: string; repo: string }`, `readRegistryEntries(env?): RegistryEntrySummary[]`, `ControlDeps.registryEntries: RegistryEntrySummary[]` (field `registry: string[]` is removed). `GET /api/registry/repos` behavior is unchanged.

- [ ] **Step 1: Write the failing test**

Create `packages/control/src/read-registry-entries.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readRegistryEntries } from './read-registry-entries';

describe('readRegistryEntries', () => {
  it('returns [] when PROJECT_REGISTRY_JSON is unset', () => {
    expect(readRegistryEntries({})).toEqual([]);
  });

  it('returns project/repo pairs without touching token env vars', () => {
    const env = {
      PROJECT_REGISTRY_JSON: JSON.stringify([
        { project: 'demo', repo: 'demo/repo', trackerType: 'github', tokenEnvVar: 'DEMO_TOKEN' },
      ]),
    };
    expect(readRegistryEntries(env)).toEqual([{ project: 'demo', repo: 'demo/repo' }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test packages/control/src/read-registry-entries.test.ts`
Expected: FAIL — `Cannot find module './read-registry-entries'`.

- [ ] **Step 3: Implement**

Create `packages/control/src/read-registry-entries.ts`:

```ts
import { parseProjectRegistry } from '@agentops/contracts';

export interface RegistryEntrySummary {
  project: string;
  repo: string;
}

/**
 * Project/repo pairs from PROJECT_REGISTRY_JSON. Deliberately does not
 * resolve tokens the way @agentops/activities' loadProjectRegistry does --
 * control needs identity (hint-repos picker, devCycle target picker,
 * project-slug resolution at run start), never a credential, so it must not
 * require every registered repo's token env var to be set just to boot.
 */
export function readRegistryEntries(env: NodeJS.ProcessEnv = process.env): RegistryEntrySummary[] {
  const raw = env.PROJECT_REGISTRY_JSON;
  if (!raw) {
    return [];
  }
  return parseProjectRegistry(JSON.parse(raw)).map((entry) => ({ project: entry.project, repo: entry.repo }));
}
```

Delete `packages/control/src/read-registry-repos.ts` and `packages/control/src/read-registry-repos.test.ts`.

In `packages/control/src/create-control-server.ts`:
- Add the type import: `import type { RegistryEntrySummary } from './read-registry-entries';`
- In `ControlDeps`, replace `registry: string[];` with `registryEntries: RegistryEntrySummary[];`
- In `handleListRepos`, replace the body with:

```ts
  return { status: 200, body: RepoListResponseSchema.parse({ repos: deps.registryEntries.map((entry) => entry.repo) }) };
```

In `packages/control/src/main.ts`:
- Replace `import { readRegistryRepos } from './read-registry-repos';` with `import { readRegistryEntries } from './read-registry-entries';`
- Replace the `const registry = readRegistryRepos();` block with:

```ts
  const registryEntries = readRegistryEntries();
  console.log(
    registryEntries.length > 0
      ? `agentops control: ${registryEntries.length} repo(s) registered for the hint-repos picker`
      : 'agentops control: no PROJECT_REGISTRY_JSON set — hint-repos picker will offer no suggestions',
  );
```

- In the `createControlServer({...})` call, replace `registry,` with `registryEntries,`.

In `packages/control/src/create-control-server.test.ts`, update the deps fixture (`beforeEach`) — replace

```ts
      registry: ['flair-hr/agentops-engine', 'flair-hr/agentops-platform'],
```

with

```ts
      registryEntries: [
        { project: 'engine', repo: 'flair-hr/agentops-engine' },
        { project: 'platform', repo: 'flair-hr/agentops-platform' },
      ],
```

(The `GET /api/registry/repos` test's expected body is unchanged.)

- [ ] **Step 4: Run the control tests**

Run: `pnpm test packages/control`
Expected: PASS — all existing tests plus the new file.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/control
git commit -m "refactor(control): carry project slugs in the registry deps, not bare repo strings"
```

---

### Task 4: Control — devCycle run routes + targets

**Files:**
- Create: `packages/control/src/handler-util.ts` (shared `HandlerResponse`, `readJsonBody`, `truncate`, `memoPrompt`, `listRunsByType` — moved out of `create-control-server.ts`)
- Create: `packages/control/src/devcycle-routes.ts`
- Modify: `packages/control/src/create-control-server.ts` (import shared utils, delete local copies, dispatch 4 new routes)
- Modify: `packages/control/src/create-control-server.test.ts` (new describe blocks)

**Interfaces:**
- Consumes: Task 1 schemas; `ControlDeps.registryEntries` (Task 3); `devCycle` from `@agentops/workflows`; the workflow's `'state'` query (Task 2).
- Produces HTTP routes: `POST /api/devcycle/runs` (202 `StartDevCycleResponse`, 400/409/422), `GET /api/devcycle/runs?limit=` (200 `RunListItem[]`), `GET /api/devcycle/runs/:workflowId` (200 `DevCycleRunDetail`, 404), `GET /api/devcycle/targets` (200 `DevCycleTargetsResponse`). WorkflowId scheme: `prompt-<project>-<taskId>`.

- [ ] **Step 1: Extract the shared handler utilities**

Create `packages/control/src/handler-util.ts` by **moving** (not copying) `HandlerResponse`, `readJsonBody`, `truncate`, and `memoPrompt` out of `create-control-server.ts`, plus a generalized run-lister extracted from `handleListRuns`:

```ts
import type { IncomingMessage } from 'node:http';
import type { URL } from 'node:url';
import { RunListItemSchema } from '@agentops/contracts';
import type { ControlDeps } from './create-control-server';

export interface HandlerResponse {
  status: number;
  body?: unknown;
}

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function memoPrompt(memo: Record<string, unknown> | undefined): string | undefined {
  return typeof memo?.prompt === 'string' ? memo.prompt : undefined;
}

// One lister for every workflow type the console shows (platform, devCycle).
export async function listRunsByType(deps: ControlDeps, url: URL, workflowType: string): Promise<HandlerResponse> {
  const requestedLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 20;

  const executions: Array<{
    workflowId: string;
    runId: string;
    status: { name: string };
    startTime: Date;
    closeTime?: Date;
    memo?: Record<string, unknown>;
  }> = [];

  // Dev server visibility does not support ORDER BY — fetch matching runs and sort locally.
  for await (const execution of deps.client.workflow.list({ query: `WorkflowType="${workflowType}"` })) {
    executions.push(execution as (typeof executions)[number]);
  }

  executions.sort((a, b) => b.startTime.getTime() - a.startTime.getTime());

  const items: unknown[] = [];
  for (const execution of executions.slice(0, limit)) {
    const prompt = memoPrompt(execution.memo);
    const parsed = RunListItemSchema.safeParse({
      workflowId: execution.workflowId,
      runId: execution.runId,
      status: execution.status.name,
      startTime: execution.startTime.toISOString(),
      closeTime: execution.closeTime?.toISOString(),
      promptSnippet: prompt ? truncate(prompt, 120) : undefined,
    });
    if (parsed.success) {
      items.push(parsed.data);
    }
  }
  return { status: 200, body: items };
}
```

In `create-control-server.ts`: delete the moved definitions, add

```ts
import { listRunsByType, memoPrompt, readJsonBody, type HandlerResponse } from './handler-util';
```

and shrink `handleListRuns` to:

```ts
async function handleListRuns(deps: ControlDeps, url: URL): Promise<HandlerResponse> {
  return listRunsByType(deps, url, 'platform');
}
```

(`handler-util.ts` imports `ControlDeps` as a type-only import from `create-control-server.ts` — types are erased at runtime, so there is no runtime cycle.)

- [ ] **Step 2: Run the existing control tests to prove the extraction changed nothing**

Run: `pnpm test packages/control`
Expected: PASS, unchanged counts.

- [ ] **Step 3: Write the failing tests for the new routes**

Add to `packages/control/src/create-control-server.test.ts`. The devCycle route tests need a fake managed-project store; reuse the mocked-client style:

```ts
describe('devCycle routes', () => {
  function fakeStore(rows: Array<{ repo: string; project: string }>) {
    return {
      get: vi.fn(async (repo: string) => rows.find((row) => row.repo === repo) ?? null),
      list: vi.fn(async () => rows),
    } as never;
  }

  describe('POST /api/devcycle/runs', () => {
    it('rejects an empty prompt with 400', async () => {
      await listen();
      const { status } = await postJson(port, '/api/devcycle/runs', { repo: 'flair-hr/agentops-engine', prompt: '' });
      expect(status).toBe(400);
      expect(start).not.toHaveBeenCalled();
    });

    it('rejects an unknown repo with 422 without starting a workflow', async () => {
      await listen();
      const { status, body } = await postJson(port, '/api/devcycle/runs', { repo: 'nobody/unknown', prompt: 'x' });
      expect(status).toBe(422);
      expect((body as { error: string }).error).toContain('nobody/unknown');
      expect(start).not.toHaveBeenCalled();
    });

    it('starts devCycle with goal=prompt, no config, a prompt-<project>- workflowId, and the prompt memo', async () => {
      start.mockResolvedValue({ workflowId: 'prompt-engine-t1', firstExecutionRunId: 'run-1' });
      await listen();
      const { status, body } = await postJson(port, '/api/devcycle/runs', {
        repo: 'flair-hr/agentops-engine',
        prompt: 'add a widget',
        taskId: 't1',
      });

      expect(status).toBe(202);
      expect(body).toEqual({ workflowId: 'prompt-engine-t1', runId: 'run-1', taskId: 't1' });
      const [, options] = start.mock.calls[0];
      expect(options.workflowId).toBe('prompt-engine-t1');
      expect(options.args).toEqual([{ taskId: 't1', project: 'engine', repo: 'flair-hr/agentops-engine', goal: 'add a widget' }]);
      expect(options.memo).toEqual({ prompt: 'add a widget' });
    });

    it('resolves the project slug from the managed store ahead of the static registry', async () => {
      deps.managedProjectStore = fakeStore([{ repo: 'acme/app', project: 'acme-app' }]);
      start.mockResolvedValue({ workflowId: 'prompt-acme-app-t2', firstExecutionRunId: 'run-2' });
      await listen();
      const { status } = await postJson(port, '/api/devcycle/runs', { repo: 'acme/app', prompt: 'x', taskId: 't2' });
      expect(status).toBe(202);
      const [, options] = start.mock.calls[0];
      expect(options.args[0].project).toBe('acme-app');
    });

    it('responds 409 when the workflowId is already in use', async () => {
      start.mockRejectedValueOnce(new WorkflowExecutionAlreadyStartedError('already started', 'prompt-engine-dup', 'devCycle'));
      await listen();
      const { status } = await postJson(port, '/api/devcycle/runs', {
        repo: 'flair-hr/agentops-engine',
        prompt: 'x',
        taskId: 'dup',
      });
      expect(status).toBe(409);
    });
  });

  describe('GET /api/devcycle/runs', () => {
    it('lists devCycle executions with promptSnippet from memo', async () => {
      list.mockImplementation(async function* () {
        yield makeExecution({ workflowId: 'prompt-engine-t1', memo: { prompt: 'add a widget' } });
      });
      await listen();
      const { status, body } = await getJson(port, '/api/devcycle/runs');
      expect(status).toBe(200);
      const items = body as Array<{ workflowId: string; promptSnippet?: string }>;
      expect(items[0].workflowId).toBe('prompt-engine-t1');
      expect(items[0].promptSnippet).toBe('add a widget');
      expect(list).toHaveBeenCalledWith({ query: 'WorkflowType="devCycle"' });
    });
  });

  describe('GET /api/devcycle/runs/:workflowId', () => {
    const RUNNING_STATE = {
      taskId: 't1',
      stage: 'implement',
      status: 'running',
      blockReason: null,
      implementAttempts: 1,
      iterations: 1,
      cumulativeTokens: 1000,
      babysitRounds: 0,
      prRef: null,
      workspaceRef: 'ws-1',
      branch: 'task/t1',
    };

    it('returns live state from the state query while RUNNING', async () => {
      getHandle.mockReturnValue({
        describe: vi.fn().mockResolvedValue({ runId: 'run-1', status: { code: 1, name: 'RUNNING' }, memo: { prompt: 'add a widget' } } as never),
        query: vi.fn().mockResolvedValue(RUNNING_STATE),
        result: vi.fn(),
      });
      await listen();
      const { status, body } = await getJson(port, '/api/devcycle/runs/prompt-engine-t1');
      const detail = body as { status: string; prompt: string; state?: { stage: string } };
      expect(status).toBe(200);
      expect(detail.status).toBe('RUNNING');
      expect(detail.prompt).toBe('add a widget');
      expect(detail.state?.stage).toBe('implement');
    });

    it('falls back to a bare detail when the state query fails (run closed mid-request)', async () => {
      getHandle.mockReturnValue({
        describe: vi.fn().mockResolvedValue({ runId: 'run-1', status: { code: 1, name: 'RUNNING' }, memo: {} } as never),
        query: vi.fn().mockRejectedValue(new Error('workflow completed')),
        result: vi.fn(),
      });
      await listen();
      const { status, body } = await getJson(port, '/api/devcycle/runs/prompt-engine-t1');
      const detail = body as { state?: unknown; error?: string };
      expect(status).toBe(200);
      expect(detail.state).toBeUndefined();
      expect(detail.error).toBeUndefined();
    });

    it('returns the final state as `state` for a COMPLETED run', async () => {
      getHandle.mockReturnValue({
        describe: vi.fn().mockResolvedValue({ runId: 'run-1', status: { code: 2, name: 'COMPLETED' }, memo: {} } as never),
        query: vi.fn(),
        result: vi.fn().mockResolvedValue({ ...RUNNING_STATE, stage: 'done', status: 'done', prRef: 'pr-1' }),
      });
      await listen();
      const { body } = await getJson(port, '/api/devcycle/runs/prompt-engine-t1');
      const detail = body as { state?: { prRef: string | null }; error?: string };
      expect(detail.state?.prRef).toBe('pr-1');
      expect(detail.error).toBeUndefined();
    });

    it('sets error (not a 500) when a completed result fails DevCycleStateSchema', async () => {
      getHandle.mockReturnValue({
        describe: vi.fn().mockResolvedValue({ runId: 'run-1', status: { code: 2, name: 'COMPLETED' }, memo: {} } as never),
        query: vi.fn(),
        result: vi.fn().mockResolvedValue({ nope: true }),
      });
      await listen();
      const { status, body } = await getJson(port, '/api/devcycle/runs/prompt-engine-t1');
      const detail = body as { state?: unknown; error?: string };
      expect(status).toBe(200);
      expect(detail.state).toBeUndefined();
      expect(detail.error).toBeTruthy();
    });

    it('responds 404 when describe() throws', async () => {
      getHandle.mockReturnValue({ describe: vi.fn().mockRejectedValue(new Error('not found')), query: vi.fn(), result: vi.fn() });
      await listen();
      const { status } = await getJson(port, '/api/devcycle/runs/nope');
      expect(status).toBe(404);
    });
  });

  describe('GET /api/devcycle/targets', () => {
    it('returns static registry entries when no store is configured', async () => {
      await listen();
      const { status, body } = await getJson(port, '/api/devcycle/targets');
      expect(status).toBe(200);
      expect(body).toEqual({
        targets: [
          { repo: 'flair-hr/agentops-engine', project: 'engine' },
          { repo: 'flair-hr/agentops-platform', project: 'platform' },
        ],
      });
    });

    it('unions managed projects with static entries, managed winning on duplicate repo', async () => {
      deps.managedProjectStore = fakeStore([
        { repo: 'flair-hr/agentops-engine', project: 'engine-managed' },
        { repo: 'acme/app', project: 'acme-app' },
      ]);
      await listen();
      const { body } = await getJson(port, '/api/devcycle/targets');
      const { targets } = body as { targets: Array<{ repo: string; project: string }> };
      expect(targets).toContainEqual({ repo: 'acme/app', project: 'acme-app' });
      expect(targets).toContainEqual({ repo: 'flair-hr/agentops-engine', project: 'engine-managed' });
      expect(targets).toContainEqual({ repo: 'flair-hr/agentops-platform', project: 'platform' });
      expect(targets.filter((t) => t.repo === 'flair-hr/agentops-engine')).toHaveLength(1);
    });
  });
});
```

Note: the targets tests assume results sorted by project slug (`acme-app` < `engine-managed` < `platform`) — `toContainEqual` keeps them order-independent anyway.

- [ ] **Step 4: Run to verify the new tests fail**

Run: `pnpm test packages/control/src/create-control-server.test.ts`
Expected: FAIL — 404s for every `/api/devcycle/*` request (routes don't exist yet).

- [ ] **Step 5: Implement the routes**

Create `packages/control/src/devcycle-routes.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { URL } from 'node:url';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import {
  DevCycleRunDetailSchema,
  DevCycleStateSchema,
  DevCycleTargetsResponseSchema,
  StartDevCycleRequestSchema,
  StartDevCycleResponseSchema,
} from '@agentops/contracts';
import { devCycle } from '@agentops/workflows';
import type { ControlDeps } from './create-control-server';
import { listRunsByType, memoPrompt, readJsonBody, type HandlerResponse } from './handler-util';

// Managed store first (DB-registered projects take precedence, same order as
// the worker's registry merge), then the static PROJECT_REGISTRY_JSON entries.
async function resolveProjectSlug(deps: ControlDeps, repo: string): Promise<string | undefined> {
  if (deps.managedProjectStore) {
    const managed = await deps.managedProjectStore.get(repo);
    if (managed) {
      return managed.project;
    }
  }
  return deps.registryEntries.find((entry) => entry.repo === repo)?.project;
}

export async function handleStartDevCycleRun(deps: ControlDeps, req: IncomingMessage): Promise<HandlerResponse> {
  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: 'invalid JSON body' } };
  }
  const parsed = StartDevCycleRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues.map((issue) => issue.message).join('; ') } };
  }

  const { repo, prompt } = parsed.data;
  const project = await resolveProjectSlug(deps, repo);
  if (!project) {
    return { status: 422, body: { error: `repo "${repo}" is not a registered project` } };
  }

  const taskId = parsed.data.taskId ?? randomUUID();
  const workflowId = `prompt-${project}-${taskId}`;
  try {
    const handle = await deps.client.workflow.start(devCycle, {
      taskQueue: deps.taskQueue,
      workflowId,
      // No config on purpose: the workflow resolves it on the worker via
      // resolveRepoConfig -- control never holds repo credentials
      // (prompt-devcycle design §3).
      args: [{ taskId, project, repo, goal: prompt }],
      memo: { prompt },
    });
    return {
      status: 202,
      body: StartDevCycleResponseSchema.parse({ workflowId: handle.workflowId, runId: handle.firstExecutionRunId, taskId }),
    };
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) {
      return { status: 409, body: { error: `a run with workflowId "${workflowId}" already exists` } };
    }
    throw err;
  }
}

export async function handleListDevCycleRuns(deps: ControlDeps, url: URL): Promise<HandlerResponse> {
  return listRunsByType(deps, url, 'devCycle');
}

export async function handleGetDevCycleRun(deps: ControlDeps, workflowId: string): Promise<HandlerResponse> {
  const handle = deps.client.workflow.getHandle(workflowId);

  let description;
  try {
    description = await handle.describe();
  } catch {
    return { status: 404, body: { error: `no run found with workflowId "${workflowId}"` } };
  }

  const status = description.status.name;
  const prompt = memoPrompt(description.memo as Record<string, unknown> | undefined);
  const temporalUrl = `${deps.temporalUiBaseUrl}/namespaces/${deps.namespace}/workflows/${workflowId}/${description.runId}/history`;
  const base = { workflowId, runId: description.runId, status, prompt, temporalUrl };

  if (status === 'RUNNING') {
    try {
      const state = DevCycleStateSchema.parse(await handle.query('state'));
      return { status: 200, body: DevCycleRunDetailSchema.parse({ ...base, state }) };
    } catch {
      // The run may have closed between describe() and query(), or returned
      // an unexpected shape -- serve the bare status; the UI's next poll
      // sees the closed run.
      return { status: 200, body: DevCycleRunDetailSchema.parse(base) };
    }
  }

  if (status === 'COMPLETED') {
    try {
      const result = DevCycleStateSchema.safeParse(await handle.result());
      if (!result.success) {
        return {
          status: 200,
          body: DevCycleRunDetailSchema.parse({ ...base, error: 'run completed but its result did not match the expected shape' }),
        };
      }
      return { status: 200, body: DevCycleRunDetailSchema.parse({ ...base, state: result.data }) };
    } catch (err) {
      return {
        status: 200,
        body: DevCycleRunDetailSchema.parse({ ...base, error: err instanceof Error ? err.message : 'failed to fetch workflow result' }),
      };
    }
  }

  return { status: 200, body: DevCycleRunDetailSchema.parse({ ...base, error: `workflow ended with status ${status}` }) };
}

export async function handleListDevCycleTargets(deps: ControlDeps): Promise<HandlerResponse> {
  // Identity only (repo + project slug) -- never credentials or config, so
  // this is safe to serve ungated, exactly like /api/registry/repos. The
  // CRUD token keeps guarding everything that touches credentials.
  const managed = deps.managedProjectStore ? await deps.managedProjectStore.list() : [];
  const targets = managed.map((row) => ({ repo: row.repo, project: row.project }));
  for (const entry of deps.registryEntries) {
    if (!targets.some((target) => target.repo === entry.repo)) {
      targets.push({ repo: entry.repo, project: entry.project });
    }
  }
  targets.sort((a, b) => a.project.localeCompare(b.project));
  return { status: 200, body: DevCycleTargetsResponseSchema.parse({ targets }) };
}
```

In `create-control-server.ts`'s `dispatch()`, insert after the `/api/platform/runs/:workflowId` block and before `/api/registry/repos`:

```ts
  if (req.method === 'POST' && pathname === '/api/devcycle/runs') {
    return handleStartDevCycleRun(deps, req);
  }
  if (req.method === 'GET' && pathname === '/api/devcycle/runs') {
    return handleListDevCycleRuns(deps, url);
  }
  const devCycleRunMatch = matchPath('/api/devcycle/runs/:workflowId', pathname);
  if (req.method === 'GET' && devCycleRunMatch) {
    return handleGetDevCycleRun(deps, devCycleRunMatch.params.workflowId);
  }
  if (req.method === 'GET' && pathname === '/api/devcycle/targets') {
    return handleListDevCycleTargets(deps);
  }
```

with the import:

```ts
import {
  handleGetDevCycleRun,
  handleListDevCycleRuns,
  handleListDevCycleTargets,
  handleStartDevCycleRun,
} from './devcycle-routes';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test packages/control`
Expected: PASS — new devCycle-route tests and all pre-existing tests.

- [ ] **Step 7: Full gate**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/control
git commit -m "feat(control): start, list, and inspect devCycle runs; devcycle target list"
```

---

### Task 5: UI — API client, DevCycle run detail page, route

**Files:**
- Modify: `packages/ui/src/api.ts`
- Create: `packages/ui/src/pages/DevCycleRunDetailPage.tsx`
- Modify: `packages/ui/src/App.tsx`

**Interfaces:**
- Consumes: Task 4 routes; `DevCycleRunDetail`, `DevCycleTarget`, `StartDevCycleRequest/Response`, `RunListItem` from `@agentops/contracts`.
- Produces (Task 6 imports these from `../api`): `startDevCycleRun(input: StartDevCycleRequest): Promise<StartDevCycleResponse>`, `listDevCycleRuns(limit?): Promise<RunListItem[]>`, `getDevCycleRun(workflowId: string): Promise<DevCycleRunDetail>`, `listDevCycleTargets(): Promise<DevCycleTarget[]>`; route `/dev-runs/:workflowId`.

- [ ] **Step 1: Add the API client functions**

In `packages/ui/src/api.ts`, extend the `@agentops/contracts` import with `DevCycleRunDetailSchema`, `DevCycleTargetsResponseSchema`, `StartDevCycleResponseSchema`, and types `DevCycleRunDetail`, `DevCycleTarget`, `StartDevCycleRequest`, `StartDevCycleResponse`. Then add, after `listRepos`:

```ts
// --- devCycle runs (prompt-devcycle design §6/§8) ---

export async function startDevCycleRun(input: StartDevCycleRequest): Promise<StartDevCycleResponse> {
  const res = await fetch('/api/devcycle/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return parseJsonResponse(res, StartDevCycleResponseSchema);
}

export async function listDevCycleRuns(limit = 20): Promise<RunListItem[]> {
  const res = await fetch(`/api/devcycle/runs?limit=${limit}`);
  return parseJsonResponse(res, z.array(RunListItemSchema));
}

export async function getDevCycleRun(workflowId: string): Promise<DevCycleRunDetail> {
  const res = await fetch(`/api/devcycle/runs/${encodeURIComponent(workflowId)}`);
  return parseJsonResponse(res, DevCycleRunDetailSchema);
}

export async function listDevCycleTargets(): Promise<DevCycleTarget[]> {
  const res = await fetch('/api/devcycle/targets');
  const parsed = await parseJsonResponse(res, DevCycleTargetsResponseSchema);
  return parsed.targets;
}
```

- [ ] **Step 2: Create the detail page**

Create `packages/ui/src/pages/DevCycleRunDetailPage.tsx` (same poll-while-running pattern as `RunDetailPage.tsx`):

```tsx
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { DevCycleRunDetail } from '@agentops/contracts';
import { getDevCycleRun } from '../api';
import { StatusBadge } from '../components/StatusBadge';

const POLL_INTERVAL_MS = 3000;

const BLOCK_REASON_HINTS: Record<string, string> = {
  'unregistered-repo':
    'The worker does not know this repo. It may have been registered in the console after the worker last restarted — check the registration, or restart the worker so it reloads the managed registry.',
};

export function DevCycleRunDetailPage() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const [run, setRun] = useState<DevCycleRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!workflowId) {
      return undefined;
    }

    let cancelled = false;

    async function poll() {
      try {
        const detail = await getDevCycleRun(workflowId!);
        if (cancelled) {
          return;
        }
        setRun(detail);
        setError(null);
        if (detail.status !== 'RUNNING' && intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'failed to load run');
        }
      }
    }

    void poll();
    intervalRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [workflowId]);

  if (error) {
    return (
      <div className="page">
        <p className="error-text">{error}</p>
      </div>
    );
  }
  if (!run) {
    return (
      <div className="page">
        <p>Loading…</p>
      </div>
    );
  }

  const blockReasonHint = run.state?.blockReason ? BLOCK_REASON_HINTS[run.state.blockReason] : undefined;

  return (
    <div className="page">
      <a href="/" className="back-link">
        ← Back
      </a>
      <div className="run-header">
        <StatusBadge status={run.status} />
        <span className="run-id">{run.workflowId}</span>
        <a className="temporal-link" href={run.temporalUrl} target="_blank" rel="noreferrer">
          Open in Temporal ↗
        </a>
      </div>

      {run.prompt && (
        <div className="section">
          <div className="field-label">Prompt</div>
          <p className="prompt-text">{run.prompt}</p>
        </div>
      )}

      {run.error && (
        <div className="section error-box">
          <div className="field-label">Error</div>
          <p>{run.error}</p>
        </div>
      )}

      {run.state && (
        <div className="section">
          <div className="field-label">Dev cycle state</div>
          <table>
            <tbody>
              <tr>
                <th>Stage</th>
                <td>{run.state.stage}</td>
              </tr>
              <tr>
                <th>Task status</th>
                <td>{run.state.status}</td>
              </tr>
              {run.state.blockReason && (
                <tr>
                  <th>Block reason</th>
                  <td>
                    {run.state.blockReason}
                    {blockReasonHint && <p className="muted-text">{blockReasonHint}</p>}
                  </td>
                </tr>
              )}
              {run.state.prRef && (
                <tr>
                  <th>PR</th>
                  <td>{run.state.prRef}</td>
                </tr>
              )}
              <tr>
                <th>Implement attempts</th>
                <td>{run.state.implementAttempts}</td>
              </tr>
              <tr>
                <th>Babysit rounds</th>
                <td>{run.state.babysitRounds}</td>
              </tr>
              <tr>
                <th>Tokens</th>
                <td>{run.state.cumulativeTokens.toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Register the route**

In `packages/ui/src/App.tsx`, add the import and route:

```tsx
import { DevCycleRunDetailPage } from './pages/DevCycleRunDetailPage';
```

```tsx
        <Route path="/dev-runs/:workflowId" element={<DevCycleRunDetailPage />} />
```

(next to the existing `/runs/:workflowId` route).

- [ ] **Step 4: Verify it compiles**

Run: `pnpm typecheck && pnpm lint`
Expected: clean. (No UI unit tests by repo convention — browser verification happens in Task 7.)

- [ ] **Step 5: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): devCycle run detail page and API client"
```

---

### Task 6: UI — target selector on home, merged run list, Run shortcut on Projects

**Files:**
- Modify: `packages/ui/src/pages/HomePage.tsx` (full replacement below)
- Modify: `packages/ui/src/pages/ProjectsPage.tsx` (one Run link)

**Interfaces:**
- Consumes: Task 5's `startDevCycleRun`, `listDevCycleRuns`, `listDevCycleTargets`; existing `startRun`, `listRuns`, `listRepos`.
- Produces: home form starts either workflow type; `/?target=<repo>` pre-selects a project target (used by the Projects page Run link).

- [ ] **Step 1: Replace `packages/ui/src/pages/HomePage.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { DevCycleTarget, RunListItem } from '@agentops/contracts';
import { listDevCycleRuns, listDevCycleTargets, listRepos, listRuns, startDevCycleRun, startRun } from '../api';
import { StatusBadge } from '../components/StatusBadge';

const SUGGESTED_PROMPTS = [
  'Check recent failed workflows — anything strange?',
  'Investigate the last workflow failures and propose fixes',
  'Check cluster pod health in dev-agents',
];

const PLATFORM_TARGET = 'platform';

interface ConsoleRun {
  kind: 'platform' | 'devcycle';
  run: RunListItem;
}

export function HomePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [prompt, setPrompt] = useState('');
  const [target, setTarget] = useState(PLATFORM_TARGET);
  const [targets, setTargets] = useState<DevCycleTarget[]>([]);
  const [hintReposText, setHintReposText] = useState('');
  const [repoSuggestions, setRepoSuggestions] = useState<string[]>([]);
  const [runs, setRuns] = useState<ConsoleRun[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRepos()
      .then(setRepoSuggestions)
      .catch(() => setRepoSuggestions([]));
    listDevCycleTargets()
      .then(setTargets)
      .catch(() => setTargets([]));

    Promise.allSettled([listRuns(), listDevCycleRuns()])
      .then(([platformRuns, devcycleRuns]) => {
        const merged: ConsoleRun[] = [
          ...(platformRuns.status === 'fulfilled'
            ? platformRuns.value.map((run) => ({ kind: 'platform' as const, run }))
            : []),
          ...(devcycleRuns.status === 'fulfilled'
            ? devcycleRuns.value.map((run) => ({ kind: 'devcycle' as const, run }))
            : []),
        ];
        merged.sort((a, b) => new Date(b.run.startTime).getTime() - new Date(a.run.startTime).getTime());
        setRuns(merged);
      })
      .catch(() => setRuns([]));
  }, []);

  // /?target=<repo> (the Projects page's Run shortcut) pre-selects a project.
  useEffect(() => {
    const requested = searchParams.get('target');
    if (requested) {
      setTarget(requested);
    }
  }, [searchParams]);

  const isPlatformTarget = target === PLATFORM_TARGET;
  // The requested target may not be in the fetched list (yet, or at all) --
  // render it as an extra option so the select reflects the real state.
  const knownTarget = isPlatformTarget || targets.some((candidate) => candidate.repo === target);
  const canSubmit = prompt.trim().length > 0 && !submitting;

  async function handleRun() {
    setSubmitting(true);
    setError(null);
    try {
      if (isPlatformTarget) {
        const hintRepos = hintReposText
          .split(',')
          .map((repo) => repo.trim())
          .filter(Boolean);
        const { workflowId } = await startRun({
          prompt: prompt.trim(),
          hintRepos: hintRepos.length > 0 ? hintRepos : undefined,
        });
        navigate(`/runs/${workflowId}`);
      } else {
        const { workflowId } = await startDevCycleRun({ repo: target, prompt: prompt.trim() });
        navigate(`/dev-runs/${workflowId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to start run');
      setSubmitting(false);
    }
  }

  return (
    <div className="page">
      <h1>Platform Console</h1>

      <label className="field-label" htmlFor="target">
        Target
      </label>
      <select id="target" className="text-input" value={target} onChange={(event) => setTarget(event.target.value)}>
        <option value={PLATFORM_TARGET}>Platform agent</option>
        {targets.map((candidate) => (
          <option key={candidate.repo} value={candidate.repo}>
            {candidate.project} ({candidate.repo})
          </option>
        ))}
        {!knownTarget && <option value={target}>{target}</option>}
      </select>

      <label className="field-label" htmlFor="prompt">
        {isPlatformTarget ? 'What should the platform agent investigate?' : `What should the dev agent build in ${target}?`}
      </label>
      <textarea
        id="prompt"
        className="prompt-input"
        rows={4}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />

      {isPlatformTarget && (
        <>
          <div className="chip-row">
            {SUGGESTED_PROMPTS.map((suggestion) => (
              <button key={suggestion} type="button" className="chip" onClick={() => setPrompt(suggestion)}>
                {suggestion}
              </button>
            ))}
          </div>

          <label className="field-label" htmlFor="hint-repos">
            Hint repos (optional)
          </label>
          <input
            id="hint-repos"
            className="text-input"
            placeholder="owner/repo, owner/repo2"
            value={hintReposText}
            onChange={(event) => setHintReposText(event.target.value)}
            list="repo-suggestions"
          />
          <datalist id="repo-suggestions">
            {repoSuggestions.map((repo) => (
              <option key={repo} value={repo} />
            ))}
          </datalist>
        </>
      )}

      <div className="actions">
        <button type="button" className="run-button" disabled={!canSubmit} onClick={handleRun}>
          {submitting ? 'Starting…' : 'Run'}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}

      <h2>Recent runs</h2>
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Type</th>
            <th>Prompt</th>
            <th>Started</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {runs.map(({ kind, run }) => (
            <tr key={run.workflowId}>
              <td>
                <StatusBadge status={run.status} />
              </td>
              <td>{kind === 'platform' ? 'platform' : 'dev cycle'}</td>
              <td>{run.promptSnippet ?? run.workflowId}</td>
              <td>{new Date(run.startTime).toLocaleString()}</td>
              <td>
                <Link to={kind === 'platform' ? `/runs/${run.workflowId}` : `/dev-runs/${run.workflowId}`}>Open</Link>
              </td>
            </tr>
          ))}
          {runs.length === 0 && (
            <tr>
              <td colSpan={5}>No runs yet.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Add the Run shortcut to the Projects page**

In `packages/ui/src/pages/ProjectsPage.tsx`:
- Ensure `Link` is imported from `react-router-dom` (add it to the existing import, or add `import { Link } from 'react-router-dom';` if none exists).
- In the row-actions cell (`<td className="row-actions">`, currently holding the Edit/Remove buttons around line 219), insert as the **first** child:

```tsx
                <Link className="row-action" to={`/?target=${encodeURIComponent(project.repo)}`}>
                  Run
                </Link>
```

(match the exact className the Edit/Remove buttons use in that cell — if they use a different class such as `link-button`, use that instead so the three actions render uniformly).

- [ ] **Step 3: Verify it compiles**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/ui
git commit -m "feat(ui): start a devCycle from the console home and Projects page"
```

---

### Task 7: Docs sync, full gate, in-browser verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-09-prompt-devcycle-design.md` (two refinements discovered during planning)

**Interfaces:** none — verification and docs only.

- [ ] **Step 1: Sync the spec with two planning-time refinements**

In `docs/superpowers/specs/2026-07-09-prompt-devcycle-design.md`:

1. §4 (Contracts): after the `DevCycleRunDetailSchema` code block, add:

```markdown
Also added: `DevCycleTargetSchema` / `DevCycleTargetsResponseSchema` (`{ targets: {repo, project}[] }`) for the console's target picker, and a new `'unregistered-repo'` value in `BlockReasonSchema` — the fail-fast reason from §5 is machine-readable state, not free text.
```

2. §6 (control BFF) table: add one row:

```markdown
| `GET /api/devcycle/targets` | Union of managed projects and static-registry entries as `{repo, project}` pairs (managed wins on duplicate repo). Identity only — no credentials or config — so it is served ungated like `/api/registry/repos`; the CRUD token keeps guarding credential writes. Backs the home form's target selector. |
```

- [ ] **Step 2: Run the complete gate**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e`
Expected: all four green. This is the AGENTS.md definition of done — do not proceed on any failure.

- [ ] **Step 3: In-browser verification (stub worker, zero token spend)**

Four terminals:

```bash
temporal server start-dev                # 1: local Temporal
pnpm worker                              # 2: DEMO mode (no PROJECT_REGISTRY_JSON) — memory ports + stub backend
pnpm --filter @agentops/control dev      # 3: BFF on :3001 (set TEMPORAL_UI_BASE_URL=http://localhost:8233)
pnpm --filter @agentops/ui dev           # 4: Vite dev server, proxies /api → :3001
```

To give the console a pickable target without a database, set a static registry for **control only** (terminal 3):

```bash
PROJECT_REGISTRY_JSON='[{"project":"demo","repo":"demo/repo","trackerType":"github","tokenEnvVar":"DEMO_TOKEN"}]' \
TEMPORAL_UI_BASE_URL=http://localhost:8233 \
pnpm --filter @agentops/control dev
```

Verify in the browser (note: the DEMO-mode worker has an **empty** registry by design, so a started run exercises the fail-fast path — the happy path is covered by `e2e/prompt-devcycle.e2e.test.ts`, which drives the full pipeline against the stub backend):

1. Console home shows the **Target** selector with "Platform agent" and "demo (demo/repo)".
2. Pick the demo target — the platform-only chips and hint-repos input disappear; the prompt label changes.
3. Type a prompt, Run → lands on `/dev-runs/prompt-demo-<uuid>`, status badge live-polls to `COMPLETED`, and the state table shows stage `failed`, task status `failed`, block reason `unregistered-repo` **with the human hint text** — this is the designed fail-fast surfacing, rendered end-to-end.
4. Back on home: the run appears in Recent runs with type "dev cycle" and its prompt snippet; the Open link returns to the detail page.
5. Projects page: each row shows the Run action; clicking it lands on `/?target=<repo>` with the selector pre-filled.
6. `POST` an unknown repo directly to prove the 422 surfaces as a form error: pick "Platform agent", then in devtools run `fetch('/api/devcycle/runs', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({repo:'nobody/unknown', prompt:'x'})}).then(r => r.json()).then(console.log)` → `{error: 'repo "nobody/unknown" is not a registered project'}`.

- [ ] **Step 4: Commit the docs sync**

```bash
git add docs/superpowers/specs/2026-07-09-prompt-devcycle-design.md
git commit -m "docs: sync prompt-devcycle spec (targets endpoint, unregistered-repo block reason)"
```

---

## Self-Review Notes (kept for the record)

- **Spec coverage:** §4 contracts → Tasks 1-2; §5 workflow → Task 2; §6 BFF → Tasks 3-4; §7 failure modes → Task 2 (fail-fast) + Task 4 (422) + Task 5 (hint text); §8 UI → Tasks 5-6; §9 testing → each task's steps + Task 7 gate; §10 non-goals → nothing here builds signal actions, registry-refresh, gateway/CLI migration, or auth changes.
- **Type consistency:** `RepoConfigResolution` is declared once (Task 2, `activities-api.ts`) and reused by `platform-activities-api.ts`; `registryEntries: RegistryEntrySummary[]` (Task 3) is what Task 4's `resolveProjectSlug` and `handleListDevCycleTargets` read; `DevCycleState` is imported from contracts everywhere after Task 2.
- **Known judgment call:** `handle.query('state')` is called with the string name (validated by `DevCycleStateSchema.parse`) rather than importing `stateQuery` from `@agentops/workflows` — the zod parse at the boundary is the real safety net either way.
