# Design — Task issue-agentic-ops-engine-131

## Goal

`reconcileAgents` (packages/policies/src/reconcile-agents.ts) is meant to detect
when an existing agent Schedule points at the wrong Temporal task queue and add it
to `plan.toUpdate` so `applyScheduleChanges` re-points it. This is the mechanism
the SP-b queue cutover relies on: any schedule still on `LEGACY_ENGINE_QUEUE`
(`agentops-devcycle`) or, for a project workflow, on the wrong `proj-<slug>` queue
should be corrected on the next reconcile.

Today that detection is **dead code**. The mismatch clause

```ts
(cur.taskQueue !== undefined && cur.taskQueue !== desiredQueue)
```

can never be true in production because `cur.taskQueue` is *always* `undefined`.
Both `listAgentSchedules` implementations read `taskQueue` off the object yielded by
Temporal's `ScheduleClient.list()` — but `list()` yields **schedule summaries**, and a
summary's `action` carries only the workflow *type*, never the task queue. The queue
lives on the full schedule description (`handle.describe()`), which the code never
calls. So `cur.taskQueue !== undefined` short-circuits to `false` on every real
schedule; the branch is exercised only by unit tests that hand-build `ExistingSchedule`
objects with `taskQueue` populated. The result: a schedule that has drifted onto the
legacy/wrong queue is never re-pointed, defeating the cutover it was written to serve.

The goal is to make the queue-mismatch detection actually fire in production — i.e. feed
`reconcileAgents` the real current task queue of each existing schedule — while keeping
the (already-correct, already-tested) policy logic unchanged.

## Approaches considered

### A. Populate `taskQueue` by calling `handle.describe()` per matched schedule (recommended)

`listAgentSchedules` already iterates `client.list()` and filters to
`agent:<project>:` ids. For each id that matches, additionally call
`client.getHandle(id).describe()` and read `action.taskQueue` from the full
description. This is the field the list summary omits.

- **Trade-off / cost:** one extra Temporal RPC per *matched* schedule. Bounded and
  small — `config-sync` runs per project, and only that project's agent schedules
  match the prefix (typically a handful). `describe` is wrapped in try/catch so a
  transient failure degrades to `taskQueue: undefined` (current behaviour, i.e. "don't
  re-point"), never a thrown reconcile.
- **Complexity:** low. The policy layer and `applyScheduleChanges` are untouched; the
  change is confined to the two `listAgentSchedules` functions and the
  `ScheduleHandleLike` interface (add optional `describe`).

### B. Remove the dead code

Delete the `taskQueue` field from `ExistingSchedule`, drop the third clause of the
`toUpdate` condition, and delete the now-orphaned "re-points legacy queue" test.

- **Trade-off:** smallest diff and removes a lying test, but it *abandons a real
  feature*. The `LEGACY_ENGINE_QUEUE` comment in packages/contracts/src/engine-queue.ts
  explicitly states the cutover depends on "the reconciler re-points it (see
  reconcile-agents ExistingSchedule.taskQueue)". Removing detection leaves legacy-queue
  schedules stranded forever and blocks removing `LEGACY_ENGINE_QUEUE`.
- **Rejected:** the bug is "the feature doesn't work," and the intended feature is still
  wanted. Deleting it trades a dormant bug for a permanent capability gap.

### C. Re-point unconditionally (normalise every existing schedule each reconcile)

Skip detection entirely: always push every existing scheduled agent into `toUpdate`,
letting `applyScheduleChanges` overwrite the queue (and everything else) to the desired
values every run.

- **Trade-off:** guarantees convergence with no `describe()` calls, but floods `toUpdate`
  on every reconcile (~15 min cadence) with no-op updates, generating constant Temporal
  writes, noisy audit history, and a misleading `ReconcilePlan` where `toUpdate` no longer
  means "something changed." It also discards the diffing that already works for
  `scheduleSpec`/`workflow`.
- **Rejected:** wrong cost/benefit — it papers over the missing input rather than
  supplying it, and degrades the plan's semantics for every consumer.

## Chosen approach

**Approach A.** It is the only option that makes the existing, well-tested detection
logic *true* in production without changing the policy contract or the meaning of the
plan. B throws away a feature the cutover documentation still depends on; C converges but
turns `toUpdate` into a per-cycle write storm and loses meaningful diffing. A's only cost
— an extra `describe()` RPC per matched schedule — is bounded (per-project, prefix-filtered
count) and fails safe.

## Assumptions

- **Both `listAgentSchedules` implementations get fixed.** There are two: the wired one
  inside `createActivities` (packages/activities/src/create-activities.ts) that
  `config-sync` actually calls, and a parallel reference/test-only copy in
  packages/activities/src/schedule-ops.ts. They share the `ExistingSchedule` contract and
  the same defect. *Assumption:* I fix both so they stay consistent and neither re-seeds the
  dead-code confusion. The wired one is the behaviourally load-bearing change; the
  schedule-ops copy is fixed for parity.
