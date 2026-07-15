# Design — issue-agentic-ops-engine-118

**Title:** [bughunt] `devCyclePrRepair` babysit loop discards cancel signal result, workflow never terminates on cancel

## Goal

The `devCyclePrRepair` workflow supports a `cancel` signal that should terminate the
workflow. Everywhere else in the workflow this is honored via the
`waitForResumeOrCancel()` helper, which returns `true` when a cancel was requested — the
caller is expected to react by throwing `RepairCancelledError` (caught at the top level to
finalize the workflow as `failed` and clean up the workspace).

In the PR-babysit loop there is one call site that **ignores the return value**. When the
no-progress cap is hit the workflow blocks with `blockReason = 'babysit-brake'` and awaits
`waitForResumeOrCancel()`, but the boolean result is discarded. So when an operator sends
`cancel` while the workflow is parked at a babysit brake, `condition` unblocks, but the loop
simply resets its counter and spins forever instead of terminating. Fix the loop so a cancel
at the babysit brake terminates the workflow, matching every other cancel checkpoint.

## The bug (concrete)

`packages/workflows/src/dev-cycle-pr-repair.ts`, babysit loop, lines ~239–245:

```ts
waiting += 1;
if (waiting >= MAX_BABYSIT_WAITS) {
  state.status = 'blocked';
  state.blockReason = 'babysit-brake';
  await waitForResumeOrCancel();   // <-- return value discarded
  waiting = 0;
}
```

`waitForResumeOrCancel()` resolves `true` on cancel and `false` on resume. Because the result
is dropped, cancel is indistinguishable from resume: the code always falls through to
`waiting = 0` and loops. Compare the correct handling in the same file at line ~113
(`if (await waitForResumeOrCancel()) throw new RepairCancelledError();`) and the equivalent
babysit brake in `dev-cycle.ts` (lines ~436–442), which returns a `failed` state on cancel.

## Approaches considered

### A. Targeted one-site fix (recommended)
Honor the return value at the single offending call site: on cancel, throw
`RepairCancelledError` (the existing sentinel), which the top-level `catch` already converts
into `status: 'failed'` + workspace cleanup + return. On resume, keep the current behavior
(`waiting = 0`, continue looping).

- **Trade-off:** Smallest possible surface; matches the file's own established cancel idiom
  (line ~113). Does not touch the pre-existing redundancy between the loop's local `waiting`
  counter and `babysitDecision`'s own `'braked'` return (see Out of scope). Lowest determinism
  risk for a Temporal workflow (no reordering of activity/timer calls).
- **Cost/complexity:** ~1 line changed + a regression test.

### B. Align the whole babysit loop with `dev-cycle.ts`
Rewrite the pr-repair babysit loop to mirror `dev-cycle.ts` exactly: handle
`decision === 'braked'` from `babysitDecision`, drop the parallel local `waiting` counter, lift
`maxBabysitWaits` to unbounded on resume, and return a `failed` state on cancel.

- **Trade-off:** Removes the redundant/inconsistent double-counting and honors `'braked'`
  (e.g. unreadable-CI) immediately. But it is a structural rewrite of a live Temporal workflow
  loop, which changes the sequence of `condition`/`sleep`/activity calls and carries
  determinism/replay risk for a bug whose reported symptom is a single discarded boolean.
- **Cost/complexity:** Medium; larger diff, broader test/verification burden, more review risk.

### C. Make cancel responsive throughout the loop (not just at the brake)
Additionally poll `cancelled` between sleeps / inside the actionable branch so cancel takes
effect mid-poll rather than only at a brake.

- **Trade-off:** Nice-to-have responsiveness, but it is a behavior change beyond the reported
  bug and diverges from `dev-cycle.ts` (which also only honors cancel at defined checkpoints).
  Expands scope without addressing anything the issue asks for.
- **Cost/complexity:** Medium; new checkpoints, more tests, scope creep.

## Chosen approach

**Approach A.** It fixes exactly the reported defect with the minimum viable change and reuses
the file's own proven cancel mechanism (`throw new RepairCancelledError()` → top-level catch),
so the terminal state (`failed` + `cleanupWorkspace` + return) is already correct and needs no
new plumbing.

- **B rejected** because rewriting a live workflow loop for a one-line semantic bug adds
  determinism/replay risk disproportionate to the fix; the `'braked'`/local-counter redundancy
  is real but is a separate cleanup, noted under Out of scope.
- **C rejected** as scope creep: the issue is about the discarded cancel result at the brake,
  not about mid-poll cancel latency, and `dev-cycle.ts` intentionally only checks cancel at
  checkpoints.

