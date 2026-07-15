# Shared PR Landing and Auto-Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one durable `prLanding` workflow that reviews, repairs, babysits, and directly merges AgentOps-created or explicitly enrolled PRs according to disabled-by-default project policy.

**Architecture:** Contracts and a pure policy define merge authority first. Provider-neutral SCM snapshot/merge operations close the exact-head race; `prLanding` becomes the sole worktree owner after `devCycle` handoff or prepares its own worktree for an existing PR. The gateway enrolls externally created PRs from signed label events, while deterministic workflow IDs prevent concurrent mutation owners.

**Tech Stack:** Node 22, TypeScript strict mode, pnpm workspaces, zod, Temporal TypeScript SDK, Octokit-compatible GitHub client, vitest, `@temporalio/testing`.

**Design authority:** `docs/superpowers/specs/2026-07-15-pr-landing-auto-merge-design.md` and the updated `docs/software-lifecycle-vision.md`.

---

## File map

- `packages/contracts/src/pr-landing.ts` — all cross-package landing, snapshot, merge, labels, state, and result schemas.
- `packages/contracts/src/project-config.ts` — the `autoMerge` project authority setting and disabled default.
- `packages/contracts/src/dev-cycle-state.ts` — parent-visible landing outcome.
- `packages/policies/src/merge-authority.ts` — pure label/mode/provenance authority decision.
- `packages/policies/src/pr-landing-id.ts` — deterministic provider-neutral landing workflow ID.
- `packages/ports/src/scm-port.ts` — provider-neutral snapshot and exact-head merge interface.
- `packages/ports/src/github/github-scm-port.ts` — GitHub snapshot aggregation and direct merge implementation.
- `packages/ports/src/memory/memory-scm.ts` — deterministic snapshot/merge scripting for tests and e2e.
- `packages/ports/src/github/project-scoped-ports.ts` — repository dispatch for the new SCM operations.
- `packages/activities/src/create-activities.ts` and `packages/workflows/src/activities-api.ts` — zod-validated activity boundary.
- `packages/activities/src/workspace/workspace-manager.ts` — exact PR checkout-ref support, including fork PR reads through the base repository's pull ref.
- `packages/workflows/src/pr-landing.ts` — exclusive worktree ownership, quality loop, babysitting, authority decision, exact-head merge, signals, query, and cleanup.
- `packages/workflows/src/dev-cycle.ts` — versioned handoff from the existing workflow to `prLanding`.
- `packages/workflows/src/dev-cycle-pr-repair.ts` — retained legacy workflow code for replay compatibility; no new starts after gateway migration.
- `packages/gateway/src/parse-pr-landing-event.ts` — strict parsing of enrollment and wake-up events.
- `packages/gateway/src/start-pr-landing.ts` — race-safe standalone start or signal.
- `packages/gateway/src/create-gateway-server.ts` — registered-project/config resolution and event routing.
- `e2e/pr-landing.e2e.test.ts` — real Temporal coverage for child handoff, external enrollment, veto, and direct merge.
- `README.md` and `docs/temporal-architecture.md` — operator configuration, webhook, and ownership documentation.

## Task 1: Define contracts and disabled-by-default configuration

**Files:**
- Create: `packages/contracts/src/pr-landing.ts`
- Create: `packages/contracts/src/pr-landing.test.ts`
- Modify: `packages/contracts/src/project-config.ts`
- Modify: `packages/contracts/src/project-config.test.ts`
- Modify: `packages/contracts/src/dev-cycle-state.ts`
- Modify: `packages/contracts/src/dev-cycle-state.test.ts`
- Modify: `packages/contracts/src/stage.ts`
- Modify: `packages/contracts/src/stage.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/workflows/src/dev-cycle.ts`
- Modify: `packages/workflows/src/dev-cycle-pr-repair.ts`

- [ ] **Step 1: Write failing contract tests**

Add tests that prove the default, strict modes, label constants, exact-head merge result variants, adopted/standalone inputs, and terminal outcomes:

```ts
import { describe, expect, it } from 'vitest';
import {
  AUTO_MERGE_DISABLE_LABEL,
  AUTO_MERGE_LABEL,
  MergePrResultSchema,
  PrLandingInputSchema,
  PrLandingStateSchema,
  PrSnapshotSchema,
} from './pr-landing';

describe('PR landing contracts', () => {
  it('uses stable machine labels', () => {
    expect(AUTO_MERGE_LABEL).toBe('automerge');
    expect(AUTO_MERGE_DISABLE_LABEL).toBe('automerge:disable');
  });

  it('accepts child handoff and standalone inputs', () => {
    const base = { taskId: 'landing-o-r-7', project: 'p', repo: 'o/r', prRef: 'o/r#7', agentCreated: true };
    expect(PrLandingInputSchema.safeParse({ ...base, workspace: { workspaceRef: '/ws/t', branch: 'agentops/t', validatedHeadSha: 'abc' } }).success).toBe(true);
    expect(PrLandingInputSchema.safeParse({ ...base, agentCreated: false, headBranch: 'feature/x' }).success).toBe(true);
  });

  it('requires exact typed snapshot and merge results', () => {
    expect(PrSnapshotSchema.parse({
      prRef: 'o/r#7', headSha: 'abc', headRepo: 'o/r', headBranch: 'feature/x', checkoutRef: 'refs/pull/7/head', labels: ['automerge'],
      state: 'open', draft: false, mergeable: true, mergedHeadSha: null,
      ciStatus: 'green', unresolvedThreads: 0, comments: [],
    }).headSha).toBe('abc');
    expect(MergePrResultSchema.parse({ kind: 'head-changed' }).kind).toBe('head-changed');
    expect(MergePrResultSchema.parse({ kind: 'merged', headSha: 'abc', mergeCommitSha: 'def' }).kind).toBe('merged');
  });

  it('represents manual and merged terminal outcomes', () => {
    const base = {
      taskId: 'landing-o-r-7', project: 'p', repo: 'o/r', phase: 'done', outcome: 'merge-ready-manual', blockReason: null,
      prRef: 'o/r#7', agentCreated: true, autoMergeMode: 'label', mergeResult: null,
      workspaceRef: '/ws/t', branch: 'feature/x', currentHeadSha: 'abc',
      validatedHeadSha: 'abc', implementAttempts: 0, iterations: 0, cumulativeTokens: 0, babysitRounds: 0,
    };
    expect(PrLandingStateSchema.parse(base).outcome).toBe('merge-ready-manual');
    expect(PrLandingStateSchema.parse({ ...base, outcome: 'merged' }).outcome).toBe('merged');
  });
});
```

