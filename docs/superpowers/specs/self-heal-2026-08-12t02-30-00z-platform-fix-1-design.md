# Design — Task self-heal-2026-08-12t02-30-00z-platform-fix-1

## Goal

When a devCycle (or the deprecated `devCyclePrRepair`) reaches the push stage and
`GithubScmPort.push` fails with a permanent permission rejection, the port throws
`ApplicationFailure.nonRetryable(..., 'GitPushPermissionError')`
(`packages/ports/src/github/github-scm-port.ts:390`). Today that surfaces at the four
`activities.pushBranch(...)` call sites as an unhandled activity failure and fails the
whole workflow — throwing away a fully implemented, verified, reviewed branch that a human
could recover simply by fixing the repo's push credentials.

The change routes that specific failure into the workflow's existing **blocked-state**
mechanism (`state.status='blocked'`, a dedicated `state.blockReason`, then
`waitForResumeOrCancel()`), so the workflow pauses for human credential remediation and
retries the push on resume, instead of discarding completed work.

## Approaches considered

### A. Inline try/catch + block/retry loop at each of the four call sites
Wrap every `pushBranch` call in a `try/catch` that, on a `GitPushPermissionError`, sets the
blocked state, awaits resume/cancel, and retries in a loop. This mirrors how the babysit
brake performs its teardown *inline* today (dev-cycle.ts:472, pr-repair.ts:236).
- **Trade-off:** Four near-identical copies of the block/retry/teardown loop across two
  files. Highest duplication, highest risk of the copies drifting.

### B. Per-file closure helper `pushBranchOrBlock(...)` + one shared error predicate
Add a small predicate `isGitPushPermissionFailure(err)` (a direct analog of the existing
`isBudgetExceededFailure` in pr-landing.ts:56) and, in each workflow file, a local closure
`pushBranchOrBlock(contentHash)` that wraps the push in a retry loop: attempt push; on the
permission failure set `status='blocked'` / `blockReason='git-push-permission-denied'`,
`await waitForResumeOrCancel()`, and either tear down + signal the caller (on cancel) or
retry (on resume). The helper returns a boolean "cancelled" the same way the existing
`waitForResumeOrCancel` closure does, so call sites collapse to
`if (await pushBranchOrBlock(hash)) return state;`.
- **Trade-off:** Two helper definitions (one per file) because the cancel-teardown differs
  slightly between files (devCycle also calls `dropAgentWorking()`; pr-repair does not).
  Still, each file's three/two call sites share one implementation, and the error predicate
  is defined exactly once.

### C. Fully shared utility module (predicate + generic block/retry loop) imported by both files
Extract both the predicate and a generic, parameterized block/retry/teardown routine into a
new module used by all call sites (and potentially pr-landing.ts).
- **Trade-off:** The teardown sequence (`dropAgentWorking` present/absent, cleanup args) and
  the closed-over locals (`state`, `cancelled`, `waitForResumeOrCancel`) differ per file, so
  a "generic" routine needs several callbacks/params — more indirection than the problem
  warrants for four call sites. Over-engineered relative to the payoff.

## Chosen approach

**Approach B.** It removes the real duplication (the block/retry/teardown loop is written
once per file, and the fiddly error-shape predicate exactly once) while matching two
patterns already established in this package: local closure helpers that capture `state` and
signal cancellation via a returned boolean (`waitForResumeOrCancel`, `runStageAgent`), and a
small local `is…Failure` predicate for classifying an `ActivityFailure` cause
(`isBudgetExceededFailure`). Approach A was rejected for spraying the same loop four times;
Approach C for building a generic abstraction whose per-file differences force so much
parameterization that it is less readable than two focused closures.

## Design

### Contract change — new block reason
`packages/contracts/src/stage.ts`: add `'git-push-permission-denied'` to
`BlockReasonSchema`. Stage/status/block-reason names are fixed vocabulary (AGENTS.md
conventions), so this is the deliberate contract addition that admits the new resumable
block. `packages/contracts/src/stage.test.ts` gains this value to its accepted-reasons list.
No new status or stage is needed — `status='blocked'` and `stage='pr'` (or `stage`
unchanged at the babysit call sites) already model a resumable pause.

