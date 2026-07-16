# Design — [bughunt] prLanding babysit loop ignores cancel signal in steady state

Task: `issue-agentic-ops-engine-128`
Date: 2026-07-16

## Goal

`prLanding` (in `packages/workflows/src/pr-landing.ts`) runs a durable babysit loop
(`babysitAndMerge`) that polls a PR's CI/review state every `DEFAULT_BABYSIT_POLL_MS`
(5s) and reacts by merging, repairing, braking, or continuing to wait. A `cancel`
signal sets a `cancelled` flag, but that flag is only ever *read* at the three brake
checkpoints (`waitAtBrake`) and the budget-exceeded checkpoint (`waitForResumeOrCancel`).

In the **steady state** — when `babysitDecision` returns `'waiting'` (PR healthy but not
yet merge-ready, CI pending, no new actionable feedback) — the loop:

1. parks on `await condition(() => woke, DEFAULT_BABYSIT_POLL_MS)` (line 264), whose
   predicate observes only `woke`, never `cancelled`; and
2. falls through to `waiting += 1` (line 386) and re-loops, with no cancel check on
   that path.

Consequently a cancel that arrives while the loop is idly polling is stored but never
acted on. In the ordinary case it is eventually honored once `waiting` reaches
`maxBabysitWaits` and the decision becomes `'braked'` — but only after up to
`MAX_BABYSIT_WAIT_MS` (20 minutes) of pointless polling and `getPrSnapshot` activity
calls. Worse: once a babysit-brake has been resumed, `maxBabysitWaits` is set to
`Number.MAX_SAFE_INTEGER` (line 347), so the loop returns `'waiting'` forever and
**never re-brakes → the workflow never terminates on cancel.**

This is the same class of defect fixed for `devCyclePrRepair` in #120 (a discarded
cancel result at a babysit checkpoint), surfacing here in a different idiom: not a
discarded return value at a brake, but an unobserved flag in the polling steady state.

The goal is: a `cancel` signal received at any point in the babysit loop, including
steady-state polling, promptly terminates the workflow with `outcome = 'cancelled'`
and the usual workspace cleanup — with no behavior change to the merge/repair/brake
paths, and no change to `packages/policies`.

## Approaches considered

### Approach A — Observe `cancelled` in the poll predicate and return at the loop top (recommended)

Two coordinated edits inside `babysitAndMerge`:

- Widen the steady-state wait to wake immediately on cancel:
  `await condition(() => woke || cancelled, DEFAULT_BABYSIT_POLL_MS)`.
- Immediately after the wait, before computing the decision, check the flag and
  terminate using the loop's existing cancel idiom (matching `waitAtBrake`):
  `if (cancelled) { state.phase = 'done'; state.outcome = 'cancelled'; return state; }`.

Because this check sits at the top of the `while (true)` body, it covers **every**
branch (waiting, merge_ready, actionable, braked) uniformly: control always returns to
the loop top, so no per-branch cancel handling is needed beyond what already exists.
The `finally` block in the top-level `try` still runs `cleanupWorkspace`.

- Trade-off: introduces one small duplication of the `phase='done'; outcome='cancelled'`
  teardown that `waitAtBrake` also performs. Minor, and localized.
- Cost/complexity: ~4 lines of workflow code + one regression test. No contract or
  policy change.

### Approach B — Route steady-state cancel through `PrLandingCancelledError`

Add the poll-predicate change, but on cancel `throw new PrLandingCancelledError()` and
let the existing top-level `catch` (lines 427-432) convert it to
`outcome = 'cancelled'`. This mirrors how the budget path signals cancel.

- Trade-off: `babysitAndMerge` already has a well-established, exception-free cancel
  idiom — `waitAtBrake` returns `'cancelled'` and each caller does `return state`.
  Mixing a thrown sentinel into the same function for one path is inconsistent and
  makes the loop harder to reason about (two cancel exits with different mechanics).
- Cost/complexity: similar line count, but worse local consistency.

### Approach C — Extract a shared `cancelState()` helper and refactor all cancel exits

Introduce a helper that performs the `phase='done'; outcome='cancelled'; return state`
teardown, and use it from both `waitAtBrake` and the new steady-state check (and
optionally elsewhere) to remove duplication.

- Trade-off: cleaner in the abstract, but it touches the correctly-working brake paths
  to fix a steady-state bug, widening the blast radius of a targeted bugfix and the set
  of tests that must be re-verified. Against the repo's "smallest coherent change"
  bias for a bughunt task.
- Cost/complexity: larger diff, more review surface, no behavioral benefit over A.

## Chosen approach

**Approach A.** It is the minimal change that fixes the reported defect, it reuses the
loop's existing cancel idiom verbatim (so the fix reads like the surrounding code), and
placing the check at the loop top guarantees the whole loop — not just the `'waiting'`
branch — honors cancel, which also future-proofs new branches.

- **B is rejected** because it fragments `babysitAndMerge`'s cancel handling across two
  mechanisms (return-state vs. thrown sentinel) for no gain; the exception idiom in this
  file is reserved for the budget path inside `runStageAgent`.
- **C is rejected** because refactoring the already-correct brake cancel paths to dedupe
  a two-line teardown expands a targeted bugfix into a structural change, contrary to
  the definition-of-done bias toward one coherent, low-risk change. The duplication A
  leaves behind is trivial and can be cleaned up separately if ever desired.

## Design

### Files changed

