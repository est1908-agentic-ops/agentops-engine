# Plan — Task issue-agentic-ops-engine-131

Goal: make `reconcileAgents`'s task-queue mismatch detection fire in production by
feeding it the real current task queue of each existing schedule. Implements
**Approach A** from `docs/superpowers/specs/issue-agentic-ops-engine-131-design.md`:
populate `ExistingSchedule.taskQueue` from `handle.describe()` in both
`listAgentSchedules` implementations. Policy logic in `reconcile-agents.ts` is
already correct and stays unchanged.

## Context (verified against the tree)

- `packages/policies/src/reconcile-agents.ts:112` — the mismatch clause
  `(cur.taskQueue !== undefined && cur.taskQueue !== desiredQueue)`. Correct, but
  `cur.taskQueue` is always `undefined` in production. **Do not change.**
- `packages/activities/src/schedule-ops.ts:97-122` — reference `listAgentSchedules`
  reads `taskQueue`/`workflow` off the `list()` summary (`s.action.taskQueue`,
  `s.action.type`). The summary carries neither the queue nor the correct workflow
  type. `ScheduleHandleLike` (lines 55-60) has no `describe`.
- `packages/activities/src/create-activities.ts:442-484` — wired `listAgentSchedules`
  (the one `config-sync` calls). Same defect: `rec.action.taskQueue` off the summary
  is always undefined. Wrapped in an outer try/catch (best-effort list).
- `deps.scheduleClient` is `tc.schedule as unknown as ScheduleClientLike`
  (`packages/worker/src/main.ts:453`), i.e. the real `@temporalio/client`
  `ScheduleClient`, whose `getHandle(id).describe()` exists at runtime. Adding
  `describe` to `ScheduleHandleLike` type-checks against the real client.
- Existing tests: `reconcile-agents.test.ts:86` (legacy-queue re-point) hand-builds
  `taskQueue` and stays green. `schedule-ops.test.ts` currently tests only
  `applyScheduleChanges` (no `listAgentSchedules` coverage). `create-activities.test.ts`
  has schedule tests but none exercising `listAgentSchedules`.

## Steps (ordered)

### Step 1 — Extend `ScheduleHandleLike` with optional `describe`
**File:** `packages/activities/src/schedule-ops.ts` (interface at lines 55-60).
Add `describe?: () => Promise<unknown>;` to `ScheduleHandleLike`. This is the minimal
client-surface change that lets both list functions fetch a full schedule
description. `getHandle` on `ScheduleClientLike` already returns `ScheduleHandleLike`,
so no change to `ScheduleClientLike` is needed.
**Verify:** `pnpm --filter @agentops/activities typecheck` (or repo `pnpm typecheck`)
stays green — purely additive optional field.

### Step 2 — Populate `taskQueue` from `describe()` in the wired `listAgentSchedules`
**File:** `packages/activities/src/create-activities.ts:442-484` (the load-bearing change).
Inside the `for await` loop, after the prefix filter (`sid.startsWith(...)` continue),
call the full description for the matched id:
- `let taskQueue: string | undefined;` and a `workflow` derived as today from the
  summary as fallback.
- In an inner `try { const desc = await client.getHandle!(sid).describe?.(); ... }
  catch { /* leave taskQueue undefined */ }`, read
  `(desc as any)?.action?.taskQueue` into `taskQueue` and, if present,
  `(desc as any)?.action?.workflowType` into `workflow` (the description carries the
  real values the summary omits). Guard `describe` being absent (optional) so mocks/
  older clients that don't provide it degrade to `undefined` (today's behaviour).
- Keep `getHandle` usage null-safe: `client.getHandle` is required on
  `ScheduleClientLike`, but guard the `describe?.()` optional call.
- Remove the now-misleading `const taskQueue = (rec.action as any)?.taskQueue`
  summary read (it was always undefined); the value now comes from `describe()`.
The existing outer try/catch (best-effort whole-list) is preserved; the new inner
try/catch degrades a single bad `describe()` to `taskQueue: undefined` without
aborting the list.
**Verify:** unit test added in Step 4 (`create-activities.test.ts`) proving a mocked
`describe()` surfaces the real queue and that a `describe()` throw yields
`taskQueue: undefined`; plus `pnpm typecheck`.

### Step 3 — Same treatment in the reference `listAgentSchedules`
**File:** `packages/activities/src/schedule-ops.ts:97-122`.
Mirror Step 2 for parity:
- For each matched id, `try { const desc = await client.getHandle(id).describe?.(); }
  catch {}` and read `action.taskQueue` (and `action.workflowType` for `workflow`)
  from the description.