### Error predicate (shared, defined once)
Add `isGitPushPermissionFailure(err): boolean`, structurally identical to
`isBudgetExceededFailure`:
```
err instanceof ActivityFailure &&
err.cause instanceof ApplicationFailure &&
err.cause.type === 'GitPushPermissionError'
```
The Temporal SDK wraps an activity's thrown `ApplicationFailure` in an `ActivityFailure`
whose `.cause` is that `ApplicationFailure`, so the check must unwrap one level — this is why
the existing budget-exceeded predicate does the same. To keep the predicate in exactly one
place while both `dev-cycle.ts` and `dev-cycle-pr-repair.ts` use it, it lives in a tiny
internal helper module (e.g. `packages/workflows/src/push-failures.ts`) and is imported by
both. (Co-locating it in `dev-cycle.ts` and importing from pr-repair would also work but
creates an asymmetric cross-file dependency between two peer workflows; a dedicated helper
module is cleaner and has no determinism-boundary concerns since it is a pure predicate.)

### `pushBranchOrBlock` closure — dev-cycle.ts
Defined alongside `waitForResumeOrCancel` (after `state`, `cancelled`, `dropAgentWorking`,
and `waitForResumeOrCancel` are in scope). Signature roughly:
`async (contentHash: string): Promise<boolean>` — returns `true` when the workflow should
tear down and return (cancelled), `false` when the push ultimately succeeded.

Behavior:
1. `try { await activities.pushBranch(input.repo, state.workspaceRef, state.branch, contentHash); return false; }`
2. `catch (err)`: if `!isGitPushPermissionFailure(err)` **rethrow** (preserve today's
   fail-the-workflow behavior for every other push error, including the plain non-permission
   `git push failed` `Error`).
3. On the permission failure: `state.status='blocked'`;
   `state.blockReason='git-push-permission-denied'`; then
   `if (await waitForResumeOrCancel())` do the standard cancel teardown
   (`state.stage='failed'`, `state.status='failed'`, `await dropAgentWorking()`,
   `await activities.cleanupWorkspace(state.workspaceRef, input.repo)`) and `return true`.
4. On resume, loop back to step 1 and retry the push (credentials presumed fixed). Because
   the port push is `--force` and idempotent for a task-owned branch, retrying is safe.

The two devCycle call sites become:
- L365 (main `pr` stage push): `if (await pushBranchOrBlock(\`${input.taskId}-${implementAttempt}\`)) return state;`
- L508 (babysit actionable-repair push): same call with its `-${implementAttempt}` hash; on
  cancel-return the babysit loop unwinds by returning `state`.

The existing generic `resumeSignal` handler already sets `status='running'` /
`blockReason=null`, which is exactly what a git-push resume needs — no brake to lift — so no
change to the resume handler is required.

### `pushBranchOrBlock` closure — dev-cycle-pr-repair.ts
Same shape, minus `dropAgentWorking()` in the teardown (this workflow has none; its cancel
teardown is `state.stage='failed'`, `state.status='failed'`,
`await activities.cleanupWorkspace(...)`, matching its existing babysit-brake teardown at
pr-repair.ts:242). Its two call sites (L208 post-repair push, L272 babysit-repair push)
collapse to `if (await pushBranchOrBlock(hash)) return state;`. This file is deprecated for
new starts but still replayable, so the change keeps its structure intact.

