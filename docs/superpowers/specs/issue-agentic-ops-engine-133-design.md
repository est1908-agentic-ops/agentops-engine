# Design — Task issue-agentic-ops-engine-133

**Title:** [bughunt] Deprecated `devCyclePrRepair` babysit loop ignores `babysitDecision`'s brake verdict

## Goal

Fix a latent bug in the **deprecated** `devCyclePrRepair` workflow's babysit loop: it never
handles the `'braked'` verdict that `babysitDecision` returns. `babysitDecision` has four
outcomes (`merge_ready | actionable | waiting | braked`), but the loop only branches on
`merge_ready` and `actionable`, folding `braked` into the same catch-all path as `waiting`.
As a result the policy's immediate-brake signals — unreadable CI (a credential/permission
problem) and an exhausted `maxBabysitRounds` cap — are discarded: instead of blocking for a
human right away, the loop keeps polling for up to `MAX_BABYSIT_WAITS` (240 polls × 5s ≈ 20 min)
of no-op `getPrFeedback` calls before its *local* `waiting` counter happens to trip. The fix
must not break Temporal replay for in-flight histories.

## Approaches considered

**A. Unconditional in-place fix.** Rewrite the loop tail to add an explicit
`if (decision === 'braked')` block mirroring the canonical `dev-cycle.ts` (lines 457–478).
Simplest and most readable. **Trade-off / rejection:** the file header explicitly says
*"Kept replayable for in-flight Temporal histories — do not rewrite this body,"* and AGENTS.md
hard-rule #1 is the determinism boundary. Changing the command sequence (the braked path would
call `condition()` instead of another `sleep`+`getPrFeedback`) would produce a non-determinism
error when Temporal replays an in-flight history that recorded the old polling behavior.
Rejected as unsafe.

**B. Versioned fix behind `patched()` (recommended).** Introduce the corrected `braked`
handling gated by `patched('pr-repair-babysit-brake-v1')`. On replay of pre-patch history the
marker is absent → `patched()` returns `false` → the old (buggy) path replays deterministically.
Any execution that reaches the branch live gets `true` → the corrected path. **Trade-off:**
slightly more code and a permanent version marker, but this is the Temporal-sanctioned mechanism
and the repo already uses exactly this pattern (`patched('shared-pr-landing-v1')` in
`dev-cycle.ts:400`). Cost: low. Chosen.

**C. Do nothing / delete the deprecated workflow.** Since new starts route to `prLanding`, one
could argue the path is dead. **Rejection:** in-flight Temporal histories still reference
`devCyclePrRepair`; deleting it breaks replay far worse (workflow-not-found), and "do nothing"
ignores a filed bug that still affects any currently-running repair workflow. Rejected.

## Chosen approach

**Approach B.** It is the only option that fixes the discarded brake verdict *and* honors both
the "do not rewrite this body" contract and the determinism hard rule, using a mechanism already
established in this codebase. A was rejected on replay-safety; C was rejected because in-flight
histories make both deletion and inaction incorrect.

## Assumptions

- **The bug is purely in the workflow's consumption of the verdict, not in the policy.**
  `babysitDecision` and its tests already correctly return `'braked'` for unreadable CI, the
  round cap, and the no-progress cap. So this change is scoped to `packages/workflows` only — no
  `packages/policies` or `packages/contracts` changes, and therefore no policy-semantics PR note
  is required under AGENTS.md rule #2.