Extend `project-config.test.ts` with:

```ts
it('defaults autoMerge to disabled and rejects unknown modes', () => {
  expect(parseProjectConfig({}).autoMerge).toBe('disabled');
  expect(parseProjectConfig({ autoMerge: 'label' }).autoMerge).toBe('label');
  expect(() => parseProjectConfig({ autoMerge: 'sometimes' })).toThrow(InvalidProjectConfigError);
});
```

- [ ] **Step 2: Run tests and confirm the contracts do not exist yet**

Run: `pnpm vitest run --config vitest.config.ts packages/contracts/src/pr-landing.test.ts packages/contracts/src/project-config.test.ts`

Expected: FAIL because `./pr-landing` and `autoMerge` are not defined.

- [ ] **Step 3: Implement the schemas and constants**

Create `pr-landing.ts` with these public shapes:

```ts
import { z } from 'zod';
import { CiStatusSchema, PrCommentSchema } from './pr-feedback';
import { AutoMergeModeSchema, ProjectConfigSchema } from './project-config';

export const AUTO_MERGE_LABEL = 'automerge';
export const AUTO_MERGE_DISABLE_LABEL = 'automerge:disable';
export const AGENTOPS_MANAGED_LABEL = 'agentops:managed';

export const PrSnapshotSchema = z.object({
  prRef: z.string().min(1),
  headSha: z.string().min(1),
  headRepo: z.string().min(1),
  headBranch: z.string().min(1),
  checkoutRef: z.string().min(1),
  labels: z.array(z.string()),
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  mergeable: z.boolean().nullable(),
  mergedHeadSha: z.string().min(1).nullable(),
  ciStatus: CiStatusSchema,
  unresolvedThreads: z.number().int().nonnegative(),
  comments: z.array(PrCommentSchema),
});
export type PrSnapshot = z.infer<typeof PrSnapshotSchema>;

export const MergePrRequestSchema = z.object({ prRef: z.string().min(1), expectedHeadSha: z.string().min(1) });
export type MergePrRequest = z.infer<typeof MergePrRequestSchema>;

export const MergePrResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('merged'), headSha: z.string().min(1), mergeCommitSha: z.string().min(1) }),
  z.object({ kind: z.literal('already-merged'), headSha: z.string().min(1) }),
  z.object({ kind: z.literal('head-changed') }),
  z.object({ kind: z.literal('not-mergeable'), reason: z.string().min(1) }),
  z.object({ kind: z.literal('forbidden'), reason: z.string().min(1) }),
]);
export type MergePrResult = z.infer<typeof MergePrResultSchema>;

export const PrLandingOutcomeSchema = z.enum(['merged', 'merge-ready-manual', 'blocked', 'failed', 'cancelled']);
export type PrLandingOutcome = z.infer<typeof PrLandingOutcomeSchema>;
export const PrLandingPhaseSchema = z.enum(['validating', 'repairing', 'babysitting', 'merging', 'blocked', 'done']);
export const PrLandingBlockReasonSchema = z.enum(['repair-brake', 'babysit-brake', 'provider-refused', 'permission-denied']);

export const PrLandingInputSchema = z.object({
  taskId: z.string().min(1), project: z.string().min(1), repo: z.string().min(1), prRef: z.string().min(1),
  agentCreated: z.boolean(), headBranch: z.string().min(1).optional(),
  workspace: z.object({ workspaceRef: z.string().min(1), branch: z.string().min(1), validatedHeadSha: z.string().min(1) }).optional(),
  config: ProjectConfigSchema.optional(),
});
export type PrLandingInput = z.infer<typeof PrLandingInputSchema>;

export const PrLandingStateSchema = z.object({
  taskId: z.string().min(1), project: z.string().min(1), repo: z.string().min(1),
  phase: PrLandingPhaseSchema, outcome: PrLandingOutcomeSchema.nullable(),
  blockReason: PrLandingBlockReasonSchema.nullable(), prRef: z.string().min(1),
  agentCreated: z.boolean(), autoMergeMode: AutoMergeModeSchema, mergeResult: MergePrResultSchema.nullable(),
  workspaceRef: z.string(), branch: z.string(),
  currentHeadSha: z.string().nullable(), validatedHeadSha: z.string().nullable(),
  implementAttempts: z.number().int().nonnegative(), iterations: z.number().int().nonnegative(),
  cumulativeTokens: z.number().int().nonnegative(), babysitRounds: z.number().int().nonnegative(),
});
export type PrLandingState = z.infer<typeof PrLandingStateSchema>;
```

Define and export `AutoMergeModeSchema = z.enum(['disabled', 'label', 'all'])` and its inferred type directly in `project-config.ts`, then add `autoMerge: AutoMergeModeSchema.optional()` to `ProjectConfigSchema` and `autoMerge: 'disabled'` to `DEFAULT_PROJECT_CONFIG`. Keeping the schema input optional preserves source compatibility for already-serialized `TaskInput.config` values and typed test fixtures; `parseProjectConfig` still materializes the disabled default, and workflow/gateway consumers defensively use `config.autoMerge ?? 'disabled'`. Keeping the mode beside `ProjectConfigSchema` also avoids a runtime import cycle between project configuration and landing input.

Export `pr-landing.ts` from `index.ts`, add `landingOutcome: PrLandingOutcomeSchema.nullable()` to `DevCycleStateSchema`, and add `'pr-landing-blocked'` deliberately to `BlockReasonSchema`. Initialize `landingOutcome` to `null` in both workflow state constructors and contract fixtures.

- [ ] **Step 4: Run contract tests and typecheck**