- **`packages/workflows/src/pr-landing.ts`** — inside `babysitAndMerge`:
  - Line 264: change the steady-state poll predicate from `() => woke` to
    `() => woke || cancelled` so a cancel signal wakes the loop immediately instead of
    waiting out the 5s poll timeout.
  - Immediately after that wait (before `getPrSnapshot` at line 265): add
    `if (cancelled) { state.phase = 'done'; state.outcome = 'cancelled'; return state; }`.

  No other lines change. The three `waitAtBrake` cancel checks, the budget-path
  `waitForResumeOrCancel`/`PrLandingCancelledError` handling, the resume handler, and
  the top-level `try/catch/finally` (including `cleanupWorkspace`) are all unchanged.

- **`packages/workflows/src/pr-landing.test.ts`** — add one regression test:
  drive `prLanding` into the babysit loop in a steady `'waiting'` state (a snapshot with
  `ciStatus: 'pending'` / no actionable comments so `babysitDecision` returns
  `'waiting'`), deliver the `cancel` signal, and assert the workflow terminates with
  `outcome === 'cancelled'` and `cleanupWorkspace` called exactly once. The existing
  test file mocks `@temporalio/workflow` (including `condition` and `setHandler`), so the
  test will capture the registered cancel handler and invoke it to set `cancelled`, then
  let the mocked `condition` resolve so the loop-top check fires. This mirrors the
  regression-test approach introduced for #120 in `dev-cycle-pr-repair.test.ts`.

### Data flow / control flow after the fix

Signal delivery is already intact (CLI → dev-cycle `cancelSignal` handler forwards
`prLandingCancelSignal` to the child; the child's handler sets `cancelled = true`). The
fix only changes what the babysit loop *does* with that flag:

1. Loop parks on `condition(() => woke || cancelled, poll)`.
2. On cancel the predicate is now true → wait returns immediately (no 5s lag, no extra
   `getPrSnapshot`).
3. Loop-top check sees `cancelled`, sets `phase='done'`/`outcome='cancelled'`, and
   returns `state`.
4. Top-level `finally` runs `cleanupWorkspace` (when the workflow owns the workspace),
   exactly as for every other terminal path.

This holds regardless of `maxBabysitWaits`, so the "never terminates after a
babysit-brake resume" path is closed.

### Error handling

No new error types. Cancel in the babysit loop uses the same return-state idiom as
`waitAtBrake`. The budget path's `PrLandingCancelledError` and its top-level catch are
untouched. `outcome = 'cancelled'` is an existing `PrLandingState` value already
produced by `waitAtBrake`, so no `packages/contracts` change is required.

### Alignment with the vision & hard rules

- Consistent with `docs/software-lifecycle-vision.md`: "Durable autonomy — workflows are
  … bounded by brakes, and able to wait for human input without losing progress." Honoring
  cancel promptly is part of that durability contract; no lifecycle stage or vocabulary
  changes, so the vision document does not need updating.
- Determinism boundary respected: only workflow-safe primitives (`condition`, flag reads,
  state mutation) are used; no new I/O, timers, `Date.now()`, or `Math.random()`.
- `packages/policies` is not touched — `babysitDecision` correctly has no notion of
  cancellation; cancel is purely the workflow's responsibility, so no policy test or
  semantic note is required.
- No contract change; `outcome = 'cancelled'` already exists in the schema.

### Verification

`pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm e2e` since the change touches a
workflow. The new unit test is the primary regression guard; existing prLanding tests
must remain green to prove the merge/repair/brake paths are unaffected.

## Assumptions

- **Cancel outcome is `'cancelled'`, not `'failed'`.** `prLanding`'s own idiom
  (`waitAtBrake`) already maps cancel to `outcome = 'cancelled'`, so the steady-state
  path uses the same. (#120's `devCyclePrRepair` used `status = 'failed'`, but that is a
  different state machine; matching prLanding's local idiom is correct here.)
- **The steady state to reproduce is `babysitDecision === 'waiting'`.** That is the only
  decision whose loop branch (`waiting += 1`) never touches a cancel-aware helper, so it
  is where the bug manifests; the regression test targets it.
- **A loop-top check is sufficient and preferred over per-branch checks.** All branches
  either `return`, `continue`, or fall through to the loop top, so a single check at the
  top covers every path; no branch can loop again without passing it.
- **No new cancel plumbing is needed.** The signal already reaches prLanding and sets
  `cancelled`; only the loop's reading of it is fixed.
- **Scope is a single coherent change.** This is exactly one bug in one function plus its
  regression test. No unrelated work is bundled.

## Self-review

- No placeholders or TBDs.
- No contradictions: every section treats the defect as the steady-state (`'waiting'`)
  polling path, fixed at the loop top; the brake paths are consistently described as
  already-correct and left untouched.
- Scoped to one coherent change (a two-line workflow fix + one regression test), as
  stated under Assumptions.

## Brainstorm Summary
**Approaches considered:** (A) observe `cancelled` in the babysit poll predicate and return with `outcome='cancelled'` at the loop top; (B) throw `PrLandingCancelledError` for the steady-state cancel and rely on the top-level catch; (C) extract a shared cancel-teardown helper and refactor all cancel exits.
**Chosen approach:** A.
**Why (decisive reasons):** Minimal, reuses the loop's existing return-state cancel idiom (`waitAtBrake`), and a single loop-top check covers every branch. B fragments cancel handling into two mechanisms; C expands a targeted bugfix into a refactor of already-correct brake paths.
**Key risks/assumptions:** Cancel maps to `outcome='cancelled'` (prLanding's local idiom, unlike #120's `'failed'`); the reproducible steady state is `babysitDecision === 'waiting'`; no contract/policy change and no new cancel plumbing needed.
