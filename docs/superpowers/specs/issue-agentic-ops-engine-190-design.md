# Design — Task issue-agentic-ops-engine-190

## Goal

Fix a security bug in the control server: `POST /api/agents/:scheduleId/run`
takes the schedule id straight from the URL path and calls
`client.schedule.getHandle(scheduleId).trigger()` with no validation. Any caller
holding the shared `X-Control-Crud-Token` can therefore fire **any** Temporal
schedule in the namespace — including the platform schedules `reconcile:all`
(worker/src/ensure-reconcile-schedule.ts:16) and `self-heal`
(activities/src/ensure-self-heal-schedule.ts) — not just the per-project agent
schedules the endpoint is meant to expose. The fix must constrain the endpoint
to only ever trigger per-project agent schedules.

## Context / current behaviour

- Route: `packages/control/src/create-control-server.ts:255-261` — matches
  `/api/agents/:scheduleId/run`, checks the operator bearer token, then calls
  `handleTriggerAgent(deps, agentRun.params.scheduleId)`.
- Handler: `packages/control/src/agents-routes.ts:39-47` — `getHandle(scheduleId)`
  then `handle.trigger()`, with **zero** id validation. A `catch` maps any
  Temporal error to `404 no schedule "<id>"`.
- Per-project agent schedules are keyed `agent:<project>:<name>`
  (`packages/policies/src/reconcile-agents.ts:20-22`, `scheduleId(project, name)`).
- The codebase already models "is this an agent schedule" as an `agent:` prefix
  test in two places: the list handler (`agents-routes.ts:16`,
  `id.startsWith('agent:')`) and orphan detection
  (`reconcile-agents.ts:34-39`, whose comment explicitly notes platform
  schedules `reconcile:all` / `self-heal` must never match). The trigger handler
  is the one place that omits this guard.
- The path matcher decodes URL-encoded segments (`route.ts`), so a caller can
  send `reconcile:all`, `self-heal`, or `agent%3A...` freely.
- Framework: raw `node:http` with a hand-rolled `dispatch()`; no per-schedule
  authorization layer exists.

## Approaches considered

### A. Prefix guard in the handler (mirrors existing invariants)
Reject any `scheduleId` that does not `startsWith('agent:')` in
`handleTriggerAgent`, before `getHandle`, returning `404` with the same generic
"no schedule" body. This is the exact invariant already used by
`handleListAgents` and `orphanScheduleIds`.
- **Trade-off:** Guards against the actual reported exposure (platform/system
  schedules) with a one-line, allocation-free, race-free check and no new I/O.
  It does not verify the `agent:`-prefixed id belongs to a *currently managed*
  project — but an orphaned `agent:<deadproject>:<name>` schedule is already
  swept by reconciliation and firing it is not a privilege escalation (it runs
  the same per-project agent it was created for), so this is acceptable.
- **Cost:** trivial.

### B. Prefix guard + shared contract-level validator (recommended)
Approach A, but the prefix invariant is expressed once as a small exported
predicate/constant in `packages/contracts` (e.g. `AGENT_SCHEDULE_ID_PREFIX`
plus an `isAgentScheduleId(id)` helper, optionally a
`z.string().startsWith('agent:')` refinement), consumed by the trigger handler
(and available to the list handler / policies to converge on one definition).
- **Trade-off:** Satisfies AGENTS rule 3 ("contracts first") by giving the
  cross-cutting "what is an agent schedule id" rule a single authoritative,
  unit-tested home instead of a third ad-hoc `startsWith('agent:')` literal.
  Marginally more surface than A (one new export + test).
- **Cost:** small.

### C. Full ownership check via managed-project set
Before triggering, confirm the id is `agent:<liveProject>:` for a project that
is currently in `deps.managedProjectStore` (or read the schedule's `describe()`
memo `project`/`agentName` and validate it).
- **Trade-off:** Strongest — also blocks triggering orphaned agent schedules.
  But it adds I/O (a store read or a `describe()` call) and racy state to every
  trigger, threads `managedProjectStore` into a path that does not use it today,
  and defends against a non-privilege-escalating case. Disproportionate to the
  reported bug.
- **Cost:** medium.

## Chosen approach

