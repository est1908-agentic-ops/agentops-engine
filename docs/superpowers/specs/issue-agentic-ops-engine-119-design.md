# Design — issue-agentic-ops-engine-119

## Goal

Fix two related defects in `packages/workflows/src/dev-cycle-pr-repair.ts`:

1. **The `pr_babysit` loop ignores `babysitDecision`'s `'braked'` verdict.** The loop
   handles `'merge_ready'` and `'actionable'`, then treats *everything else* — including
   `'braked'` — as `'waiting'` via a fall-through `waiting += 1` counter. As a result, the
   two conditions that `babysitDecision` reports as `'braked'` for a reason —
   `ciStatus === 'unreadable'` (a permission problem no amount of polling fixes) and
   `rounds >= cap` (the babysit-round cap) — are silently swallowed. Instead of blocking for
   a human, the workflow keeps polling. The braked-for-`unreadable` case in particular loops
   forever burning polls on a PR the credentials can't read.

2. **A dead `stopSignal` handler.** `stopSignal` is defined (line 28) and its handler sets
   `_stopRequested = true` (line 65), but `_stopRequested` is never read anywhere in the
   workflow. Operators sending the `stop` signal — a documented resume/control signal per
   the PR-review-repair spec (§6) — have no effect.

The sibling workflow `packages/workflows/src/dev-cycle.ts` already implements both behaviors
correctly and is the reference for the intended semantics.

## Approaches considered

### Approach A — Fix in place, mirroring `dev-cycle.ts` (recommended)

Add an explicit `if (decision === 'braked')` branch to the babysit loop that sets
`status = 'blocked'` / `blockReason = 'babysit-brake'`, awaits `waitForResumeOrCancel()`, and
on resume lifts the no-progress cap and resets the counter — exactly as `dev-cycle.ts` lines
433–450. Keep incrementing the no-progress `waiting` counter only on the `'waiting'` decision
(so it still feeds the next `babysitDecision` call) and delete the now-redundant manual
`if (waiting >= MAX_BABYSIT_WAITS)` block, since the policy owns that brake. Separately, wire
`stopRequested` to a graceful checkpoint (return `status = 'pending'`) between units of work,
matching `dev-cycle.ts`.

- **Trade-off:** Duplicates control-flow logic that already exists in `dev-cycle.ts`; the two
  loops must stay in sync by discipline, not by structure.
- **Cost:** Low. Localized edits to one file plus tests.

### Approach B — Extract a shared babysit/repair control module

The PR-review-repair spec (§104) already anticipates factoring the common repair/babysit
control flow into a shared module inside `packages/workflows` so `devCycle` and
`devCyclePrRepair` stay in sync. This would make the braked-handling bug structurally
impossible to reintroduce.

- **Trade-off:** Much larger blast radius — refactors the working `dev-cycle.ts` babysit loop
  too, risking regressions in the primary workflow while fixing a bug in the secondary one.
  Determinism-boundary sensitive (`packages/workflows` hard rules).
- **Cost:** High, and out of scope for a targeted bug fix.

### Approach C — Remove the `stopSignal` handler entirely and only fix the braked bug

Treat the dead handler as accidental scaffolding and delete `stopSignal` + `_stopRequested`,
fixing only the braked verdict.

- **Trade-off:** The PR-review-repair spec (§167) explicitly lists `stop` among the supported
  signals (`resume`, `stop`, `cancel`) with the same handling as `devCycle`. Removing it
  contradicts the design authority and drops a real operator control.
- **Cost:** Low, but wrong — it resolves the "dead handler" by deleting intended behavior
  rather than completing it.

## Chosen approach

**Approach A.** It fixes both defects with the smallest safe change and brings
`devCyclePrRepair` in line with the already-correct, spec-blessed semantics of `dev-cycle.ts`.
Approach B is the right *eventual* structure (and the spec calls for it), but performing that
refactor here would put the primary `devCycle` workflow at risk to fix a bug in the secondary
one — that consolidation should be its own change with its own spec update. Approach C is
rejected because the spec treats `stop` as a first-class supported signal; the correct
resolution of a "dead handler" is to wire it up, not delete a documented capability.

## Assumptions

