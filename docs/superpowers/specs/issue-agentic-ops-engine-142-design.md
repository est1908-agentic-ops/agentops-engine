# Design — issue-agentic-ops-engine-142

**Title:** [bughunt] `prLanding` babysit/repair loops ignore cancel signal outside brake checkpoints

## Goal

The `prLanding` workflow (`packages/workflows/src/pr-landing.ts`) accepts a `cancel`
signal that should terminate the workflow (clean up the workspace, return
`outcome: 'cancelled'`). Today that only happens at *brake checkpoints* — the places where
the workflow is already parked waiting for a `resume` (repair-brake, babysit-brake,
budget-exceeded). Everywhere else in the two long-running loops the `cancelled` flag is never
observed:

- The babysit poll `await condition(() => woke, DEFAULT_BABYSIT_POLL_MS)` (line 264) waits on
  `woke` only. A cancel arriving while polling does not wake the wait; the workflow blocks up
  to the 5s poll timeout and then runs a *full* iteration — fetch snapshot, `babysitDecision`,
  possibly run agents or **merge the PR** — before it might reach a brake.
- The repair loop `validateHead` (`while (true)`, line 200) runs stage agents and pushes
  branches iteration after iteration, never checking `cancelled` between iterations. The only
  in-loop cancel observation is inside `runStageAgent`, and only on the budget-exceeded path
  (line 165).

Net effect: an operator who cancels a PR-landing that is actively babysitting or repairing is
ignored until (and unless) the workflow happens to hit a brake. On the common paths — CI
churning green/pending, or a repair loop making progress — it may never brake, so the workflow
keeps burning tokens and can even merge a PR after cancel was requested.

This is the same class of defect as PR #120 (`devCyclePrRepair` discarded the cancel result at
a brake). There the bug was one discarded boolean *at* a checkpoint; here the checkpoints are
wired correctly but the loop bodies *between* checkpoints ignore cancel. The fix applies the
same idiom — "any wait/loop that can coincide with a cancel must observe `cancelled` and
terminate" — to the loop bodies.

## What is already correct (do not touch)

- `PrLandingCancelledError` (line 47) → top-level `catch` (lines 428–432) sets
  `phase: 'done'`, `outcome: 'cancelled'`, returns `state`; the `finally` (line 437) cleans up
  the workspace. This terminal path already produces the right result and needs no new plumbing.
- `waitAtBrake` (lines 114–126) and `waitForResumeOrCancel` (lines 128–131) already observe
  `cancelled` and their callers already return / throw on cancel. The budget-exceeded checkpoint
  in `runStageAgent` (line 165) is already correct.

## Approaches considered

### A. Cooperative cancel checkpoints at the loop boundaries (recommended)

Make the `cancelled` flag observed at the natural checkpoints of each unbounded loop, reusing
the existing `PrLandingCancelledError` → top-level-catch → cleanup path:

1. Babysit poll (line 264): change `condition(() => woke, …)` to
   `condition(() => woke || cancelled, …)` so a cancel wakes the poll immediately instead of
   waiting out the 5s timeout, then `if (cancelled) throw new PrLandingCancelledError();`
   immediately after the poll. Because `cancelled` stays true, this single post-poll check also
   catches a cancel that arrived during the *previous* iteration's work: the next iteration's
   poll resolves instantly and throws.
2. Repair loop `validateHead` (top of the `while (true)`, line 200): add
   `if (cancelled) throw new PrLandingCancelledError();` so the loop terminates between
   iterations rather than running another full verify/review/implement/push cycle.
3. `runStageAgent` retry loop (top of its `while (true)`, line 141): add
   `if (cancelled) throw new PrLandingCancelledError();` so a cancel that arrived while a prior
   agent call was running is honored before the next agent call is dispatched.

