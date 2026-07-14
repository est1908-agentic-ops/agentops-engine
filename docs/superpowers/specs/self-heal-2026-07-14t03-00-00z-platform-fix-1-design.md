# Design — self-heal-2026-07-14t03-00-00z-platform-fix-1

## Goal

Reconcile-driven schedule updates silently no-op at runtime. The activity
`applyScheduleChanges` calls `ScheduleHandle.update(updateFn)` with an updater that
returns a **nested** object — `{ schedule: { spec, action }, memo, searchAttributes }` —
but the real `@temporalio/client` `ScheduleHandle.update` contract expects the updater to
return a **flat** `ScheduleUpdateOptions` object (`{ action, spec, memo, searchAttributes }`,
no `schedule` wrapper). Because `deps.scheduleClient` is a raw
`tc.schedule as unknown as ScheduleClientLike` cast (worker/src/main.ts:453), the wrong
shape type-checks against our locally-defined `ScheduleUpdateOpts` but produces a schedule
object the server rejects/ignores — and the failure is swallowed by the trailing
`.catch(() => {})`. Net effect: every reconcile "succeeds" while existing schedules never
get their fields corrected. The concrete victim is `agent:Artem private agents:gdebenz-watch`,
whose `taskQueue` was never re-slugified even after PRs #79/#99 landed, so its next tick
(2026-07-14T04:00:00Z) will hang on the stale queue.

Fix the updater's return shape to the flat SDK contract, fix the `ScheduleUpdateOpts` /
`ScheduleHandleLike` types in `schedule-ops.ts` so the correct shape is enforced by the
compiler, and correct the regression tests that currently encode the wrong nested shape.

## Approaches considered

1. **Runtime-only patch (drop the `schedule` wrapper in `create-activities.ts` only).**
   Change just the object returned by the updater in the activity, leave the
   `ScheduleUpdateOpts` type and everything else as-is.
   - Trade-off: smallest diff, but leaves the *type* encoding the wrong contract. The type
     is the thing that let the bug type-check in the first place; leaving it wrong invites
     an immediate regression and contradicts the task's explicit ask to fix the types. It
     also leaves the sibling `applyScheduleChanges` in `schedule-ops.ts` (same nested bug)
     broken. Rejected.

