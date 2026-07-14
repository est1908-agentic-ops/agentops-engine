# Plan — self-heal-2026-07-14t03-00-00z-platform-fix-1

## Summary

`ScheduleHandle.update(updateFn)` in the activities package returns a **nested**
`{ schedule: { spec, action }, memo, searchAttributes }` object from its updater. The real
`@temporalio/client` contract wants the updater to return a **flat** `ScheduleUpdateOptions`
(`{ action, spec, memo?, searchAttributes? }` — no `schedule` wrapper). Because
`deps.scheduleClient` is an untyped `as unknown as ScheduleClientLike` cast, the nested shape
type-checks against our local `ScheduleUpdateOpts` but is rejected/ignored at runtime and the
failure is swallowed by `.catch(() => {})`. Net effect: reconcile "succeeds" but existing
schedules (notably `agent:Artem private agents:gdebenz-watch`) never get their `taskQueue`
corrected.

Fix = flat shape everywhere, enforced by the shared type (design Approach 2). Four files change,
all bound by the same `ScheduleUpdateOpts` type, so a partial fix would fail `pnpm typecheck`.

## Files to change, in order

The type is the root cause that let the bug compile, so change it first — it makes the compiler
flag every remaining nested call site, turning the rest of the work into "make typecheck green."

### 1. `packages/activities/src/schedule-ops.ts` — the shared type (de-risks the rest)

- Redefine `ScheduleUpdateOpts` (currently lines 37–41) from
  `{ schedule: { spec: CronScheduleSpec; action: ScheduleStartWorkflowAction }; memo?; searchAttributes? }`
  to the flat
  `{ action: ScheduleStartWorkflowAction; spec: CronScheduleSpec; memo?: Record<string, unknown>; searchAttributes?: Record<string, unknown[]> }`.
- `ScheduleHandleLike.update` (line 51) keeps its signature
  `(updateFn: (previous: unknown) => ScheduleUpdateOpts) => Promise<void>` — only the inner
  return type changes via `ScheduleUpdateOpts`. Leave `previous` as `unknown` (the updater
  ignores it; see Assumptions).
- Update the adjacent comment block (lines 43–49) to document the **flat** contract and that the
  nested shape was the silent-no-op bug.
- Fix the standalone exported `applyScheduleChanges` updater (lines 151–165): return
  `{ action: { type: 'startWorkflow', workflowType: spec.workflow, args, taskQueue, memo, searchAttributes }, spec: cronScheduleSpec(spec.schedule, spec.timezone), memo, searchAttributes }`
  instead of the nested `{ schedule: { spec, action }, memo, searchAttributes }`.

**Verify:** `pnpm typecheck` (run after step 2 as well). At this point the compiler should flag
the still-nested call site in `create-activities.ts` (step 2) if it were left unchanged —
confirming the type now enforces the correct contract.

### 2. `packages/activities/src/create-activities.ts` — the activity call site

- In the activity `applyScheduleChanges` (updater at lines 469–473), change the returned object
  from `{ schedule: { spec, action }, memo, searchAttributes }` to the flat
  `{ action: { type: 'startWorkflow', workflowType: spec.workflow, args, taskQueue: actionQueue, memo, searchAttributes }, spec: cronScheduleSpec(spec.schedule, spec.timezone), memo, searchAttributes }`.
- Keep the trailing `?.catch(() => {})` best-effort behavior unchanged.
- Update the explanatory comment (lines 462–468) so it reflects that the shape is now the real
  flat `ScheduleUpdateOptions` contract (the runtime no-op is fixed), while still noting why the
  updater-function form matters.

**Verify:** `pnpm typecheck` green (no nested-shape call site survives).

### 3. `packages/activities/src/create-activities.test.ts` — regression test (~line 840)

- The mock `update` (line 848–849) passes a nested `previous`
  (`{ schedule: { action: { taskQueue: 'proj-Artem private agents' } } }`). Change it to a flat
  description shape, e.g. `{ action: { taskQueue: 'proj-Artem private agents' }, spec: { cronExpressions: ['0 */2 * * *'], timezone: 'UTC' } }` — realism only; the updater ignores it.