Run: `pnpm vitest run --config vitest.config.ts packages/contracts/src/pr-landing.test.ts packages/contracts/src/project-config.test.ts packages/contracts/src/dev-cycle-state.test.ts packages/contracts/src/stage.test.ts && pnpm --filter @agentops/contracts typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the contracts**

```bash
git add packages/contracts packages/workflows/src/dev-cycle.ts packages/workflows/src/dev-cycle-pr-repair.ts
git commit -m "feat(contracts): define PR landing and auto-merge policy"
```

## Task 2: Implement pure merge authority and workflow identity

**Files:**
- Create: `packages/policies/src/merge-authority.ts`
- Create: `packages/policies/src/merge-authority.test.ts`
- Create: `packages/policies/src/pr-landing-id.ts`
- Create: `packages/policies/src/pr-landing-id.test.ts`
- Modify: `packages/policies/src/index.ts`

Because this adds policy semantics, the PR description must state why the decision table is safe: disabled is the default, the veto always wins, and authority is re-evaluated from current labels immediately before merge.

- [ ] **Step 1: Write the exhaustive policy tests**

```ts
import { describe, expect, it } from 'vitest';
import type { AutoMergeMode } from '@agentops/contracts';
import { decideMergeAuthority } from './merge-authority';

describe('decideMergeAuthority', () => {
  const cases: Array<[AutoMergeMode, boolean, string[], 'merge' | 'manual']> = [
    ['disabled', true, [], 'manual'],
    ['disabled', true, ['automerge'], 'manual'],
    ['disabled', false, ['automerge'], 'manual'],
    ['label', true, [], 'manual'],
    ['label', true, ['automerge'], 'merge'],
    ['label', false, ['automerge'], 'merge'],
    ['all', true, [], 'merge'],
    ['all', false, [], 'manual'],
    ['all', false, ['automerge'], 'merge'],
    ['all', true, ['automerge:disable'], 'manual'],
    ['label', true, ['automerge', 'automerge:disable'], 'manual'],
  ];

  it.each(cases)('%s agentCreated=%s labels=%j -> %s', (mode, agentCreated, labels, expected) => {
    expect(decideMergeAuthority({ mode, agentCreated, labels })).toBe(expected);
  });
});
```

Test ID normalization separately:

```ts
expect(prLandingWorkflowId('Octo-Cat/Hello.World#42')).toBe('pr-landing-octo-cat-hello-world-42');
```

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm vitest run --config vitest.config.ts packages/policies/src/merge-authority.test.ts packages/policies/src/pr-landing-id.test.ts`

Expected: FAIL because both modules are absent.

- [ ] **Step 3: Implement the pure functions**

```ts
import { AUTO_MERGE_DISABLE_LABEL, AUTO_MERGE_LABEL, type AutoMergeMode } from '@agentops/contracts';

export function decideMergeAuthority(input: {
  mode: AutoMergeMode;
  agentCreated: boolean;
  labels: readonly string[];
}): 'merge' | 'manual' {
  const labels = new Set(input.labels);
  if (input.mode === 'disabled' || labels.has(AUTO_MERGE_DISABLE_LABEL)) return 'manual';
  if (labels.has(AUTO_MERGE_LABEL)) return 'merge';
  return input.mode === 'all' && input.agentCreated ? 'merge' : 'manual';
}
```

Implement `prLandingWorkflowId(prRef)` by lowercasing, replacing every non-alphanumeric run with `-`, trimming dashes, and prefixing `pr-landing-`. Export both modules from `packages/policies/src/index.ts`.

- [ ] **Step 4: Run the policy suite and coverage gate**

Run: `pnpm vitest run --config vitest.config.ts packages/policies/src/merge-authority.test.ts packages/policies/src/pr-landing-id.test.ts && pnpm test:policies-coverage`

Expected: PASS with exhaustive branches for `merge-authority.ts`.

- [ ] **Step 5: Commit the policy**

```bash
git add packages/policies
git commit -m "feat(policies): decide PR merge authority"
```

## Task 3: Add current-PR snapshot and exact-head merge ports

**Files:**
- Modify: `packages/ports/src/scm-port.ts`
- Modify: `packages/ports/src/github/github-client.ts`
- Modify: `packages/ports/src/github/github-scm-port.ts`
- Modify: `packages/ports/src/github/github-scm-port.test.ts`
- Modify: `packages/ports/src/memory/memory-scm.ts`
- Modify: `packages/ports/src/memory/memory-scm.test.ts`
- Modify: `packages/ports/src/github/project-scoped-ports.ts`
- Modify: `packages/ports/src/github/project-scoped-ports.test.ts`
- Modify: `packages/workflows/src/activities-api.ts`
- Modify: `packages/activities/src/create-activities.ts`
- Modify: `packages/activities/src/create-activities.test.ts`
- Modify: `packages/activities/src/workspace/workspace-manager.ts`
- Modify: `packages/activities/src/workspace/workspace-manager.test.ts`
- Modify: `packages/activities/src/workspace/memory-workspace-manager.ts`

- [ ] **Step 1: Write failing GitHub, memory, routing, and activity tests**

Cover these exact expectations:

```ts
expect(await scm.getPrSnapshot('octocat/hello-world#7')).toMatchObject({
  prRef: 'octocat/hello-world#7', headSha: 'abc123', headRepo: 'octocat/hello-world-fork',
  headBranch: 'feature/x', checkoutRef: 'refs/pull/7/head',
  labels: ['automerge'], state: 'open', draft: false, ciStatus: 'green', unresolvedThreads: 0,
});

await expect(scm.mergePr({ prRef: 'octocat/hello-world#7', expectedHeadSha: 'abc123' }))
  .resolves.toEqual({ kind: 'merged', headSha: 'abc123', mergeCommitSha: 'merge456' });
expect(client.rest.pulls.merge).toHaveBeenCalledWith({
  owner: 'octocat', repo: 'hello-world', pull_number: 7, sha: 'abc123',
});
```

Assert that no `merge_method` key is present. Add cases for `409 -> head-changed`, `403 -> forbidden`, `405 -> not-mergeable`, and `405` followed by a merged snapshot with the expected head -> `already-merged`. Assert 5xx errors are rethrown for Temporal retry.

For memory SCM, script snapshots and verify that merging a mismatched expected SHA returns `head-changed`, while a matching SHA records one `mergePr` operation and changes subsequent snapshots to `state: 'merged'`.

For project-scoped ports and activities, assert both calls route by the repository parsed from `prRef`, and that activity results pass `PrSnapshotSchema` / `MergePrResultSchema` parsing.

- [ ] **Step 2: Run focused tests and confirm interface failures**

Run: `pnpm vitest run --config vitest.config.ts packages/ports/src/github/github-scm-port.test.ts packages/ports/src/memory/memory-scm.test.ts packages/ports/src/github/project-scoped-ports.test.ts packages/activities/src/create-activities.test.ts`