- This copy currently reads `workflow` from `s.action.type` (which is
  `'startWorkflow'`, a distinct latent bug). Per the design's scope note, do **not**
  chase that bug independently, but since `describe()` makes the correct field
  trivially available, source `workflow` from `desc.action.workflowType` when the
  description is present, falling back to the existing summary-derived value on
  error/absence. No behavioural expansion beyond what falls out of `describe()`.
- Fall back to `undefined` queue and existing summary `workflow`/`scheduleSpec` on
  any `describe()` failure.
**Verify:** unit test added in Step 4 (`schedule-ops.test.ts`); `pnpm typecheck`.

### Step 4 — Activity-level tests for both implementations
**Files:** `packages/activities/src/create-activities.test.ts` and
`packages/activities/src/schedule-ops.test.ts`.
Extend the mock `ScheduleClientLike` so `getHandle(id)` returns a handle exposing
`describe: vi.fn()`. Add tests covering, for each of the two `listAgentSchedules`:
1. **Happy path** — `list()` yields a matching `agent:<project>:` summary; the
   handle's `describe()` returns `{ action: { taskQueue: LEGACY_ENGINE_QUEUE,
   workflowType: 'whiteboxBugHunt' } }`; assert the returned `ExistingSchedule` has
   `taskQueue === LEGACY_ENGINE_QUEUE` (and correct `workflow`).
2. **End-to-end mismatch** — feed that `ExistingSchedule` (legacy queue) plus a
   matching declared agent into `reconcileAgents`; assert the schedule lands in
   `plan.toUpdate`. (This is the assertion that would have caught the dead code.)
3. **`describe()` throws** — `describe` rejects; assert `taskQueue === undefined` and
   the schedule is still returned (no thrown reconcile, no spurious update when run
   through `reconcileAgents`).
4. **Non-matching id** — a summary whose id doesn't match the prefix is skipped and
   `describe()` is not called (guards the per-matched-schedule RPC bound).
**Verify:** `pnpm --filter @agentops/activities test` green; new tests fail if
reverted to the summary-only read.

### Step 5 — Optional one-line comment refresh in policy
**File:** `packages/policies/src/reconcile-agents.ts` (comment above the mismatch
clause, ~lines 54-59). Note that `taskQueue` is now sourced from the schedule
description via `listAgentSchedules`. No code change.
**Verify:** `pnpm lint` (comment-only) + existing policy tests stay green.

### Step 6 — Full gate
Run the repo definition-of-done gate.
**Verify:** `pnpm lint && pnpm typecheck && pnpm test`. e2e (`pnpm e2e`) applies
because activities are touched — run it and confirm green; if the sandbox can't run
e2e (needs Temporal), record that and rely on the targeted activity + policy unit
tests plus typecheck as the substitute, noting it in the PR description.

## Sequencing notes

- **Step 1 first** because both list functions depend on `describe` existing on the
  handle type; without it Steps 2-3 don't type-check. It de-risks the rest.
- **Step 2 before Step 3** because the wired copy (`create-activities.ts`) is the
  behaviourally load-bearing change (`config-sync` calls it); the reference copy is
  parity only. Ordering the load-bearing change first means the production fix is in
  place even if the parity copy needs iteration.
- **Tests (Step 4) after both implementations** rather than TDD-first only because
  both functions need the shared mock-handle `describe` shape; writing the mock once
  after the interface change avoids reworking it. Could be reordered to test-first
  per function; not done, to keep the mock definition single-sourced.
- **Step 5 (comment) and Step 6 (gate) last** — cosmetic then verification.

## Assumptions

- **Both `listAgentSchedules` copies are fixed** (design assumption). The wired one is
  load-bearing; the `schedule-ops.ts` copy is fixed for parity so it can't re-seed the
  dead-code confusion.
- **Always read the queue from `describe()`** for matched schedules rather than trusting
  the summary with `describe()` as fallback — single source of truth for the queue; the
  extra RPC per *matched* (prefix-filtered, per-project) schedule is bounded and
  acceptable.
- **`describe()` failure ⇒ `taskQueue: undefined` (don't re-point), never a thrown
  reconcile.** Reproduces today's behaviour and lets the next cycle retry, consistent
  with the best-effort stance already in `pruneOrphanAgentSchedules`.
- **`describe` is optional on `ScheduleHandleLike`.** The real client provides it at
  runtime; mocks/older clients without it degrade to `undefined` — the same safe path
  as a `describe()` error.
- **The `action.type`-vs-`workflowType` bug in `schedule-ops.ts` is out of scope as an
  independent fix.** I only use `workflowType` there because sourcing from `describe()`
  makes the correct field trivially available; I do not expand the change further.
- **e2e may be unrunnable in this sandbox** (needs a Temporal test env). If so, the
  targeted activity/policy unit tests + typecheck stand in, recorded in the PR body.