- **Trade-off:** Cancel is honored at *defined checkpoints* (loop heads / poll boundaries), not
  preemptively mid-activity. Once an iteration has started it runs to its next checkpoint before
  cancel takes effect — matching the cooperative model the rest of this codebase uses
  (`dev-cycle.ts` and `dev-cycle-pr-repair.ts` also only honor cancel at checkpoints, per the
  #118 design). Smallest surface, reuses the proven `PrLandingCancelledError` path, no new
  contracts/signals/state, and only adds pure boolean checks + one predicate term — no reordering
  of activity/timer calls, so it is determinism-safe for a live Temporal workflow.
- **Cost/complexity:** ~3 small edits (one predicate change + three `if (cancelled) throw`
  guards) + regression tests.

### B. Preemptive cancellation via Temporal `CancellationScope`

Wrap the in-flight activities (`runAgent`, `mergePr`, `getPrSnapshot`, `pushBranch`) in a
cancellation scope so a cancel signal actually interrupts a running activity mid-flight.

- **Trade-off:** More responsive (cancel takes effect during a long agent run, not just at the
  next checkpoint), but it changes activity/heartbeat/retry semantics, is a materially larger and
  riskier change to a live workflow, and diverges from the cooperative-checkpoint idiom used
  everywhere else in the repo. Determinism/replay risk is much higher.
- **Cost/complexity:** High; broad diff, heavier verification burden.

### C. A single shared `checkCancel()` sprinkled before every activity call

Add a helper that throws on cancel and call it before each activity invocation throughout both
loops.

- **Trade-off:** Finer-grained responsiveness than A, but many more call sites to touch and to
  keep in sync, more replay history to reason about, and it blurs "where can this workflow
  terminate" across a dozen points instead of a few clear checkpoints. Marginal benefit over A
  for the reported symptom.
- **Cost/complexity:** Medium; larger diff and review surface than A for little practical gain.

## Chosen approach

**Approach A.** It fixes exactly the reported defect — the loop bodies between checkpoints
ignore cancel — with the minimum viable change, and it reuses the workflow's existing
`PrLandingCancelledError` → catch → cleanup path so the terminal state (`outcome: 'cancelled'`
+ `cleanupWorkspace` + return) is already correct. It is the direct analogue of the #120 fix and
consistent with how `dev-cycle.ts` / `dev-cycle-pr-repair.ts` treat cancel (honored at defined
checkpoints, not mid-activity).

- **B rejected:** preemptive `CancellationScope` interruption is disproportionate to a bug whose
  symptom is "the loops don't check a boolean", adds real determinism/replay and
  heartbeat/retry risk to a live workflow, and diverges from the established cooperative idiom.
- **C rejected:** per-activity `checkCancel()` calls expand the surface and the set of
  termination points without materially improving on A's per-iteration checkpoints for the
  reported case; A's loop-head checkpoints already bound cancel latency to at most one iteration
  (≤ ~5s of poll on the babysit path).

## Design (what changes)

Single source file: `packages/workflows/src/pr-landing.ts`.

1. **Babysit poll — wake on cancel and check.** In `babysitAndMerge` (line 261 loop), change the
   poll wait to `await condition(() => woke || cancelled, DEFAULT_BABYSIT_POLL_MS)` and, right
   after it, add `if (cancelled) throw new PrLandingCancelledError();`. This makes cancel
   responsive during the poll (no 5s wait-out) and, because `cancelled` latches, also terminates
   promptly if the cancel arrived during the prior iteration's post-poll work.
2. **Repair loop head — check on entry to each iteration.** In `validateHead` (line 200 loop),
   add `if (cancelled) throw new PrLandingCancelledError();` at the top of the loop body so it
   stops between verify/review/implement/push cycles.
3. **Stage-agent retry head — check before dispatching an agent.** In `runStageAgent` (line 141
   loop), add `if (cancelled) throw new PrLandingCancelledError();` at the top of the retry loop.

No changes to contracts, signals, handlers, `state` shape, the `PrLandingState` vocabulary, the
brake helpers, activities, or the top-level `catch`/`finally`. All three additions throw the
existing `PrLandingCancelledError`, which the top-level catch already maps to `phase: 'done'`,
`outcome: 'cancelled'`, and workspace cleanup — identical to the budget-exceeded checkpoint's
behavior at line 165.

**Data flow after fix:** operator sends `cancel` → `prLandingCancelSignal` handler sets
`cancelled = true` → the next loop checkpoint (babysit poll wakes on `cancelled`; repair loop
head; stage-agent retry head) observes it and throws `PrLandingCancelledError` → top-level
`catch` sets `phase: 'done'`, `outcome: 'cancelled'`, returns `state` → `finally` calls
`cleanupWorkspace`. The brake-checkpoint cancel path (`waitAtBrake` returning `'cancelled'`,
callers `return state`) is unchanged, so both cancel-termination mechanisms continue to yield
`outcome: 'cancelled'` + cleanup.

**Testing:** Add regression tests to `packages/workflows/src/pr-landing.test.ts` (the file already
mocks `@temporalio/workflow`, activities, and `condition`). Capture the handler registered via
`setHandler` for the cancel signal (make the `defineSignal` mock return a per-name token, or key
off registration order, and capture the cancel handler in `setHandler`). Two cases:

- **Babysit-loop cancel:** feed a snapshot that keeps `babysitDecision` returning `'waiting'`
  (e.g. `ciStatus: 'pending'`, no unresolved threads/comments) so the loop parks on the poll.
  Drive the poll `condition` mock to invoke the captured cancel handler (set `cancelled`) and
  resolve. Assert `prLanding(...)` **resolves** (does not hang) with `outcome: 'cancelled'`,
  `phase: 'done'`, and that `cleanupWorkspace` was called; assert `mergePr` was **not** called
  after cancel.
- **Repair-loop cancel:** feed a snapshot/verdicts that keep `validateHead` iterating (full or
  review verdict `fail`, `nextRepairAction` → `continue`), invoke the cancel handler before/at an
  iteration boundary, and assert the workflow terminates with `outcome: 'cancelled'` and
  `cleanupWorkspace` was called, rather than looping.

Against the current code these tests hang / never reach `'cancelled'`; after the fix they pass.
Existing `prLanding` tests (green-path merge, manual, blocked, external-workspace cleanup) and the
contracts/policies tests must remain green.

## Assumptions

- **Cancel terminates as `outcome: 'cancelled'`, not `failed` or a new status.** The workflow's
  existing cancel paths (`waitAtBrake` and the budget checkpoint) already produce
  `outcome: 'cancelled'`; I follow that rather than introducing new `PrLandingState` vocabulary
  (respects the fixed contract vocabulary rule in AGENTS.md). This intentionally differs from
  `dev-cycle-pr-repair.ts`, which uses `status: 'failed'` — `prLanding` has a dedicated
  `'cancelled'` outcome and already uses it, so matching the *file's own* convention is correct.
- **Cooperative checkpoints are sufficient; no mid-activity preemption.** Cancel is honored at
  loop/poll boundaries, bounding latency to one iteration (≤ ~5s on the babysit poll). This
  matches the repo-wide idiom and the issue's framing ("outside brake checkpoints" = the loop
  bodies), so I do not pursue `CancellationScope`-based interruption.