### Determinism / replay safety
The edits only add a `try/catch` and, on the *failure* path, blocking `condition()` waits —
no change to the command stream on the success path. Histories that previously succeeded
replay identically; histories that previously *failed* here are terminal and are not
replayed. Therefore the new behavior needs **no `patched()` gate**: there is no in-flight
history that took the old branch at this command index and would now diverge. (Contrast the
pr-repair babysit-brake fix, which changed behavior on a path live histories were sitting on
and thus needed `patched('pr-repair-babysit-brake-v1')`.) The predicate and helper contain
no `Date.now`/`Math.random`/I/O and import nothing from `activities`/`ports`, so the
determinism boundary (AGENTS.md hard rule #1) is respected.

### Tests
- `packages/contracts/src/stage.test.ts`: accept `'git-push-permission-denied'`.
- `packages/workflows/src/dev-cycle.test.ts` and `dev-cycle-pr-repair.test.ts`: add cases
  where `pushBranch` is mocked to throw an `ActivityFailure` whose cause is an
  `ApplicationFailure` of type `GitPushPermissionError` (the test mocks already stub
  `ApplicationFailure`; extend the mock to include `ActivityFailure`). Assert the workflow
  transitions to `status='blocked'`, `blockReason='git-push-permission-denied'`; that a
  `resume` signal drives a successful retry through to PR-open/done; and that a `cancel`
  while blocked terminates with `status='failed'` after cleanup. Also assert a *non*-
  permission push error still fails the workflow (predicate specificity).

### Files touched
- `packages/contracts/src/stage.ts` — new block-reason enum value.
- `packages/contracts/src/stage.test.ts` — cover the new value.
- `packages/workflows/src/push-failures.ts` *(new)* — `isGitPushPermissionFailure`.
- `packages/workflows/src/dev-cycle.ts` — `pushBranchOrBlock` closure + two call sites.
- `packages/workflows/src/dev-cycle-pr-repair.ts` — `pushBranchOrBlock` closure + two call sites.
- `packages/workflows/src/dev-cycle.test.ts`, `dev-cycle-pr-repair.test.ts` — new tests.

## Assumptions

- **`pr-landing.ts` is out of scope.** It also calls `pushBranch` twice (L263, L407), but the
  task explicitly enumerates only `dev-cycle.ts` and `dev-cycle-pr-repair.ts`. I did not
  extend the handling there. The shared predicate module makes a later follow-up trivial, and
  I flag pr-landing as the obvious next site for a reviewer. (Assumption: the task's file list
  is intentional and pr-landing's push-permission handling is deferred, not forgotten.)
- **One shared block reason, not per-site variants.** The goal names
  `blockReason='git-push-permission-denied'` exactly; I use that single value at all four
  sites rather than distinguishing initial-push vs. babysit-push.
- **Retry-on-resume rather than resume-then-skip.** Resuming should re-attempt the push
  (the whole point is that a human fixed the credentials); the port's `--force` push is
  idempotent on the disposable task branch, so retrying cannot corrupt state.
- **No `patched()` gate.** Justified above: the change is additive on a terminal failure path,
  so no live history diverges. If a reviewer disagrees, gating each helper behind a new
  `patched('git-push-permission-block-v1')` is a mechanical, low-risk addition.
- **Helper predicate lives in a new tiny module** rather than being duplicated or exported
  from one workflow file, to avoid drift and an asymmetric peer-to-peer import.

## Scope check

This is one coherent change: catch a single, already-defined error type at the enumerated
push sites and route it into the existing blocked/resume mechanism, plus the one contract
enum value and tests that the mechanism requires. No unrelated work is bundled.

## Brainstorm Summary

**Approaches considered:** (A) inline try/catch + block/retry loop at each of the four push
sites; (B) a per-file `pushBranchOrBlock` closure plus one shared `isGitPushPermissionFailure`
predicate; (C) a fully generic shared block/retry utility for all sites.
**Chosen approach:** (B) — a small closure per workflow file and a single shared error
predicate.
**Why (decisive reasons):** Removes real duplication while matching two existing patterns in
this package (cancellation-signaling closures like `waitForResumeOrCancel`, and the
`isBudgetExceededFailure` activity-cause predicate). A rejects for four-way duplication; C's
per-file teardown differences force so much parameterization it reads worse than two focused
closures.
**Key risks/assumptions:** Needs a new `BlockReasonSchema` value
`'git-push-permission-denied'`; the predicate must unwrap `ActivityFailure.cause` to reach the
`ApplicationFailure`; no `patched()` gate is needed because the change is additive on a
terminal failure path; `pr-landing.ts`'s two push sites are deliberately left out of scope
per the task's file list.