Expected: FAIL because `ScmPort`, clients, and activities lack the two methods.

- [ ] **Step 3: Extend the provider-neutral interface and test double**

```ts
import type { MergePrRequest, MergePrResult, PrFeedback, PrSnapshot } from '@agentops/contracts';

export interface ScmPort {
  openPr(req: OpenPrRequest): Promise<OpenPrResult>;
  getPrFeedback(prRef: string): Promise<PrFeedback>;
  getPrSnapshot(prRef: string): Promise<PrSnapshot>;
  mergePr(req: MergePrRequest): Promise<MergePrResult>;
  push(repo: string, workspaceRef: string, branch: string, contentHash: string): Promise<void>;
  readFile(repo: string, path: string): Promise<string | null>;
}
```

Add snapshot queues and merge operations to `MemoryScmPort`. `openPr` seeds a default open snapshot with a stable synthetic head SHA, the opened branch, and labels. Keep both directions backward compatible: `getPrFeedback` projects feedback from a scripted snapshot when no legacy feedback queue exists, and `getPrSnapshot` overlays the next legacy feedback item on the seeded snapshot when no snapshot queue exists. Existing tests therefore keep their scripted feedback, while new landing tests can script exact head/label transitions.

- [ ] **Step 4: Implement GitHub snapshot aggregation and merge mapping**

Expand `GithubClient.rest.pulls.get` to include `head.sha`, `head.ref`, labels, state, draft, merged, mergeable, and `merge_commit_sha`; add `pulls.merge({ owner, repo, pull_number, sha })` returning `{ merged, message, sha }`.

Include `head.repo.full_name` in the client shape. Set `checkoutRef` with `` `refs/pull/${number}/head` ``, which GitHub exposes from the base repository even when the PR originates in a fork. This lets AgentOps verify a fork PR without pretending its branch exists on the base remote.

Refactor the existing CI and GraphQL thread reads into `getPrSnapshot`. Make `getPrFeedback` a projection of that snapshot. Implement merge without `merge_method`:

```ts
async mergePr(req: MergePrRequest): Promise<MergePrResult> {
  const { owner, repo, number } = parseRef(req.prRef);
  try {
    const { data } = await this.client.rest.pulls.merge({ owner, repo, pull_number: number, sha: req.expectedHeadSha });
    if (!data.merged) return { kind: 'not-mergeable', reason: data.message || 'GitHub refused merge' };
    return { kind: 'merged', headSha: req.expectedHeadSha, mergeCommitSha: data.sha };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 409) return { kind: 'head-changed' };
    if (status === 403) return { kind: 'forbidden', reason: err instanceof Error ? err.message : 'forbidden' };
    if (status === 405) {
      const snapshot = await this.getPrSnapshot(req.prRef);
      if (snapshot.state === 'merged' && snapshot.mergedHeadSha === req.expectedHeadSha) {
        return { kind: 'already-merged', headSha: req.expectedHeadSha };
      }
      return { kind: 'not-mergeable', reason: err instanceof Error ? err.message : 'not mergeable' };
    }
    throw err;
  }
}
```

- [ ] **Step 5: Wire and validate the activity boundary**

Add `getPrSnapshot` and `mergePr` to `DevCycleActivities`. In `createActivities`, assert project ownership, call the port, and parse returned values with the zod schemas before returning them. Route both operations in `createProjectScopedPorts`.

Extend `prepareWorkspace` with optional `headRef`. When present, `WorkspaceManager` must run `git fetch origin <headRef>` and create/reset the local worktree branch at `FETCH_HEAD`; it must not fall back to the base branch when that fetch fails. Add a regression test for `refs/pull/7/head`. Mirror the argument in `MemoryWorkspaceManager`.

- [ ] **Step 6: Run focused tests and package typechecks**

Run: `pnpm vitest run --config vitest.config.ts packages/ports/src/github/github-scm-port.test.ts packages/ports/src/memory/memory-scm.test.ts packages/ports/src/github/project-scoped-ports.test.ts packages/activities/src/create-activities.test.ts && pnpm --filter @agentops/ports typecheck && pnpm --filter @agentops/activities typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the SCM boundary**

```bash
git add packages/ports packages/activities packages/workflows/src/activities-api.ts
git commit -m "feat: add exact-head PR merge activities"
```

## Task 4: Build the sole-owner `prLanding` workflow

**Files:**
- Create: `packages/workflows/src/pr-landing.ts`
- Create: `packages/workflows/src/pr-landing.test.ts`
- Modify: `packages/workflows/src/index.ts`

- [ ] **Step 1: Write failing workflow tests for ownership and outcomes**

Mock Temporal activities in the same style as `dev-cycle.test.ts`. Add tests for:

```ts
it('adopts but does not prepare the parent workspace, then cleans it once', async () => {
  const result = await prLanding({
    taskId: 'landing-o-r-7', project: 'p', repo: 'o/r', prRef: 'o/r#7', agentCreated: true,
    workspace: { workspaceRef: '/ws/t', branch: 'agentops/t', validatedHeadSha: 'abc' },
    config: { ...baseConfig, autoMerge: 'disabled' },
  });
  expect(prepareWorkspace).not.toHaveBeenCalled();
  expect(cleanupWorkspace).toHaveBeenCalledTimes(1);
  expect(result.outcome).toBe('merge-ready-manual');
});

