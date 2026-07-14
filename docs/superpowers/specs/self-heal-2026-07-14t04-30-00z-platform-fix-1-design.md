# Design — self-heal-2026-07-14t04-30-00z-platform-fix-1

## Problem

`ScheduleHandle.update()` in `@temporalio/client` takes an **updater function**
`(previous) => newSchedule` whose return value must be a **flat**
`ScheduleUpdateOptions` — `{ action, spec, memo, searchAttributes }`.

Our two update sites instead return a **nested** shape
`{ schedule: { spec, action }, memo, searchAttributes }`:

- `packages/activities/src/schedule-ops.ts` — `applyScheduleChanges`, `toUpdate` loop (~L151-165).
- `packages/activities/src/create-activities.ts` — the activity `applyScheduleChanges`, update branch (~L469-473).

Because `deps.scheduleClient` is an untyped cast (`tc.schedule as unknown as ScheduleClientLike`)
and our local `ScheduleUpdateOpts` type (`schedule-ops.ts` L37-41) *itself declares the nested
shape*, the wrong shape type-checks locally but is silently ignored by the Temporal server at
runtime. Reconcile appears to succeed while the schedule's fields are never actually changed. The
observable symptom: schedules such as `agent:Artem private agents:gdebenz-watch` never get their
corrected (slugified) task queue, so their workflow instances keep landing on a non-existent /
stale queue and get stuck. The bug is self-perpetuating because every reconcile cycle "succeeds"
without fixing anything.

A correct fix already exists on abandoned branch
`agentops/self-heal-2026-07-14t03-00-00z-platform-fix-1` (commit `f6511bd`). This design reuses it.

## Candidate approaches

### A. Flat-shape fix + correct the local type (recommended)
Change `ScheduleUpdateOpts` to the flat SDK shape (`action`, `spec`, `memo`, `searchAttributes`),
fix both updater return sites to match, correct the two regression tests to pass/assert the flat
shape, and update the explanatory comments to describe the flat contract (and why the old nested
shape was a silent no-op). This is exactly commit `f6511bd`.

- **Pros:** Fixes the runtime shape *and* the type that let the wrong shape compile — so the class
  of bug can't silently recur. Keeps the deliberately-minimal `ScheduleHandleLike`/`ScheduleClientLike`
  surface that lets tests inject `vi.fn()` mocks. Smallest change that is internally consistent.
- **Cons:** Touches two prod files + two test files + a shared type; slightly larger than a
  one-line edit. (Acceptable — the extra surface is the type/tests that make the fix durable.)

### B. Fix only the two call-site return shapes, leave the type nested
Edit just the two `h.update?.(() => (...))` returns to the flat shape.

- **Rejected:** The returns would no longer satisfy the local nested `ScheduleUpdateOpts`, so this
  either fails `pnpm typecheck` or forces an `any` escape hatch. It also leaves the misleading type
  in place, so the next author can reintroduce the nested shape and it will again compile-but-no-op.
  Fails the goal of preventing recurrence.

### C. Replace the local minimal type with the real `@temporalio/client` `ScheduleUpdateOptions`
Import the SDK's own type instead of maintaining a hand-written minimal surface.

- **Rejected:** The minimal `ScheduleHandleLike`/`ScheduleClientLike`/opts types exist *by design*
  so tests can inject `vi.fn()` mocks without depending on the full SDK object graph (documented in
  the file's comments and consistent with AGENTS.md's ports/testability conventions). Coupling to
  the full SDK shape enlarges blast radius and the test-mock burden for no correctness gain over A.

## Recommendation

**Approach A** — reuse commit `f6511bd`. It is the minimum change that fixes both the runtime
behavior and the local type that allowed the wrong shape to compile, while preserving the
intentionally-minimal, test-friendly client surface.

## What changes (components/files, not diffs)

- `packages/activities/src/schedule-ops.ts`
  - `ScheduleUpdateOpts` interface: nested `{ schedule: { spec, action } }` → flat
    `{ action, spec, memo, searchAttributes }`.
  - `applyScheduleChanges` `toUpdate` loop: updater returns the flat shape.
  - Update the block comment on `ScheduleHandleLike` to describe the flat contract and record the
    prior nested-shape silent-no-op bug.
- `packages/activities/src/create-activities.ts`
  - Activity `applyScheduleChanges` update branch: updater returns the flat shape.
  - Update the explanatory comment to match (flat contract; best-effort `.catch`).
- `packages/activities/src/schedule-ops.test.ts`
  - Regression assertion: `result.action.taskQueue` (was `result.schedule.action.taskQueue`).
- `packages/activities/src/create-activities.test.ts`
  - Feed the updater a flat `previous` description and assert `update.lastResult.action.taskQueue`
    equals the slugified queue (was nested).

No contract (zod) changes: `ScheduleUpdateOpts` is a local activity-layer helper type, not a
cross-package data shape in `packages/contracts`. No workflow/policy/determinism-boundary impact.

## Verification

`pnpm lint && pnpm typecheck && pnpm test` green; the two regression tests now assert the flat
shape and prove the corrected `taskQueue` reaches the updater result (and thus the server) on the
next reconcile cycle. `pnpm e2e` if applicable (change touches `activities`).

## Assumptions

- **Reuse vs. reimplement:** The task allows either; I reuse `f6511bd` verbatim since it is already
  correct, minimal, and test-covered. Reimplementing would risk drift for no benefit.
- **`ScheduleUpdateOpts` is not a public contract:** It lives in `packages/activities`, not
  `packages/contracts`, so changing it needs no zod schema update and breaks no cross-package
  consumers. Verified it is only referenced within the activities package's schedule ops + tests.
- **Flat `{ action, spec, memo, searchAttributes }` is the correct SDK shape:** Confirmed by the
  reference commit and the `@temporalio/client` `ScheduleUpdateOptions` contract; the nested
  `{ schedule: {...} }` shape has no corresponding SDK field and is silently dropped.
- **Scope:** This is one coherent change — a single shape/type fix applied at its two call sites
  plus the matching tests and comments. No unrelated refactors are bundled in.

## Self-review

No placeholders; sections are consistent (Approach A == the recommendation == the file list ==
commit `f6511bd`); scope is one coherent change as stated above.

## Brainstorm Summary
**Approaches considered:** (A) fix the flat updater shape *and* correct the local `ScheduleUpdateOpts` type + tests/comments; (B) patch only the two call-site returns and leave the type nested; (C) drop the local minimal type and import the SDK's `ScheduleUpdateOptions`.
**Chosen approach:** A — reuse the existing correct fix on abandoned commit `f6511bd`.
**Why (decisive reasons):** A fixes both the runtime no-op *and* the local type that let the nested shape compile, so the bug can't silently recur; it keeps the deliberately-minimal, mock-friendly client surface. B fails typecheck / leaves the misleading type; C needlessly couples tests to the full SDK.
**Key risks/assumptions:** `ScheduleUpdateOpts` is an activity-layer helper (not a `contracts` zod shape), so no contract change is needed; the flat `{ action, spec, memo, searchAttributes }` shape is the correct `@temporalio/client` contract; verified by the two regression tests asserting the slugified `taskQueue` reaches the updater result.