2. **Flat shape everywhere, enforced by the shared type (recommended).**
   Redefine `ScheduleUpdateOpts` as the flat `{ action, spec, memo?, searchAttributes? }`
   shape, update `ScheduleHandleLike.update`'s `previous` param to reflect the flat
   description the SDK passes in, fix both updater call sites to return the flat object,
   and correct both regression tests to pass a flat `previous` and assert
   `result.action.taskQueue`. One coherent change; the compiler now rejects the nested
   shape at every call site.
   - Trade-off: touches four files instead of one, but they are all bound by the same
     shared type — a partial fix would fail `pnpm typecheck` (hard rule #6). This is the
     minimum coherent change, not scope creep.

3. **Import the real `@temporalio/client` `ScheduleUpdateOptions` type directly.**
   Replace the local minimal `ScheduleUpdateOpts` with the SDK's own type so the shape can
   never drift from the vendor contract.
   - Trade-off: the local `ScheduleClientLike` / `ScheduleHandleLike` interfaces exist
     precisely so tests can inject a `vi.fn()` mock without materializing the full SDK
     surface (and so the worker can cast the real client onto a small, stable seam). The
     SDK `ScheduleUpdateOptions` pulls in `action`/`spec`/`policies`/`state` variants and
     their required-ness, which would over-constrain the mocks and the reconcile builder
     for no behavioral gain. It also couples this package's public types to the SDK's
     internal type layout. Rejected in favor of a minimal-but-correct local type.

## Chosen approach

Approach 2. It fixes the actual defect (runtime shape) **and** the root cause that let it
compile (the type that encoded the wrong contract), which is exactly what prevents the
regression from recurring. Approach 1 is a strictly weaker subset that leaves a loaded gun
on the table and would not even typecheck once the sibling function is considered. Approach
3 defeats the deliberate test-seam design of the minimal `*Like` interfaces and
over-couples us to vendor internals. The flat shape is the documented `@temporalio/client`
`ScheduleHandle.update` contract: the updater receives the previous schedule description
(flat `.action`/`.spec`/…) and returns a flat `ScheduleUpdateOptions`.

## Assumptions

- **The updater rebuilds the schedule rather than merging `previous`.** The real SDK passes
  the previous `ScheduleDescription` into the updater, and idiomatic usage often spreads it
  (`{ ...previous, action, spec }`). Reconcile, however, is the sole source of truth for
  these `agent:<project>:<name>` schedules — it fully specifies `action`, `spec`, `memo`,
  and `searchAttributes` every cycle. I will keep the updater a pure rebuild (ignoring
  `previous`, as the current code already does) so the corrected `taskQueue` etc. are
  applied unconditionally. This is the least-surprising minimal change and matches the
  existing intent; adopting a merge would be a behavior change outside this fix's scope.
- **Omitting `policies`/`state` from the returned `ScheduleUpdateOptions` is acceptable.**
  The `create` path already omits them and lets the server apply defaults; the update path
  will stay symmetric. `ScheduleUpdateOpts` therefore stays `{ action, spec, memo?,
  searchAttributes? }` — it does not need to grow `policies`/`state` fields.
- **`ScheduleHandleLike.update`'s `previous` parameter stays `unknown`.** Since the updater
  ignores it, typing it precisely adds no safety. Leaving it `unknown` keeps the mock seam
  simple and avoids importing SDK description types. (The test mocks will pass a flat object
  as `previous` purely for realism.)
- **Scope includes the sibling `applyScheduleChanges` in `schedule-ops.ts` and its test.**
  The task names `create-activities.ts` and the `schedule-ops.ts` *types*, but the standalone
  exported `applyScheduleChanges` in `schedule-ops.ts` (used by `schedule-ops.test.ts`)
  returns the same nested shape and is typed against the same `ScheduleUpdateOpts`. Once the
  type goes flat, that function and its test must change too or the package won't typecheck.
  I treat this as part of the one coherent change.

## Design

**Behavioral change is confined to one seam:** the shape of the object the schedule-update
updater function returns. No control flow, reconcile-plan logic, or public activity signature
changes.

Files affected:

- `packages/activities/src/schedule-ops.ts`
  - `ScheduleUpdateOpts`: change from
    `{ schedule: { spec; action }; memo?; searchAttributes? }` to the flat
    `{ action: ScheduleStartWorkflowAction; spec: CronScheduleSpec; memo?; searchAttributes? }`.
    Keep field names aligned with the real SDK (`action`, `spec` top-level).
  - `ScheduleHandleLike.update`: signature stays
    `(updateFn: (previous: unknown) => ScheduleUpdateOpts) => Promise<void>`; only the return
    type of the inner updater changes via `ScheduleUpdateOpts`. Update the adjacent comment so
    it documents the flat contract (and that the nested shape was the silent-no-op bug).
  - Standalone `applyScheduleChanges` (the exported helper, ~line 151): change the updater's
    returned object from `{ schedule: { spec, action }, memo, searchAttributes }` to
    `{ action, spec, memo, searchAttributes }`.

- `packages/activities/src/create-activities.ts`
  - The activity `applyScheduleChanges` (~line 469): change the updater's returned object from
    `{ schedule: { spec, action }, memo, searchAttributes }` to `{ action, spec, memo,
    searchAttributes }`. Retain the `?.catch(() => {})` best-effort behavior and the
    explanatory comment (updated to reflect that the shape is now the real flat contract).

- `packages/activities/src/create-activities.test.ts`
  - The regression test "updates an existing schedule via an updater function…" (~line 840):
    the mock `updateFn({ ... })` currently passes a nested `previous`
    (`{ schedule: { action: { taskQueue: … } } }`) and asserts
    `update.lastResult.schedule.action.taskQueue`. Change the `previous` mock to the flat
    description shape (`{ action: { taskQueue: 'proj-Artem private agents' }, spec: … }`) and
    assert `update.lastResult.action.taskQueue === 'proj-artem-private-agents'`. Keep the
    `getHandle` id assertion and the "update called once with a function" assertions — those
    validate the correct half of the contract and must stay.

- `packages/activities/src/schedule-ops.test.ts`
  - The "updates via an updater function…" test (~line 51): change
    `expect(result.schedule.action.taskQueue).toBe('q')` to
    `expect(result.action.taskQueue).toBe('q')`.

Data flow (unchanged except shape): `config-sync` workflow → activity
`applyScheduleChanges(project, repo, plan)` → for each `toUpdate` entry, `getHandle(id)` then
`h.update(prev => flatSchedule)`; the flat `ScheduleUpdateOptions` is what the real client
serializes into an `UpdateSchedule` request, so the corrected `taskQueue`/`spec` now actually
reach the server.

Error handling: unchanged. The activity keeps its best-effort `.catch(() => {})` so a single
schedule's update failure doesn't abort the reconcile sweep. The difference is that a
well-formed update will now *succeed* instead of throwing "updateFn returned an invalid
shape"–class errors that the catch used to hide.

**Verification / definition of done.** `pnpm lint && pnpm typecheck && pnpm test` green
(the two corrected tests now assert the real contract; typecheck confirms no nested-shape
call site survives). Because this touches `activities`, `pnpm e2e` should pass as well. No new
contracts, prompts, or packages; no changes to `workflows`/`policies` (determinism/purity
rules untouched). Time-sensitive: this must land and a reconcile cycle must run before
2026-07-14T04:00:00Z so `gdebenz-watch` picks up the corrected queue on its next tick.

This is one coherent change: fixing a single mis-shaped SDK call and the shared type + tests
that encoded the mistake.

## Brainstorm Summary
**Approaches considered:** (1) patch only the runtime object in `create-activities.ts`; (2) make the schedule updater return the SDK's flat `ScheduleUpdateOptions` and enforce it via the shared `ScheduleUpdateOpts` type; (3) import `@temporalio/client`'s own update-options type.
**Chosen approach:** (2) — flat shape everywhere, enforced by the local type.
**Why (decisive reasons):** It fixes both the runtime no-op and the type that let the wrong nested shape compile, so the bug can't silently regress. (1) leaves the wrong type (and a sibling function) broken and wouldn't typecheck; (3) defeats the deliberate minimal test-seam interfaces and over-couples us to vendor internals.
**Key risks/assumptions:** The updater rebuilds the schedule rather than merging `previous` (reconcile is source of truth); `policies`/`state` stay omitted, symmetric with the create path; scope necessarily includes the sibling `applyScheduleChanges`/test in `schedule-ops.ts` because they share the type. Must land + reconcile before 2026-07-14T04:00:00Z for `gdebenz-watch`.