- **The correct braked behavior is the one in `dev-cycle.ts`:** on `braked`, set
  `status='blocked'` / `blockReason='babysit-brake'`, wait for resume-or-cancel (cancel → clean
  teardown returning `status='failed'`, preserving the #120 fix), and on resume lift the
  no-progress cap and reset the counter so babysitting doesn't instantly re-brake. I mirror this
  rather than inventing new semantics.
- **`patched()` is called once at a fixed point** (immediately before the babysit `while` loop)
  and its result stored in a `const`, matching Temporal guidance for deterministic version
  checks.
- **The version id is `pr-repair-babysit-brake-v1`**, following the existing
  `shared-pr-landing-v1` naming convention.

## Design

### Files affected

- `packages/workflows/src/dev-cycle-pr-repair.ts` — the fix.
- `packages/workflows/src/dev-cycle-pr-repair.test.ts` — new coverage.

### `dev-cycle-pr-repair.ts` changes

1. Import `patched` from `@temporalio/workflow` (add to the existing import).
2. Before the babysit `while (true)` loop, adjust the setup so the no-progress cap is mutable and
   compute the version gate once:
   - declare `let maxBabysitWaits = MAX_BABYSIT_WAITS;` alongside `let waiting = 0;`
   - `const brakeFixEnabled = patched('pr-repair-babysit-brake-v1');`
   - pass `maxBabysitWaits` (not the bare constant) as `babysitDecision`'s `maxWaitingRounds`
     argument.
3. Restructure the loop tail:
   - `merge_ready` → `break` (unchanged).
   - **New:** `if (brakeFixEnabled && decision === 'braked') { … }` — set `blocked` /
     `babysit-brake`, `await waitForResumeOrCancel()`; on cancel do the existing inline teardown
     (`stage/status='failed'`, `cleanupWorkspace`, return); on resume set
     `maxBabysitWaits = Number.MAX_SAFE_INTEGER`, `waiting = 0`, `state.stage='pr_babysit'`,
     `continue`.
   - `actionable` → repair (unchanged).
   - **Tail:** when `brakeFixEnabled`, the remaining case is `waiting` → just `waiting += 1`.
     When `!brakeFixEnabled`, retain the *exact* current tail verbatim (the `waiting += 1` plus
     the local `waiting >= MAX_BABYSIT_WAITS` brake block) so replayed old histories are
     behaviorally identical.
4. Update the top-of-function comment to note the versioned brake fix while keeping the
   "kept replayable" warning intact.

### Data flow / error handling

No new activities, signals, contracts, or I/O. The corrected branch reuses the existing
`waitForResumeOrCancel()` helper and `cleanupWorkspace` teardown, so the #120 cancel-during-brake
guarantee is preserved on the new path. Behavior for in-flight replays is unchanged (gated off);
executions reaching the branch live brake immediately on unreadable CI / round-cap instead of
after ~20 min of dead polls.

### Tests (`dev-cycle-pr-repair.test.ts`)

- Add `patched` to the `@temporalio/workflow` mock (default `false`).
- New test, `patched → true`: `getPrFeedback` returns `{ ciStatus: 'unreadable', … }` so
  `babysitDecision` yields `braked`; assert the workflow brakes on the **first** poll
  (`getPrFeedback` called once, then cancel → `status/stage = 'failed'`, `cleanupWorkspace`
  called) — proving the immediate brake rather than 240 polls.
- New test, `patched → false`: same feedback, assert the old behavior (loop keeps polling; brake
  only via the local waiting cap) still holds — locking in replay safety.
- Keep the existing cancel-at-brake test green (it will run under `patched → true`).

### Definition of done

`pnpm lint && pnpm typecheck && pnpm test` green. No behavior change for the active `prLanding`
path, but the workflows package is touched so `pnpm e2e` should be run. No docs/vision change:
the lifecycle is unchanged (this is a bug fix to a deprecated path).

### Scope check

One coherent change — fixing a single discarded-verdict bug in one workflow file plus its tests.
No bundled unrelated work.

## Brainstorm Summary
**Approaches considered:** (A) fix the babysit loop in place to handle `braked`; (B) same fix but
gated behind Temporal `patched()` versioning; (C) do nothing or delete the deprecated workflow.
**Chosen approach:** (B) — add explicit `braked` handling behind `patched('pr-repair-babysit-brake-v1')`.
**Why (decisive reasons):** The loop discards `babysitDecision`'s `braked` verdict, delaying human
escalation by ~20 min of dead polls on unreadable CI / round-cap. (A) violates the file's explicit
"do not rewrite this body" replay contract and the determinism hard rule; (C) breaks in-flight
histories or ignores the bug. `patched()` fixes live executions while replaying old histories
unchanged, and the repo already uses this exact pattern.
**Key risks/assumptions:** Bug is in the workflow's verdict consumption, not the (already-correct)
`babysitDecision` policy, so scope stays in `packages/workflows`; the corrected `braked` branch
mirrors `dev-cycle.ts` and preserves the #120 cancel-during-brake teardown.