it('prepares an external PR workspace and runs verify plus review before merging', async () => {
  const result = await prLanding({
    taskId: 'landing-o-r-8', project: 'p', repo: 'o/r', prRef: 'o/r#8', agentCreated: false,
    headBranch: 'feature/x', config: { ...baseConfig, autoMerge: 'label' },
  });
  expect(prepareWorkspace).toHaveBeenCalledWith(expect.objectContaining({ headBranch: 'feature/x' }));
  expect(runAgent.mock.calls.map(([req]) => req.stage)).toEqual(['full_verify', 'review']);
  expect(result.outcome).toBe('merged');
});
```

Also test: veto wins immediately before merge; label removal yields manual; failed CI triggers implement then full verify and review; changed head revalidates; forbidden/not-mergeable block; `head-changed` loops; cancel cleans once; no-progress babysitting brakes.

- [ ] **Step 2: Run the workflow tests and confirm failure**

Run: `pnpm vitest run --config vitest.config.ts packages/workflows/src/pr-landing.test.ts`

Expected: FAIL because `prLanding` is absent.

- [ ] **Step 3: Implement state, signals, ownership, and cleanup**

Export `prLanding`, `prLandingStateQuery`, `prLandingWakeSignal`, `prLandingCancelSignal`, and `prLandingResumeSignal`. Use only Temporal workflow APIs and proxied activities.

Initialize state with `phase: 'validating'`, null outcome/reasons/SHAs, and zero counters. If `input.workspace` exists, adopt it; otherwise call `prepareWorkspace` with the current snapshot's head branch or `input.headBranch`. Track an `ownsWorkspace` boolean once a workspace is adopted or prepared, and put cleanup in one `finally` block:

```ts
const initialSnapshot = await activities.getPrSnapshot(input.prRef);
let ownsWorkspace = false;
try {
  if (input.workspace) {
    state.workspaceRef = input.workspace.workspaceRef;
    state.branch = input.workspace.branch;
    state.validatedHeadSha = input.workspace.validatedHeadSha;
  } else {
    const prepared = await activities.prepareWorkspace({
      taskId: input.taskId, repo: input.repo, initCommands: config.initCommands ?? [],
      headBranch: input.headBranch, headRef: initialSnapshot.checkoutRef,
    });
    state.workspaceRef = prepared.workspaceRef;
    state.branch = prepared.branch;
  }
  ownsWorkspace = true;
  return await land();
} finally {
  if (ownsWorkspace) await activities.cleanupWorkspace(state.workspaceRef, input.repo);
}
```

- [ ] **Step 4: Implement the complete quality and repair loop**

Use project routing/timeouts; do not hardcode the `smart` tier as the old repair workflow does. Implement the local stage runner before the loop:

```ts
async function runStageAgent(
  stage: 'implement' | 'full_verify' | 'review',
  attempt: number,
  promptContext: Record<string, unknown> = {},
): Promise<string> {
  const route = config.routing[stage];
  const limits = { maxTokens: config.brakes.maxTokens, ...resolveStageLimits(config, stage) };
  const result = await agentActivities.runAgent({
    taskId: input.taskId,
    repo: input.repo,
    project: input.project,
    stage,
    attempt,
    callIndex: 1,
    tier: route?.tier ?? (stage === 'implement' ? 'implementation' : stage === 'review' ? 'review' : 'smart'),
    effort: route?.effort,
    projectTiers: config.tiers,
    image: config.image,
    services: config.services ?? [],
    promptRef: `${stage}.md`,
    promptContext: { taskId: input.taskId, goal: `Land ${input.prRef}`, ...promptContext },
    workspaceRef: state.workspaceRef,
    limits,
  });
  state.cumulativeTokens += result.tokensIn + result.tokensOut;
  await activities.recordRunStats({
    taskId: input.taskId, stage, backend: result.resolvedBackend ?? 'unknown', model: result.resolvedModel ?? 'unknown',
    tokensIn: result.tokensIn, tokensOut: result.tokensOut, wallMs: result.wallMs, outcome: 'pass',
    promptHash: result.promptHash, promptSource: result.promptSource, project: input.project, workflowType: 'prLanding',
  });
  await activities.recordStageResult({
    taskId: input.taskId, stage, source: 'agent', contentHash: `${stage}-${attempt}-1`,
    tokens: result.tokensIn + result.tokensOut, outcome: 'pass',
  });
  return result.output;
}
```

Wrap `runAgent` in the existing budget-exceeded brake handling: set phase/block reason, wait for resume or cancel, and retry only after resume. The quality loop must follow this exact transition:

```ts
async function validateHead(initial: PrSnapshot, reviewFeedback = ''): Promise<'pass' | 'blocked'> {
  let snapshot = initial;
  let feedback = reviewFeedback;
  while (true) {
    state.phase = 'validating';
    state.currentHeadSha = snapshot.headSha;
    const fullOutput = await runStageAgent('full_verify', state.implementAttempts + 1, {
      verifyCommands: [...(config.fastVerifyCommands ?? []), ...(config.fullVerifyCommands ?? [])].join('\n'),
    });
    const fullVerdict = parseVerdict(fullOutput, 'FULL:');
    let reviewVerdict: 'pass' | 'fail' = 'fail';
    let reviewOutput = '';
    if (fullVerdict.kind === 'pass') {
      reviewOutput = await runStageAgent('review', state.implementAttempts + 1);
      reviewVerdict = parseVerdict(reviewOutput, 'VERDICT:').kind === 'pass' ? 'pass' : 'fail';
    }
    if (fullVerdict.kind === 'pass' && reviewVerdict === 'pass') {
      state.validatedHeadSha = snapshot.headSha;
      return 'pass';
    }

    const action = nextRepairAction({
      implementAttempts: state.implementAttempts,
      iterations: state.iterations,
      cumulativeTokens: state.cumulativeTokens,
      fullVerify: fullVerdict.kind === 'pass' ? 'pass' : 'fail',
      review: reviewVerdict,
      diffEmpty: false,
      brakes: config.brakes,
      hasEscalationModel: Boolean(config.escalation),
    });
    if (action.kind === 'block' || action.kind === 'open-pr-exhausted') {
      state.blockReason = 'repair-brake';
      return 'blocked';
    }

    if (snapshot.headRepo.toLowerCase() !== input.repo.toLowerCase()) {
      state.blockReason = 'provider-refused';
      return 'blocked';
    }

    state.phase = 'repairing';
    state.implementAttempts += 1;
    state.iterations += 1;
    feedback = [feedback, fullOutput, reviewOutput].filter(Boolean).join('\n\n---\n\n');
    await runStageAgent('implement', state.implementAttempts, { prReviewFeedback: feedback });
    await activities.pushBranch(input.repo, state.workspaceRef, state.branch, `${input.taskId}-${state.implementAttempts}`);
    snapshot = await activities.getPrSnapshot(input.prRef);
  }
}
```

Tests must assert repeated failure reaches configured brakes. After every implement/push, fetch the new snapshot and run both gates again.

The `land()` orchestration reads a snapshot before deciding whether inherited evidence is reusable:

```ts
let snapshot = await activities.getPrSnapshot(input.prRef);
state.currentHeadSha = snapshot.headSha;
if (state.validatedHeadSha !== snapshot.headSha) {
  state.validatedHeadSha = null;
  if (await validateHead(snapshot) === 'blocked') {
    if (state.blockReason === 'provider-refused') {
      state.phase = 'blocked'; state.outcome = 'blocked'; return state;
    }
    await waitAtBrake('repair-brake');
  }
  snapshot = await activities.getPrSnapshot(input.prRef);
}
return babysitAndMerge(snapshot);
```

`waitAtBrake` sets `phase: 'blocked'`, leaves `outcome` null, and waits on a Temporal condition for resume or cancel. Resume clears the brake and lifts the applicable configured cap for this execution; cancel returns the terminal `cancelled` outcome. Structural provider refusal, by contrast, returns terminal `blocked`.

- [ ] **Step 5: Implement babysitting, fresh authority evaluation, and exact merge**

Use `babysitDecision` with the current configured caps. A wake signal resets the timer but never substitutes for a fresh snapshot. When feedback is actionable, collect unresolved comment bodies, repair, push, and return through `validateHead`.

On merge-ready feedback:

```ts
const fresh = await activities.getPrSnapshot(input.prRef);
state.currentHeadSha = fresh.headSha;
if (fresh.state === 'merged' && fresh.mergedHeadSha === state.validatedHeadSha) {
  state.phase = 'done'; state.outcome = 'merged'; return state;
}
if (fresh.state !== 'open' || fresh.draft || fresh.headSha !== state.validatedHeadSha) {
  state.validatedHeadSha = null;
  continue;
}

