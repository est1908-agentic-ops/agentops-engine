# Plan — Task self-heal-2026-08-12t02-30-00z-platform-fix-1

Route the `GitPushPermissionError` thrown by `GithubScmPort.push`
(`packages/ports/src/github/github-scm-port.ts:390`) into the workflows' existing
blocked-state mechanism at the four enumerated `pushBranch` call sites, so a devCycle pauses
for human credential remediation and retries on resume instead of discarding a completed,
verified, reviewed branch.

Design authority: `docs/superpowers/specs/self-heal-2026-08-12t02-30-00z-platform-fix-1-design.md`
(Approach B: one shared error predicate + a per-file `pushBranchOrBlock` closure).

## Steps

### Step 1 — Add the `git-push-permission-denied` block reason to the contract

- **File:** `packages/contracts/src/stage.ts`
  Add `'git-push-permission-denied'` to `BlockReasonSchema` (the `z.enum([...])` at L34–46).
  Place it after `'pr-landing-blocked'` with a one-line comment explaining it is a *resumable*
  block set together with `status='blocked'` (contrast the fail-fast `'unregistered-repo'`).
- **File:** `packages/contracts/src/stage.test.ts`
  Add `'git-push-permission-denied'` to the accepted-reasons array in the
  `BlockReasonSchema` "accepts every fixed block reason" test (L64–77).
- **Verify:** `pnpm --filter @agentops/contracts test` (stage.test.ts passes with the new
  value) and `pnpm --filter @agentops/contracts typecheck`. The `BlockReason` type now
  includes the literal, which is what makes assigning it in the workflows typecheck in later
  steps.
- **Why first:** Every downstream step assigns `state.blockReason = 'git-push-permission-denied'`;
  that only typechecks once the enum admits the value. This step de-risks all the others and
  cannot itself break anything (pure additive enum widening).

### Step 2 — Add the shared error predicate module

- **File (new):** `packages/workflows/src/push-failures.ts`
  Export `isGitPushPermissionFailure(err: unknown): boolean`, structurally identical to
  `isBudgetExceededFailure` (`packages/workflows/src/pr-landing.ts:56`):
  ```ts
  import { ActivityFailure, ApplicationFailure } from '@temporalio/workflow';
  export function isGitPushPermissionFailure(err: unknown): boolean {
    return (
      err instanceof ActivityFailure &&
      err.cause instanceof ApplicationFailure &&
      err.cause.type === 'GitPushPermissionError'
    );
  }
  ```
  The one-level unwrap (`ActivityFailure.cause` → `ApplicationFailure`) is required because the
  Temporal SDK wraps an activity's thrown `ApplicationFailure` in an `ActivityFailure`; this
  mirrors why the budget predicate does the same.