- **A single post-poll check covers both "cancel during poll" and "cancel during prior
  iteration".** Because `cancelled` latches to `true` and the poll predicate includes it, the
  next poll resolves immediately and the check throws — no separate top-of-loop guard is needed in
  `babysitAndMerge` beyond the post-poll check. (The repair loop and stage-agent retry loop have no
  poll, so each gets an explicit head-of-loop check.)
- **Extending the existing `pr-landing.test.ts` is the right home for the regression tests**
  (workflow behavior), rather than adding a new file or extending the contracts schema tests.
- **`getPrSnapshot` labeled `pending` yields `babysitDecision === 'waiting'`.** Consistent with the
  policy used elsewhere: not green → not `merge_ready`; readable and under caps → not `braked`; no
  failure/threads → not `actionable`; falls through to `waiting`. This is the state that keeps the
  babysit loop parked on the poll for the cancel test.

## Out of scope (noted, not fixed)

Mid-activity cancellation (interrupting a running `runAgent`/`mergePr` the instant a cancel
arrives) is deliberately not implemented — it is Approach B and would change activity/retry
semantics. With this fix, an in-flight activity completes and cancel is honored at the next loop
checkpoint, which is the intended cooperative behavior.

## Self-review

- No placeholders / TBD.
- No contradictions: the recommendation (A), the design edits, the data-flow, and the
  assumptions all describe the same set of loop-boundary cancel checkpoints reusing the existing
  `PrLandingCancelledError` path.
- Scope: one coherent change — make the two long-running loops (and the stage-agent retry inside
  them) observe `cancelled` at their checkpoints — plus regression tests. Preemptive cancellation
  is explicitly deferred, not silently bundled.

## Brainstorm Summary
**Approaches considered:** (A) add cooperative cancel checkpoints at the babysit-poll and repair/stage-agent loop boundaries, reusing the existing `PrLandingCancelledError` path; (B) preemptive interruption via Temporal `CancellationScope`; (C) a shared `checkCancel()` before every activity call.
**Chosen approach:** (A) cooperative loop-boundary checkpoints.
**Why (decisive reasons):** Fixes exactly the reported defect (loop bodies ignore `cancelled` outside brakes) with ~3 tiny edits — make the babysit poll wake on `cancelled` and add `if (cancelled) throw new PrLandingCancelledError()` at the babysit-poll, `validateHead`, and `runStageAgent` loop heads — reusing the already-correct catch→`outcome:'cancelled'`→`cleanupWorkspace` teardown. It mirrors the #120 fix and the repo's cooperative-checkpoint idiom, adds only pure boolean checks (determinism-safe), and avoids B/C's larger surface and replay risk.
**Key risks/assumptions:** Cancel terminates as `outcome:'cancelled'` (the file's own convention, not `failed`); cancel is honored at loop checkpoints (≤ ~1 poll of latency), not mid-activity; a single latched post-poll check covers cancels arriving during either the poll or the prior iteration.