if (decideMergeAuthority({ mode: config.autoMerge ?? 'disabled', agentCreated: input.agentCreated, labels: fresh.labels }) === 'manual') {
  state.phase = 'done';
  state.outcome = 'merge-ready-manual';
  return state;
}

state.phase = 'merging';
const merge = await activities.mergePr({ prRef: input.prRef, expectedHeadSha: fresh.headSha });
state.mergeResult = merge;
if (merge.kind === 'merged' || merge.kind === 'already-merged') {
  state.phase = 'done'; state.outcome = 'merged'; return state;
}
if (merge.kind === 'head-changed') { state.validatedHeadSha = null; continue; }
state.phase = 'blocked';
state.outcome = 'blocked';
state.blockReason = merge.kind === 'forbidden' ? 'permission-denied' : 'provider-refused';
return state;
```

- [ ] **Step 6: Run workflow tests and typecheck**

Run: `pnpm vitest run --config vitest.config.ts packages/workflows/src/pr-landing.test.ts && pnpm --filter @agentops/workflows typecheck`

Expected: PASS, with every pushed repair followed by `full_verify` and `review` calls.

- [ ] **Step 7: Commit the landing workflow**

```bash
git add packages/workflows/src/pr-landing.ts packages/workflows/src/pr-landing.test.ts packages/workflows/src/index.ts
git commit -m "feat(workflows): add shared PR landing workflow"
```

## Task 5: Hand `devCycle` PRs to the child safely

**Files:**
- Modify: `packages/workflows/src/dev-cycle.ts`
- Modify: `packages/workflows/src/dev-cycle.test.ts`
- Modify: `packages/workflows/src/dev-cycle-pr-repair.ts`
- Modify: `packages/workflows/src/dev-cycle-pr-repair.test.ts`

- [ ] **Step 1: Write failing handoff and label tests**

Assert that `openPr` always receives `agentops:managed` once, while retaining issue labels. Assert that the new path reads the opened PR snapshot, starts a child with `workspaceRef`, branch, and validated SHA, awaits it, does not run the legacy babysit loop, and does not clean the workspace in the parent.

```ts
expect(openPr).toHaveBeenCalledWith(expect.objectContaining({
  labels: ['agentops', 'bug', 'agentops:managed'],
}));
expect(startChild).toHaveBeenCalledWith(prLanding, expect.objectContaining({
  workflowId: 'pr-landing-pr-1',
  args: [expect.objectContaining({
    agentCreated: true,
    workspace: { workspaceRef: 'ws', branch: 'br', validatedHeadSha: 'abc' },
  })],
}));
expect(cleanupWorkspace).not.toHaveBeenCalled();
```

Add result mapping cases: `merged` and `merge-ready-manual` produce parent `done`; child `blocked` produces parent `blocked`; child `failed` or `cancelled` produces parent `failed`. Assert `landingOutcome` is exposed.

- [ ] **Step 2: Run tests and verify the old embedded loop fails expectations**

Run: `pnpm vitest run --config vitest.config.ts packages/workflows/src/dev-cycle.test.ts packages/workflows/src/dev-cycle-pr-repair.test.ts`

Expected: FAIL because the parent still owns babysitting and cleanup.

- [ ] **Step 3: Add a replay-safe version gate and child handoff**

Import `patched` and `startChild` from `@temporalio/workflow`. Keep the current babysit code behind the false branch of a stable patch marker so histories started before deployment remain replayable:

```ts
if (patched('shared-pr-landing-v1')) {
  const snapshot = await activities.getPrSnapshot(prRef);
  const handle = await startChild(prLanding, {
    workflowId: prLandingWorkflowId(prRef),
    args: [{
      taskId: `landing-${input.taskId}`, project: input.project, repo: input.repo, prRef,
      agentCreated: true, config,
      workspace: { workspaceRef: state.workspaceRef, branch: state.branch, validatedHeadSha: snapshot.headSha },
    }],
  });
  const landing = await handle.result();
  state.landingOutcome = landing.outcome;
  if (landing.outcome === 'blocked') {
    state.stage = 'pr_babysit'; state.status = 'blocked'; state.blockReason = 'pr-landing-blocked';
  } else if (landing.outcome === 'failed' || landing.outcome === 'cancelled') {
    state.stage = 'failed'; state.status = 'failed';
  } else {
    state.stage = 'done'; state.status = 'done';
  }
  return state;
}
```

Do not call parent cleanup after the handoff. Before handoff failures still clean in the parent. Forward parent cancel/resume signals to the live child handle; keep legacy signal behavior in the unpatched branch.

Build PR labels with a `Set`, always adding `AGENTOPS_MANAGED_LABEL`.

- [ ] **Step 4: Preserve old repair histories without starting new ones**

Do not rewrite the body of `devCyclePrRepair`; existing Temporal histories may still replay it. Add a deprecation comment and keep its tests green. Gateway migration in Task 6 removes new starts.

- [ ] **Step 5: Run unit tests and a replay test**

Add unit coverage with `patched('shared-pr-landing-v1')` mocked both `false` and `true`: false must execute the untouched legacy babysit/cleanup path, while true must execute only the child handoff. Then run:

`pnpm vitest run --config vitest.config.ts packages/workflows/src/dev-cycle.test.ts packages/workflows/src/dev-cycle-pr-repair.test.ts packages/workflows/src/pr-landing.test.ts && pnpm --filter @agentops/workflows typecheck`

Expected: PASS with no nondeterminism failure.

- [ ] **Step 6: Commit the handoff**

```bash
git add packages/workflows
git commit -m "refactor(workflows): hand PR ownership to landing child"
```

## Task 6: Enroll and wake PR landing from the gateway

**Files:**
- Create: `packages/gateway/src/parse-pr-landing-event.ts`
- Create: `packages/gateway/src/parse-pr-landing-event.test.ts`
- Create: `packages/gateway/src/start-pr-landing.ts`
- Create: `packages/gateway/src/start-pr-landing.test.ts`
- Modify: `packages/gateway/src/create-gateway-server.ts`
- Modify: `packages/gateway/src/create-gateway-server.test.ts`
- Retain but stop importing: `packages/gateway/src/start-dev-cycle-pr-repair.ts`
- Retain: `packages/gateway/src/parse-pr-review-event.ts`

- [ ] **Step 1: Write parser and starter tests**

The parser must accept:

- `pull_request/labeled` for `automerge` as `enroll`;
- `pull_request/labeled` for `automerge:disable` as `wake`;
- `pull_request/unlabeled` for either label as `wake`;
- `pull_request_review/submitted` as `wake` only when current labels contain `agentops:managed` or `automerge`.

It must return `repo`, `prRef`, `headBranch`, current labels, and `managed`. All other actions return `null`.

Starter tests must prove: completed workflow IDs can start a new run only for a new `enroll` event; an already-running ID is signalled instead of duplicated; all `wake` events are signal-only and never revive a completed run; external enrollment passes `agentCreated: false`.

- [ ] **Step 2: Run tests and confirm missing modules**

Run: `pnpm vitest run --config vitest.config.ts packages/gateway/src/parse-pr-landing-event.test.ts packages/gateway/src/start-pr-landing.test.ts packages/gateway/src/create-gateway-server.test.ts`

Expected: FAIL because the new parser/starter do not exist.

- [ ] **Step 3: Implement strict event parsing**

Use a discriminated result:

```ts
export type PrLandingEvent = {
  kind: 'enroll' | 'wake'; repo: string; prRef: string; headBranch: string;
  labels: string[]; managed: boolean;
};
```

Read `payload.label.name` for the changed label and `payload.pull_request.labels` for current authority. Require non-empty repository, PR number, and head branch. Never trust webhook labels as the merge-time decision; they are routing hints only.

- [ ] **Step 4: Implement race-safe start-or-signal**

Use `WorkflowIdReusePolicy.ALLOW_DUPLICATE` for a new valid `enroll` event. If `workflow.start` throws `WorkflowExecutionAlreadyStartedError`, get the existing handle and signal `prLandingWakeSignal`. Every `wake` event, managed or external, is signal-only; if no active execution is visible, acknowledge without starting because removing a veto or receiving a later review must not revive a completed manual run. A managed child that is not visible yet will read current provider state through its polling loop.

```ts
// `event.kind === 'enroll'`; wake-only handling returns before this branch.
const workflowId = prLandingWorkflowId(event.prRef);
try {
  await client.workflow.start(prLanding, {
    taskQueue, workflowId, workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
    args: [{ taskId: workflowId, project, repo: event.repo, prRef: event.prRef,
      agentCreated: false, headBranch: event.headBranch, config }],
  });
  return { started: true, workflowId };
} catch (err) {
  if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
  await client.workflow.getHandle(workflowId).signal(prLandingWakeSignal);
  return { started: false, workflowId };
}
```

- [ ] **Step 5: Route events through registered project policy**

Parse PR landing events before the legacy PR review path. Resolve the managed project and config. For external enrollment with `(config.autoMerge ?? 'disabled') === 'disabled'`, return 204 without start. Route managed events to signal-only; route valid external enrollments to start-or-signal. Remove `startDevCyclePrRepair` from new gateway flow but retain its source for compatibility.

- [ ] **Step 6: Run gateway tests and typecheck**

Run: `pnpm vitest run --config vitest.config.ts packages/gateway/src/parse-pr-landing-event.test.ts packages/gateway/src/start-pr-landing.test.ts packages/gateway/src/create-gateway-server.test.ts && pnpm --filter @agentops/gateway typecheck`

Expected: PASS for valid signatures, registered projects, disabled mode, duplicate delivery, and malformed payloads.

- [ ] **Step 7: Commit gateway enrollment**

```bash
git add packages/gateway
git commit -m "feat(gateway): enroll labeled PRs in landing"
```

## Task 7: Prove the integrated lifecycle and update operator docs

**Files:**
- Create: `e2e/pr-landing.e2e.test.ts`
- Modify: `e2e/helpers.ts`
- Modify: `e2e/happy-path.e2e.test.ts`
- Modify: `README.md`
- Modify: `docs/temporal-architecture.md`

- [ ] **Step 1: Write failing Temporal e2e cases**

Use the real worker, `MemoryScmPort`, `MemoryWorkspaceManager`, and `StubBackend` to cover:

1. `devCycle` with `autoMerge: 'all'` opens a managed PR, hands off its existing worktree, and returns `landingOutcome: 'merged'` after one exact-head merge.
2. Standalone external `prLanding` with `autoMerge: 'label'` and label `automerge` prepares the head branch, runs `full_verify` and `review`, and merges.
3. A fresh pre-merge snapshot containing both `automerge` and `automerge:disable` returns `merge-ready-manual` and records no merge operation.
4. A head change between validation and merge causes a second verification/review pass before merge.

Use snapshots like:

```ts
scm.scriptSnapshots('pr-1', [
  { prRef: 'pr-1', headSha: 'abc', headRepo: 'demo/repo', headBranch: 'agentops/t', checkoutRef: 'refs/pull/1/head', labels: ['agentops:managed'],
    state: 'open', draft: false, mergeable: true, mergedHeadSha: null,
    ciStatus: 'green', unresolvedThreads: 0, comments: [] },
]);
```

- [ ] **Step 2: Run the new e2e file and confirm integration failures**

Run: `pnpm vitest run --config vitest.e2e.config.ts e2e/pr-landing.e2e.test.ts`

Expected: FAIL until helper scripts and the full child path are integrated.

- [ ] **Step 3: Update shared e2e helpers and existing assertions**

Add a `waitForLandingOutcome` helper typed to `PrLandingState`. Update the existing happy path to include a `full_verify` pass and `review` pass after its babysit repair, then assert the appropriate manual outcome under the disabled default. Preserve its legacy feedback script to verify the Memory SCM compatibility path, and preserve all existing brake, retry, prompt, tracing, and push-before-open-PR assertions.

- [ ] **Step 4: Document policy, labels, webhook subscription, and worktree handoff**

Add an `agentops.json` example to `README.md`:

```json
{
  "autoMerge": "label"
}
```

Document `disabled | label | all`, `automerge`, `automerge:disable`, and `agentops:managed`. State that external enrollment requires GitHub `Pull requests` and `Pull request reviews` webhook events. In `docs/temporal-architecture.md`, show `devCycle -> prLanding`, the explicit serialized `workspaceRef`, shared PVC access, and exclusive cleanup ownership.

- [ ] **Step 5: Run all e2e tests**

Run: `pnpm e2e`

Expected: PASS.

- [ ] **Step 6: Commit integration coverage and docs**

```bash
git add e2e README.md docs/temporal-architecture.md
git commit -m "test: cover PR landing lifecycle end to end"
```

## Task 8: Run the repository definition of done

**Files:** all files changed by Tasks 1-7.

- [ ] **Step 1: Format changed files**

Run: `pnpm exec prettier --write packages/contracts/src packages/policies/src packages/ports/src packages/activities/src packages/workflows/src packages/gateway/src e2e README.md docs/temporal-architecture.md`

Expected: files formatted without errors.

- [ ] **Step 2: Run the complete local quality gate**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e`