- Change the final assertion (line 867) from `update.lastResult.schedule.action.taskQueue` to
  `update.lastResult.action.taskQueue` (still expecting `'proj-artem-private-agents'`).
- Keep the `getHandle` id assertion (line 864), the `toHaveBeenCalledTimes(1)` assertion
  (line 865), and the `typeof update.mock.calls[0][0] === 'function'` assertion (line 866) —
  they validate the correct half of the contract.

**Verify:** `pnpm test` — this test passes and asserts the real flat contract.

### 4. `packages/activities/src/schedule-ops.test.ts` — sibling test (line 51)

- Change `expect(result.schedule.action.taskQueue).toBe('q')` to
  `expect(result.action.taskQueue).toBe('q')`. Keep the "update called with a function"
  assertion (line 49).

**Verify:** `pnpm test` — this test passes.

## Verification (definition of done)

Run from repo root, in order:

1. `pnpm lint` — clean.
2. `pnpm typecheck` — green; confirms no nested-shape call site survives the flat type.
3. `pnpm test` — green; the two corrected tests assert `result.action.taskQueue` (flat).
4. `pnpm e2e` — green (change touches the `activities` package, per AGENTS.md hard rule #6).

Time-sensitive follow-up (outside the code change, noted for the operator/reconcile loop): this
must land **and** a reconcile cycle must run before **2026-07-14T04:00:00Z** so `gdebenz-watch`
picks up the corrected `taskQueue` on its next tick.

## Sequencing rationale

- **Type first (step 1)** deliberately de-risks everything else: once `ScheduleUpdateOpts` is
  flat, `pnpm typecheck` mechanically points at any call site still returning the nested shape,
  so steps 2–4 become "satisfy the compiler + tests" rather than a hunt. Step 1 also fixes the
  sibling `schedule-ops.ts` updater in the same edit (same file), keeping the package
  compilable.
- Steps 2–4 are order-independent among themselves (they don't depend on each other's output),
  but tests (3, 4) are listed after the source change (2) so the test run in the Verify step
  reflects corrected production code, not a transient red.
- I could have edited `create-activities.ts` (step 2) before the type (step 1), but that would
  leave a window where the type still permits the nested shape — the opposite of de-risking.
  Keeping the type first is intentional.

## Assumptions (resolved without a human — unattended run)

- **Updater rebuilds rather than merges `previous`.** The current code ignores `previous` and
  fully specifies `action`/`spec`/`memo`/`searchAttributes` each cycle; reconcile is the sole
  source of truth for `agent:<project>:<name>` schedules. I keep it a pure rebuild so the
  corrected `taskQueue` is applied unconditionally. Adopting a merge would be an out-of-scope
  behavior change.
- **`previous` parameter stays typed `unknown`.** Since the updater ignores it, precise typing
  adds no safety and would force importing SDK description types, defeating the minimal mock
  seam. Test mocks pass a flat object as `previous` purely for realism.
- **`policies`/`state` stay omitted from the returned update options.** The create path already
  omits them and lets the server apply defaults; the update path stays symmetric.
  `ScheduleUpdateOpts` therefore remains `{ action, spec, memo?, searchAttributes? }` and does
  not grow `policies`/`state`.
- **Scope necessarily includes the sibling `applyScheduleChanges` in `schedule-ops.ts` and both
  tests.** They share the `ScheduleUpdateOpts` type; once it goes flat, they must change too or
  the package won't typecheck. This is one coherent change, not scope creep.
- **Do not switch to importing `@temporalio/client`'s own `ScheduleUpdateOptions` type**
  (design Approach 3, rejected): the local minimal `*Like` interfaces exist so tests can inject
  `vi.fn()` mocks without the full SDK surface; importing the vendor type over-constrains the
  mocks and couples the package to SDK internals for no behavioral gain.