## Design (what changes)

Single file: `packages/workflows/src/dev-cycle-pr-repair.ts`.

- In the PR-babysit `while` loop's no-progress brake branch, change
  `await waitForResumeOrCancel();` to check its result:
  `if (await waitForResumeOrCancel()) throw new RepairCancelledError();` before resetting
  `waiting = 0`. On resume the loop continues exactly as today.
- No changes to signals, handlers, `state` shape, activities, or the top-level `catch` — the
  existing `RepairCancelledError` path already finalizes the workflow as `failed`, cleans up
  the workspace, and returns `state`.

**Data flow after fix:** operator sends `cancel` → `cancelSignal` handler sets `cancelled = true`
→ `condition(() => cancelled || state.status === 'running')` unblocks → `waitForResumeOrCancel()`
returns `true` → loop throws `RepairCancelledError` → top-level `catch` sets `stage = 'failed'`,
`status = 'failed'`, calls `cleanupWorkspace`, returns `state`. Resume path (`cancelled` false)
is unchanged.

**Testing:** Add a workflow-level regression test in
`packages/workflows/src/dev-cycle-pr-repair.test.ts` (new file, following the mocking style of
`dev-cycle.test.ts` — mock `@temporalio/workflow`, capture the handler passed to `setHandler`
for the `cancel` signal, mock activities). Drive the loop to a babysit brake (mocked
`getPrFeedback` returns non-actionable/pending feedback and `sleep` resolves immediately so the
`waiting` counter reaches `MAX_BABYSIT_WAITS`), invoke the captured cancel handler, and make
`condition` resolve; assert the workflow **returns** with `status: 'failed'` (i.e. terminates)
rather than hanging, and that `cleanupWorkspace` was called. Existing tests
(`packages/contracts/src/dev-cycle-pr-repair.test.ts`) and lint/typecheck must still pass.

## Assumptions

- **Cancel-at-brake should terminate as `failed`, not `done` or `cancelled`.** The file's only
  existing cancel path (`RepairCancelledError` → catch) produces `status: 'failed'`, and
  `dev-cycle.ts` does the same on babysit cancel. I follow that convention rather than
  introducing a new `'cancelled'` status.
- **Resume semantics stay as-is.** On resume the loop keeps resetting `waiting = 0` and
  continuing; I do not adopt `dev-cycle.ts`'s "lift the cap to unbounded on resume" behavior,
  as that is part of the separate loop-structure cleanup (Approach B) and not required to fix
  the cancel bug.
- **A new colocated test file is acceptable.** There is currently no
  `packages/workflows/src/dev-cycle-pr-repair.test.ts`; I add one rather than extending the
  contracts-package schema test, since this is workflow behavior.

## Out of scope (noted, not fixed)

The babysit loop keeps a local `waiting` counter *and* passes it to `babysitDecision`, whose
`'braked'` return is never handled explicitly (it falls through to the same local increment).
This makes `babysitDecision`'s `'braked'` result (including immediate brake on unreadable CI)
effectively inert in pr-repair. This is a pre-existing inconsistency with `dev-cycle.ts` and a
candidate for a follow-up cleanup (Approach B), but it is not the reported cancel bug and is
deliberately left untouched to keep this change coherent and low-risk.

## Self-review

- No placeholders/TBD.
- No contradictions: recommendation (A), design, and assumptions all describe the same
  one-site fix reusing the existing `RepairCancelledError` path.
- Scope: one coherent change (one source-line semantic fix + one regression test). The related
  loop-structure cleanup is explicitly deferred, not silently bundled.

## Brainstorm Summary
**Approaches considered:** (A) fix the single babysit-brake call site to honor `waitForResumeOrCancel()`'s return; (B) rewrite the whole babysit loop to mirror `dev-cycle.ts`; (C) also make cancel responsive mid-poll.
**Chosen approach:** (A) the targeted one-site fix.
**Why (decisive reasons):** It fixes exactly the reported discarded-boolean bug with a ~1-line change, reuses the file's existing `RepairCancelledError` → top-level-catch path (correct `failed`+cleanup+return already in place), and avoids the determinism/replay risk of rewriting a live Temporal workflow loop. B and C add risk/scope beyond the issue.
**Key risks/assumptions:** Cancel-at-brake terminates as `status: 'failed'` (matching the only existing cancel path and `dev-cycle.ts`); resume behavior unchanged; a pre-existing redundancy between the local `waiting` counter and `babysitDecision`'s ignored `'braked'` result is left as a noted follow-up.