**Approach B.** It fully closes the reported vulnerability — after the guard the
endpoint can only ever reach `agent:`-prefixed schedules, so `reconcile:all`,
`self-heal`, and any other non-agent schedule become untriggerable (returning a
generic `404` that neither confirms nor denies the schedule's existence). It
does so with the same invariant the rest of the codebase already trusts, and by
lifting that invariant into `contracts` it removes the "the list path guards but
the trigger path doesn't" inconsistency that caused the bug in the first place.

Approach A is rejected only because it would plant a *third* copy of the bare
`startsWith('agent:')` literal — the same divergence that let list and trigger
drift apart; B fixes the root cause (one shared definition) at negligible extra
cost. Approach C is rejected as disproportionate: it guards a case (orphaned
agent schedules) that is not a privilege escalation and is already handled by
reconciliation, while adding I/O, statefulness, and a race to a hot path.

## What will change

- **`packages/contracts/src/control-agents-api.ts`** — add the authoritative
  agent-schedule-id definition: an `AGENT_SCHEDULE_ID_PREFIX = 'agent:'` constant
  and an `isAgentScheduleId(id: string): boolean` predicate (`id.startsWith(...)`).
  Optionally export a refined `AgentScheduleIdSchema` for callers that want zod
  parsing. No change to existing exported schemas.
- **`packages/control/src/agents-routes.ts`** — in `handleTriggerAgent`, before
  `getHandle`, reject ids for which `isAgentScheduleId(scheduleId)` is false with
  `{ status: 404, body: { error: 'no schedule "<id>"' } }` (same shape as the
  existing not-found branch, so non-agent ids are indistinguishable from
  genuinely-absent ones — no existence oracle). Optionally reuse the shared
  predicate in `handleListAgents` to converge the two guards.
- **Tests:**
  - `packages/contracts/src/control-agents-api.test.ts` — unit-test
    `isAgentScheduleId` for `agent:p:n` (true), `reconcile:all` / `self-heal` /
    `''` / `agent` (false).
  - `packages/control/src/create-control-server.test.ts` (or an
    `agents-routes` test) — assert `POST /api/agents/reconcile:all/run` and
    `.../self-heal/run` return `404` **without** `getHandle`/`trigger` being
    invoked (the existing test harness already spies on `getHandle`), and that a
    valid `agent:<project>:<name>` id still triggers and returns `202`.

Data flow after the change: request → token check (unchanged) →
`isAgentScheduleId` guard (new) → `getHandle().trigger()` (only reachable for
agent ids) → `202` / `404`. No contract data shapes are broken; the UI client
(`packages/ui/src/api.ts:188` `runAgent`) is unaffected because it only ever
sends real `agent:` ids.

## Error handling

Non-agent ids return `404` (not `403`/`400`) with the identical body the
existing not-found path emits, so the endpoint reveals nothing about which
schedule ids exist. Genuinely-missing agent ids keep their current `404`
behaviour via the unchanged `try/catch` around `trigger()`.

## Assumptions

- **Prefix vs. full-shape validation.** I assume the `agent:` prefix (not a
  stricter `agent:<nonempty>:<nonempty>` regex) is the correct invariant, because
  every other guard in the repo (`handleListAgents`, `orphanScheduleIds`,
  `create-activities`) uses exactly `startsWith('agent:')`, and project/agent
  names may contain `:` or spaces (see the `reconcile-agents.ts` comment), so a
  colon-splitting regex would risk false negatives. Consistency with the
  established invariant wins.
- **Response code for rejected ids.** I assume `404` (matching the existing
  not-found branch) is preferable to `403`, to avoid an existence oracle and to
  keep the handler's externally-observable shape unchanged for real clients.
- **Ownership is out of scope.** I assume blocking triggering of orphaned
  `agent:` schedules for unmanaged projects is not required by this bug, since
  it is not a privilege escalation and reconciliation already removes such
  schedules. Recorded as Approach C, deferred.
- **No new port needed.** I assume keeping the existing `client.schedule as any`
  access in the handler is acceptable for this scoped fix; introducing a typed
  `trigger` schedule port is a separate refactor and not required to close the
  hole.

## Self-review

- No placeholders or TBDs.
- No contradictions: the `404` choice, the `agent:` prefix invariant, and the
  "ownership deferred" scope are stated consistently across Approaches,
  Chosen approach, Error handling, and Assumptions.
- Scoped to one coherent change: a single authorization guard on one endpoint,
  plus the shared predicate it depends on and its tests. No unrelated work
  bundled.

## Brainstorm Summary
**Approaches considered:** (A) a `startsWith('agent:')` guard inline in the trigger handler; (B) the same guard but with the "is this an agent schedule id" invariant lifted into a shared, tested `contracts` predicate; (C) a full ownership check against the managed-project set via store/`describe()` I/O.
**Chosen approach:** (B) — reject any non-`agent:`-prefixed schedule id in `handleTriggerAgent`, using one authoritative helper in `packages/contracts`.
**Why (decisive reasons):** It fully blocks triggering platform/system schedules (`reconcile:all`, `self-heal`) using the exact invariant the list and reconcile paths already trust, and fixes the root cause — list guards, trigger didn't — by giving that invariant a single home instead of a third copy. C adds I/O and a race to guard a non-escalating case already handled by reconciliation.
**Key risks/assumptions:** Prefix (not full-shape) matching is intentional (names may contain `:`/spaces); rejected ids return `404` (no existence oracle); orphaned-agent-schedule ownership is deliberately out of scope.