Expected: all commands exit 0.

- [ ] **Step 3: Inspect the final diff for authority and determinism boundaries**

Run:

```bash
git diff --check
git diff origin/main...HEAD -- packages/workflows packages/policies packages/contracts packages/ports
```

Confirm manually that workflows contain no I/O or nondeterministic APIs, policies contain no Temporal/I/O imports, all cross-package data is zod-backed, no vendor calls escaped `ports`, and the old `devCyclePrRepair` implementation remains replayable.

- [ ] **Step 4: Ensure the PR description records policy safety**

Prepare this exact semantic note for the PR body:

> Merge-authority policy is safe because `disabled` remains the default and absolute project kill switch, `automerge:disable` wins over every enabled mode, and `prLanding` re-reads current labels plus the exact head SHA immediately before calling the SCM merge operation. Existing repair-loop verdict and brake semantics remain unchanged.

- [ ] **Step 5: Commit formatting or verification fixes if present**

```bash
git status --short
git add -A
git commit -m "chore: finalize PR landing verification"   # run only when tracked changes remain
```

## Task 9: Open the PR, pass CI, and resolve the Bugbot review

**Files:** none (integration / review).

> Sequential and partly asynchronous — CI and Bugbot run on the remote PR.
> **HARD GATE: Do not mark this task complete until ALL Bugbot comments are
> resolved (fixed or replied to) AND CI is green. Check with
> `gh pr view --json reviews,comments` before claiming done.**

