# Plan — self-heal-2026-07-14t04-30-00z-platform-fix-1

## Goal

Fix the `ScheduleHandle.update()` updater return shape so it matches the flat
`@temporalio/client` `ScheduleUpdateOptions` contract (`{ action, spec, memo,
searchAttributes }`) instead of the nested `{ schedule: { spec, action }, memo,
searchAttributes }`. The nested shape type-checks against our local (also-wrong)
`ScheduleUpdateOpts` type but is silently dropped by the Temporal server at runtime, so
reconcile "succeeds" while schedules such as `agent:Artem private agents:gdebenz-watch`
never receive their corrected (slugified) task queue — their workflow instances keep
landing on a stale/non-existent queue and get stuck.

Chosen approach (per design doc): **Approach A** — reuse commit `f6511bd` verbatim. It
fixes both the runtime shape *and* the local `ScheduleUpdateOpts` type that let the wrong
shape compile, plus the two regression tests and explanatory comments. I confirmed the four
target files currently match the exact "before" state of `f6511bd`, so it applies cleanly.

## Files that change (in order)

1. **`packages/activities/src/schedule-ops.ts`** — de-risking / foundational change first.
   - `ScheduleUpdateOpts` interface (L37-41): nested `{ schedule: { spec, action } }` →
     flat `{ action, spec, memo, searchAttributes }`.
   - `ScheduleHandleLike` block comment (L43-49): describe the flat contract and record the
     prior nested-shape silent-no-op bug.
   - `applyScheduleChanges` `toUpdate` loop (L151-165): updater returns the flat shape.
   - **Why first:** the type is the shared contract; fixing it first makes the two call-site
     edits type-checked against the corrected shape (any missed site fails `pnpm typecheck`).
   - **Verify:** `pnpm --filter @agentops/activities typecheck` (or repo-level `pnpm typecheck`).

2. **`packages/activities/src/create-activities.ts`** — activity `applyScheduleChanges`
   update branch (L462-473).
   - Updater returns the flat shape (`action`, `spec`, `memo`, `searchAttributes`);
     preserve the best-effort `?.catch(() => {})`.
   - Update the explanatory comment to describe the flat contract.
   - **Verify:** `pnpm typecheck` stays green (this return must now satisfy the corrected type).

3. **`packages/activities/src/schedule-ops.test.ts`** — regression assertion (L51):
   `result.schedule.action.taskQueue` → `result.action.taskQueue`.
   - **Verify:** `pnpm --filter @agentops/activities test schedule-ops`.

4. **`packages/activities/src/create-activities.test.ts`** — regression test (L849, L867):
   - Feed the updater a flat `previous` description
     (`{ action: { taskQueue: 'proj-Artem private agents' }, spec: { cronExpressions: ['0 */2 * * *'], timezone: 'UTC' } }`).
   - Assert `update.lastResult.action.taskQueue === 'proj-artem-private-agents'`.
   - **Verify:** `pnpm --filter @agentops/activities test create-activities`.

## Implementation method

Apply commit `f6511bd` by cherry-pick; if it does not apply cleanly, reproduce its diff by
hand (the four hunks are small and fully captured above). The current working tree matches
that commit's parent for all four files, so a clean apply is expected.

## Verification (definition of done)

Per AGENTS.md hard rule 6, all must be green locally:

1. `pnpm lint`
2. `pnpm typecheck` — proves both updater call sites satisfy the corrected flat
   `ScheduleUpdateOpts`; a leftover nested site would fail here.
3. `pnpm test` — the two regression tests now pass a flat `previous` and assert the
   slugified `taskQueue` reaches the updater result (i.e. would reach the server on the
   next reconcile cycle).
4. `pnpm e2e` — required because the change touches `packages/activities`.

Then open a PR (conventional-commit `fix(activities):` title, `agentops` label per repo
convention), with a body explaining the nested→flat shape fix and that it corrects the
silent reconcile no-op.

## Sequencing / safety notes

- The type fix (step 1) is deliberately first: it is the shared contract, so correcting it
  turns any remaining nested call site into a compile error, guaranteeing the two prod edits
  are consistent. Reordering (call sites before type) would let a half-done edit still
  compile, hiding a miss.
- Test edits (steps 3-4) come after prod edits so that a failing test unambiguously signals
  a prod-code problem, not a test that was updated ahead of the code.
- No contracts/zod change: `ScheduleUpdateOpts` is an activity-layer helper type in
  `packages/activities`, not a cross-package shape in `packages/contracts`. No
  workflow/policies/determinism-boundary impact.

## Assumptions (resolved without a human)

- **Reuse vs. reimplement `f6511bd`:** Reuse verbatim. It is already correct, minimal, and
  test-covered; reimplementing risks drift for no benefit. (Task prompt permits either.)
- **`ScheduleUpdateOpts` is not a public contract:** It lives only in `packages/activities`
  (schedule-ops + its tests), so no zod schema update is required and no cross-package
  consumer breaks.
- **Flat `{ action, spec, memo, searchAttributes }` is the correct SDK shape:** Confirmed by
  the reference commit and the `@temporalio/client` `ScheduleUpdateOptions` contract; the
  nested `{ schedule: {...} }` has no corresponding SDK field and is silently dropped.
- **Files apply cleanly:** Verified the current schedule-ops.ts, create-activities.ts, and
  both test files match `f6511bd`'s parent state, so the reference diff applies without
  conflict.
- **Scope:** One coherent change — a single shape/type fix at its two call sites plus the
  matching tests and comments. No unrelated refactors bundled in.