- **Verify:** `pnpm --filter @agentops/workflows typecheck`. The module imports only from
  `@temporalio/workflow` (a pure, workflow-safe classifier — no `activities`/`ports` import,
  no `Date.now`/`Math.random`/I/O), so it respects the determinism boundary (AGENTS.md hard
  rule #1); confirm the existing `determinism-lint.test.ts` still passes in Step 6.
- **Why second:** It is a leaf dependency of Steps 3 and 4 and has no dependency of its own
  beyond the SDK. Landing it before the call-site edits keeps each later diff to just the
  closure + call sites.

### Step 3 — `pushBranchOrBlock` closure + two call sites in `dev-cycle.ts`

- **File:** `packages/workflows/src/dev-cycle.ts`
  - Add `ActivityFailure`/`ApplicationFailure` are *not* needed here (predicate is imported).
    Add `import { isGitPushPermissionFailure } from './push-failures';`.
  - Define the closure after `waitForResumeOrCancel` (L190–193) so it closes over `state`,
    `cancelled`, `input`, `activities`, `dropAgentWorking`, and `waitForResumeOrCancel`:
    ```ts
    const pushBranchOrBlock = async (contentHash: string): Promise<boolean> => {
      // returns true => caller should tear down and return (cancelled while blocked)
      //         false => push ultimately succeeded
      while (true) {
        try {
          await activities.pushBranch(input.repo, state.workspaceRef, state.branch, contentHash);
          return false;
        } catch (err) {
          if (!isGitPushPermissionFailure(err)) throw err; // preserve fail-the-workflow for all other errors
          state.status = 'blocked';
          state.blockReason = 'git-push-permission-denied';
          if (await waitForResumeOrCancel()) {
            state.stage = 'failed';
            state.status = 'failed';
            await dropAgentWorking();
            await activities.cleanupWorkspace(state.workspaceRef, input.repo);
            return true;
          }
          // resumed: credentials presumed fixed; loop retries the idempotent --force push
        }
      }
    };
    ```
  - Replace the L365 `pr`-stage push:
    ```ts
    state.stage = 'pr';
    if (await pushBranchOrBlock(`${input.taskId}-${implementAttempt}`)) return state;
    ```
  - Replace the L508 babysit actionable-repair push:
    ```ts
    if (await pushBranchOrBlock(`${input.taskId}-${implementAttempt}`)) return state;
    ```
    (On cancel-return the babysit `while (true)` loop unwinds by returning `state`.)
  - No change to the `resumeSignal` handler: it already sets `status='running'` /
    `blockReason=null`, which is exactly what a git-push resume needs (no brake to lift). The
    branch-specific brake lifts in that handler (`token-brake`/`iteration-brake`/`babysit-brake`)
    simply don't fire for the new reason, which is correct.
- **Verify:** `pnpm --filter @agentops/workflows typecheck`, then the new dev-cycle tests
  added in Step 5. Manual read-through: confirm the two edited call sites are the only
  `activities.pushBranch(` occurrences in this file and both now go through the closure.

### Step 4 — `pushBranchOrBlock` closure + two call sites in `dev-cycle-pr-repair.ts`

- **File:** `packages/workflows/src/dev-cycle-pr-repair.ts`
  - Add `import { isGitPushPermissionFailure } from './push-failures';`.
  - Define the closure after `waitForResumeOrCancel` (L88–91). Identical to Step 3 **minus**
    `dropAgentWorking()` (this workflow has none); its cancel teardown is
    `state.stage='failed'`, `state.status='failed'`,
    `await activities.cleanupWorkspace(state.workspaceRef, input.repo)` — matching this file's
    existing babysit-brake teardown (L242–247).
  - Replace the L208 post-repair push and the L272 babysit-repair push with
    `if (await pushBranchOrBlock(`${input.taskId}-repair-${implementAttempt}`)) return state;`
    (preserving the existing `-repair-` hash prefix).
  - **No `patched()` gate** (design §Determinism): the change is additive on the *success*
    command stream and only adds blocking `condition()` waits on the *failure* path. Histories
    that previously succeeded at push replay identically; histories that previously *failed*
    here are terminal and never replay. This is unlike the babysit-brake fix in this same file
    (`patched('pr-repair-babysit-brake-v1')`), which altered behavior on a path live histories
    were sitting on. Leave that existing gate untouched.
- **Verify:** `pnpm --filter @agentops/workflows typecheck`, then the new pr-repair tests from
  Step 5. Read-through: confirm both `activities.pushBranch(` sites now route through the
  closure and the `-repair-` hash is unchanged.

### Step 5 — Tests for both workflows

- **File:** `packages/workflows/src/dev-cycle.test.ts`
  The `@temporalio/workflow` mock (L83–119) currently defines
  `ActivityFailure extends Error {}` and `ApplicationFailure extends Error { type = '' }` but
  does not thread a `cause`. Extend the mock so an `ActivityFailure` can carry a `cause`
  (either give the mock class a `cause` field/constructor, or build the instance in-test via
  `Object.assign(new ActivityFailure(), { cause })`). Add cases:
  1. **Blocks on permission failure:** mock the *first* `pushBranch` call to reject with an
     `ActivityFailure` whose `.cause` is an `ApplicationFailure` with
     `type = 'GitPushPermissionError'`. Assert the state reaches `status='blocked'`,
     `blockReason='git-push-permission-denied'` (query the state / inspect returned state after
     firing `resume`).
  2. **Resume retries to success:** after the block, fire the `resume` handler and have the
     next `pushBranch` resolve; assert the workflow proceeds to `openPr` and ends
     `status='done'` (or `pr_babysit`/landing per the patched path), and that `pushBranch` was
     called twice.
  3. **Cancel while blocked terminates cleanly:** block, then fire `cancel`; assert
     `stage='failed'`, `status='failed'`, `cleanupWorkspace` called, and (issue-linked run)
     `unlabelIssue('…','agent:working')` called via `dropAgentWorking`.
  4. **Predicate specificity:** mock `pushBranch` to reject with a plain
     `new Error('git push failed')` (non-permission) and assert the workflow rejects/fails
     (does *not* block) — proving the closure rethrows everything except the permission type.
  Because `condition` is mocked to resolve immediately and `setHandler` records handlers in a
  map, drive resume/cancel by invoking the recorded handler between awaits (follow the existing
  brake tests' pattern in this file / pr-landing.test.ts).
- **File:** `packages/workflows/src/dev-cycle-pr-repair.test.ts`
  Mirror cases 1–4 for the L208 post-repair push (the simplest site to reach), extending its
  `@temporalio/workflow` mock the same way. Assert the cancel teardown does *not* attempt any
  `agent:working` unlabel (this workflow has no `dropAgentWorking`).
- **Verify:** `pnpm --filter @agentops/workflows test` — all new and existing cases green.

### Step 6 — Full green gate

- **Verify (whole repo, per AGENTS.md "Definition of done"):**
  `pnpm lint && pnpm typecheck && pnpm test`, then `pnpm e2e` (the change touches `workflows`,
  so e2e is required). Confirm `determinism-lint.test.ts` passes (guards the new module and
  edits against the determinism boundary). No new TODOs.

## Sequencing notes

- **Contract enum first (Step 1), predicate second (Step 2), call sites third/fourth.** This is
  a strict dependency chain: the block-reason literal must exist for the workflow assignments to
  typecheck, and the predicate must exist before the closures import it. Ordering it this way
  means each step compiles on its own and every intermediate `typecheck` is meaningful.
- **`dev-cycle.ts` before `dev-cycle-pr-repair.ts` (Step 3 before 4).** Both are independent and
  could swap; I do the actively-used workflow first so its closure shape is the reference the
  (deprecated-but-replayable) pr-repair copy follows, and any surprise surfaces on the
  higher-value path first.
- **Tests as their own step (Step 5), after both implementations.** The two test files share the
  same mock-extension technique (threading a `cause` through the `ActivityFailure` mock); writing
  them together avoids discovering the mock gap twice. Each implementation step still names its
  verifying tests, so nothing is "done" without a check — Step 5 is where those checks are
  authored, Step 6 is where the whole suite (including e2e) runs.
- **e2e last.** It is the slowest gate and only meaningful once unit/typecheck are green.

## Assumptions

Resolved myself (unattended run); all consistent with the design's Assumptions section:

- **`pr-landing.ts` is out of scope.** It has two `pushBranch` sites (L263, L407) but the task
  and design enumerate only `dev-cycle.ts` and `dev-cycle-pr-repair.ts`. The shared
  `push-failures.ts` module makes a later pr-landing follow-up a one-line import; I flag it as
  the obvious next site but do not touch it.
- **Single block reason `'git-push-permission-denied'` at all four sites** (not initial-vs-
  babysit variants) — the goal names exactly this value.
- **Retry-on-resume, not resume-then-skip.** Resuming re-attempts the push; the port push is
  `--force` and idempotent on the disposable `agentops/<taskId>` branch
  (`github-scm-port.ts:380–386`), so retrying cannot corrupt state.
- **No `patched()` gate**, justified in Step 4 (additive on the success stream; failure path is
  terminal and never replays). If a reviewer disagrees, wrapping each closure body behind a new
  `patched('git-push-permission-block-v1')` is a mechanical, low-risk follow-up.
- **Predicate lives in a new `push-failures.ts` module** rather than being duplicated per file
  or exported from one peer workflow into the other (which would create an asymmetric
  peer-to-peer import). It is a pure classifier, so it has no determinism-boundary concern.
- **Test mock extension.** The existing `@temporalio/workflow` test mocks stub
  `ActivityFailure`/`ApplicationFailure` but not a `cause` linkage; I extend those mocks
  minimally to let a test construct `ActivityFailure { cause: ApplicationFailure { type } }`,
  rather than importing the real SDK error classes into the unit tests.