- **Where `stopRequested` takes effect.** `dev-cycle.ts` checks `stopRequested` only after its
  pre-implement stages and returns `status = 'pending'`. `devCyclePrRepair` has no
  pre-implement stages, so I will check `stopRequested` at natural between-rounds checkpoints:
  at the top of the main repair `while` loop (before starting a new implement round) and at
  the top of the babysit loop (after the poll `sleep`, before doing work). On stop the
  workflow sets `status = 'pending'` and returns `state` (graceful pause, no cleanup that
  would discard the workspace — matching `devCycle`'s stop semantics of returning `pending`).
  *Assumption:* pausing to `pending` between rounds — rather than mid-agent-run — is the
  intended granularity, consistent with `devCycle`.
- **Cleanup on stop.** `devCycle`'s stop path returns without calling `cleanupWorkspace`
  (unlike the cancel/fail path). I will match that: a `stop` is a pause, so the workspace is
  left intact for a later resume.
- **`waiting` counter semantics.** The local `waiting` counter is retained solely as the
  `waitingRounds` argument fed into `babysitDecision`; the policy — not the workflow — decides
  when that count means `'braked'`. The workflow no longer duplicates the threshold check.
- **`blockReason` value.** Both braked sub-causes (`unreadable`, round cap, waiting cap) map
  to the existing `blockReason = 'babysit-brake'`, matching `dev-cycle.ts`. No new
  contract/vocabulary value is introduced (AGENTS.md fixed-vocabulary rule respected).

## Design

### Files changed

- **`packages/workflows/src/dev-cycle-pr-repair.ts`** (behavior fix):
  - Rename `_stopRequested` → `stopRequested` (it is now read) and keep the `setHandler`.
  - Add a `stopRequested` graceful-pause checkpoint at the top of the main repair loop and at
    the top of the babysit loop: `if (stopRequested) { state.status = 'pending'; return state; }`.
  - In the babysit loop, add an explicit `if (decision === 'braked')` branch that sets
    `status = 'blocked'` / `blockReason = 'babysit-brake'`, awaits `waitForResumeOrCancel()`,
    and on cancel takes the failed/cleanup path (as the existing budget path does) while on
    resume lifts the no-progress cap (a `maxBabysitWaits` local promoted to
    `Number.MAX_SAFE_INTEGER`) and resets `waiting = 0`, then `continue`s. This mirrors
    `dev-cycle.ts` lines 433–450.
  - Replace the fall-through `waiting += 1; if (waiting >= MAX_BABYSIT_WAITS) { ... }` block
    with a plain `waiting += 1` on the `'waiting'` decision (the manual brake is now owned by
    the policy via the `braked` branch). Introduce a `maxBabysitWaits` local (initialized to
    `MAX_BABYSIT_WAITS`) passed to `babysitDecision` so the resume escape-hatch can lift it,
    matching `dev-cycle.ts`.

- **`packages/workflows/src/dev-cycle-pr-repair.test.ts`** (new, or added cases):
  - Test that when `getPrFeedback` yields `ciStatus === 'unreadable'`, the workflow reaches
    `status = 'blocked'` / `blockReason = 'babysit-brake'` (not endless polling).
  - Test that exceeding `maxBabysitRounds` / the waiting cap brakes to `babysit-brake`, and
    that a `resume` signal lifts the cap and continues.
  - Test that a `stop` signal causes the workflow to return `status = 'pending'`.
  - Follow the Temporal test-env / mock-activity patterns already used in
    `packages/workflows/src/dev-cycle.test.ts`.

### Data flow

The babysit loop already passes `waiting` and `MAX_BABYSIT_WAITS` into `babysitDecision`, so
the policy already computes the correct `'braked'` verdict — the *only* gap is that the caller
discards it. No change to `packages/policies` or `packages/contracts` is needed; the pure
policy is already correct (and already unit-tested for the `braked` cases). This keeps the
change inside `packages/workflows` and off the determinism-sensitive policy package.

### Error handling

- `braked` → `blocked` + `babysit-brake`, resumable by an operator (`resume`) or terminable
  (`cancel` → failed + `cleanupWorkspace`, via the existing `RepairCancelledError`/cancel
  path).
- `stop` → graceful `pending` return, workspace left intact for later resumption.
- No new failure modes introduced; the change only routes an already-computed verdict and an
  already-defined signal to their intended handlers.

## Self-review

- No placeholders or TBDs.
- Sections are consistent: the recommendation, assumptions, and design all describe the same
  in-place fix mirroring `dev-cycle.ts`.
- Scope is one coherent change: both defects live in the same file, share the same root cause
  (control signals/verdicts computed but not acted on), and are fixed by aligning
  `devCyclePrRepair`'s loop with the reference `devCycle` loop. The broader shared-module
  refactor (Approach B) is explicitly deferred.

## Brainstorm Summary
**Approaches considered:** (A) fix in place by mirroring the already-correct `dev-cycle.ts` babysit loop; (B) extract a shared repair/babysit control module used by both workflows; (C) just delete the dead `stopSignal` handler and fix only the braked verdict.
**Chosen approach:** (A) targeted in-place fix in `dev-cycle-pr-repair.ts`.
**Why (decisive reasons):** Smallest safe change; brings the secondary workflow in line with the spec-blessed `devCycle` semantics without risking the primary workflow. B is the right eventual structure but too broad for a bug fix and belongs in its own spec'd change; C contradicts the PR-review-repair spec, which lists `stop` as a supported signal — the fix is to wire it up, not delete it.
**Key risks/assumptions:** `stop` pauses to `status='pending'` between rounds (no mid-run interruption, workspace left intact), matching `devCycle`; both braked sub-causes map to the existing `babysit-brake` blockReason (no new vocabulary); the policy already computes `braked` correctly, so no `policies`/`contracts` change is needed.