- **The list summary genuinely lacks `taskQueue`.** Rather than trust the summary and only
  `describe()` as a fallback, I always read the queue from `describe()` for matched
  schedules. *Assumption:* the extra RPC per matched schedule is acceptable; the simplicity
  of a single source of truth for the queue outweighs a conditional fast-path that would
  rarely hit.
- **`describe()` failure means "don't re-point," not "fail reconcile."** *Assumption:*
  leaving `taskQueue` undefined on a `describe()` error is the correct degrade — it
  reproduces today's behaviour (no spurious update) and lets the next reconcile retry,
  consistent with the "never delete/act on a partial list" stance already in
  `pruneOrphanAgentSchedules`.
- **Scope excludes the separate `workflow`-field bug in schedule-ops.ts.** That copy reads
  `action.type` (`'startWorkflow'`) instead of `action.workflowType`. *Assumption:* out of
  scope for this task (it's a distinct defect in the unwired copy); I will not silently
  "fix" it here beyond what naturally falls out of sourcing fields from `describe()`. If
  reading from `describe()` makes the correct field trivially available I will use
  `workflowType` there for correctness, but I will not expand the change to chase unrelated
  issues.

## Design

**Scope:** one coherent change — supply the real current task queue to `reconcileAgents`.

Files affected:

- **packages/activities/src/schedule-ops.ts**
  - Extend `ScheduleHandleLike` with an optional `describe?: () => Promise<unknown>` so the
    minimal client surface can fetch a full schedule description (the real
    `@temporalio/client` `ScheduleHandle` has it; the cast in worker/src/main.ts already
    passes the real client through).
  - In the reference `listAgentSchedules`: for each id matching `agent:<project>:`, call
    `client.getHandle(id).describe()` inside try/catch and read the current task queue and
    workflow type from the description's `action`. Fall back to `undefined`/existing summary
    values on error.
- **packages/activities/src/create-activities.ts**
  - Same treatment in the wired `listAgentSchedules` (the one `config-sync` calls): after
    the prefix filter, `describe()` the handle to obtain `action.taskQueue` (and workflow
    type), guarded by try/catch, degrading to `undefined` on failure. This is the change
    that makes the mismatch detection live in production.
- **packages/policies/src/reconcile-agents.ts** — *unchanged.* The mismatch clause is
  already correct; it was starved of input. (Optionally a one-line comment update to note
  the queue now comes from `describe()`.)

Data flow after the change:

```
config-sync workflow
  → acts.listAgentSchedules(project)                 [create-activities.ts]
        client.list()            → ids + spec/workflow (summary)
        client.getHandle(id).describe() → action.taskQueue   ← NEW real input
        ⇒ ExistingSchedule { …, taskQueue: <real queue | undefined on error> }
  → reconcileAgents(declared, existing, project)     [policies, unchanged]
        cur.taskQueue !== undefined && cur.taskQueue !== desiredQueue   ← now can be TRUE
        ⇒ drifted schedule lands in plan.toUpdate
  → applyScheduleChanges(project, repo, plan)        [re-points via handle.update]
```

Error handling:

- `describe()` wrapped in try/catch per schedule; on failure `taskQueue` stays `undefined`,
  which the policy treats as "queue unknown → do not re-point." No reconcile is failed by a
  single bad describe.
- The overall list is still best-effort (existing outer try/catch in create-activities
  preserved); a full-list failure returns what was gathered, unchanged from today.

Testing:

- The existing policy test `'re-points a schedule still on the legacy queue'`
  (packages/policies/src/reconcile-agents.test.ts) already covers the logic and stays green.
- Add/extend activity-level tests (create-activities.test.ts and schedule-ops.test.ts) so the
  mock `ScheduleClientLike` exposes `getHandle(id).describe()` returning an `action.taskQueue`,
  asserting that `listAgentSchedules` now surfaces the real queue and that a legacy-queue
  schedule produces a `toUpdate` entry end-to-end. Also cover the `describe()`-throws path →
  `taskQueue` undefined → no spurious update. These are the tests that would have caught the
  dead code.

## Brainstorm Summary

```markdown
## Brainstorm Summary
**Approaches considered:** (A) fetch each schedule's real task queue via `handle.describe()` so the existing mismatch check has real input; (B) delete the dead detection outright; (C) unconditionally re-point every schedule each reconcile.
**Chosen approach:** (A) — populate `ExistingSchedule.taskQueue` from `describe()` in both `listAgentSchedules` implementations; policy logic stays untouched.
**Why (decisive reasons):** The detection code is already correct but starved of input — `ScheduleClient.list()` summaries omit the task queue, so `cur.taskQueue` is always `undefined`. B abandons a feature the `LEGACY_ENGINE_QUEUE` cutover explicitly depends on; C converges but floods `toUpdate` with no-op writes and destroys the plan's diff semantics. A's only cost is one bounded, fail-safe RPC per matched schedule.
**Key risks/assumptions:** Extra `describe()` RPC per matched schedule (bounded, per-project); `describe()` failure degrades to `taskQueue: undefined` (no spurious update, retried next cycle). Both the wired (`create-activities.ts`) and reference (`schedule-ops.ts`) copies are fixed for parity; the separate `action.type` vs `workflowType` bug in the reference copy is out of scope.
```