- [ ] **Step 1: Sync the latest `main`**

```bash
git fetch origin
git merge origin/main
pnpm lint && pnpm typecheck && pnpm test && pnpm e2e   # resolve conflicts + commit first if any; fix fallout
```

- [ ] **Step 2: Push and open the PR**

```bash
git status --short && git rev-parse --abbrev-ref HEAD   # clean tree, on feature branch (not main)
git push -u origin HEAD
gh pr create --base main --fill --title "feat: add shared PR landing and auto-merge"
```

Edit the generated PR body if necessary so it contains the policy-safety note from Task 8 before requesting review.

- [ ] **Step 3: Subagent code review**

REQUIRED SUB-SKILL: `requesting-code-review`. Dispatch a code reviewer subagent (BASE_SHA = merge-base with `main`, HEAD_SHA = HEAD). Fix Critical and Important findings, commit, push, then proceed.

- [ ] **Step 4: Make every CI check pass**

```bash
gh pr checks --watch
```
On failure: `gh run view --log-failed`, reproduce locally, fix, commit, push, re-watch. Do not proceed while red.

- [ ] **Step 5: Wait for the Bugbot review**

```bash
gh pr view --json reviews,comments
gh pr comment --body "bugbot run"   # only if it hasn't reviewed yet
```

- [ ] **Step 6: Address each Bugbot comment**

REQUIRED SUB-SKILL: `receiving-code-review`. Verify before acting — reply to false positives; TDD-fix real findings, commit each referencing the finding, push once.

**Then mark each addressed thread resolved** (completion is gated on the unresolved-thread count, not just on having replied/fixed):

```bash
# Run only after every currently unresolved comment has been fixed or answered.
OWNER="$(gh repo view --json owner --jq '.owner.login')"
REPO="$(gh repo view --json name --jq '.name')"
PR="$(gh pr view --json number --jq '.number')"
gh api graphql -f query='query($o:String!,$r:String!,$p:Int!){repository(owner:$o,name:$r){pullRequest(number:$p){reviewThreads(first:100){nodes{id isResolved path comments(first:1){nodes{body}}}}}}}' \
  -F o="$OWNER" -F r="$REPO" -F p="$PR" > /tmp/agentops-pr-threads.json
jq -r '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false) | .id' /tmp/agentops-pr-threads.json | \
while read -r THREAD_ID; do
  gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id="$THREAD_ID"
done
```

**After pushing:** return to Step 4 (re-watch CI), then Step 5 (wait for re-review). Loop until Bugbot reports no unresolved comments.

- [ ] **Step 7: Final verification**

```bash
gh pr checks                          # all green
gh pr view --json reviews,comments    # no comment left unaddressed
pnpm lint && pnpm typecheck && pnpm test && pnpm e2e   # suite green locally
```
Confirm no unresolved review threads remain, then mark this task complete.
