# Plan — Task issue-agentic-ops-engine-190

Goal: close the security bug where `POST /api/agents/:scheduleId/run` can fire
**any** Temporal schedule (including platform schedules `reconcile:all` and
`self-heal`), not just per-project `agent:` schedules. Chosen approach is
Design **Approach B**: reject non-`agent:` ids in `handleTriggerAgent`, using a
single authoritative predicate lifted into `packages/contracts`.

## Files that change, in order

### 1. `packages/contracts/src/control-agents-api.ts` — add the authoritative predicate (de-risks everything else)

Add, alongside the existing schemas:

- `export const AGENT_SCHEDULE_ID_PREFIX = 'agent:'` — the one authoritative
  literal.
- `export function isAgentScheduleId(id: string): boolean` returning
  `id.startsWith(AGENT_SCHEDULE_ID_PREFIX)`.

Rationale for going first: this export is the dependency the handler and both
test files consume. Landing it first means every later step compiles against a
real symbol rather than a placeholder. It has no runtime callers yet, so adding
it in isolation cannot break anything.

Do **not** touch the existing `AgentScheduleSummarySchema` /
`ListAgentSchedulesResponseSchema` / `TriggerAgentResponseSchema` — no data
shape changes. No re-export edit needed: `packages/contracts/src/index.ts:21`
already does `export * from './control-agents-api'`, so the new symbols surface
on `@agentops/contracts` automatically.

**Verify:** `pnpm --filter @agentops/contracts typecheck` (symbol exists,
compiles). Full assertion is covered by step 3's unit test.

### 2. `packages/control/src/agents-routes.ts` — add the guard

- Add `isAgentScheduleId` to the existing import from `@agentops/contracts`
  (line 1–5 block).
- In `handleTriggerAgent`, **before** `getHandle(scheduleId)`, insert:
  ```ts
  if (!isAgentScheduleId(scheduleId)) {
    return { status: 404, body: { error: `no schedule "${scheduleId}"` } };
  }
  ```
  This is the identical body/shape as the existing not-found `catch` branch
  (line 44), so non-agent ids are indistinguishable from genuinely-absent ones
  (no existence oracle), and `getHandle`/`trigger` are never reached for them.
- Optional convergence (low risk, keeps the design's "single definition" intent):
  replace the bare `id.startsWith('agent:')` at line 16 in `handleListAgents`
  with `!isAgentScheduleId(id)`. Keep this in the same commit only if it stays a
  pure literal-for-helper swap; the list test in step 4 already guards it.

**Verify:** `pnpm --filter @agentops/control typecheck` +
`pnpm --filter @agentops/control test` (existing agents tests still green,
plus new tests from step 4).

### 3. `packages/contracts/src/control-agents-api.test.ts` — unit-test the predicate

Add a `describe('isAgentScheduleId', ...)` block asserting:
- `isAgentScheduleId('agent:acme:nb')` → `true`
- `isAgentScheduleId('agent:')` → `true` (prefix semantics, matches the repo's
  existing invariant; intentional per design assumption)
- `isAgentScheduleId('reconcile:all')` → `false`
- `isAgentScheduleId('self-heal')` → `false`
- `isAgentScheduleId('')` → `false`
- `isAgentScheduleId('agent')` → `false` (no colon)
- `AGENT_SCHEDULE_ID_PREFIX === 'agent:'`

**Verify:** `pnpm --filter @agentops/contracts test`.

### 4. `packages/control/src/create-control-server.test.ts` — endpoint regression tests

In the existing `describe('createControlServer agents API', ...)` block
(starts line 650):

- **Change the harness spy** so we can assert `getHandle` is *not* invoked. The
  current `schedule: { list, getHandle: () => ({ trigger }) }` (line 670) uses a
  bare arrow. Replace with a `vi.fn()`:
  ```ts
  getHandle = vi.fn(() => ({ trigger }));
  // ...
  schedule: { list, getHandle },
  ```
  declared alongside `trigger` in the `beforeEach`. Re-verify the existing
  happy-path test (line 697) still passes — it asserts `trigger` was called,
  which is unaffected.
- **New test:** `POST /api/agents/reconcile:all/run` with `CRUD_HEADERS` returns
  `404`, and both `getHandle` and `trigger` were **not** called
  (`expect(getHandle).not.toHaveBeenCalled()`).
- **New test:** same for `self-heal` (URL-encode via `encodeURIComponent` to
  match how the existing tests build the path).
- **Reuse existing happy-path** (line 697) as the "valid `agent:` id still
  returns 202 and calls trigger" assertion; extend it (or add a sibling) to also
  assert `getHandle` *was* called for the agent id, confirming the guard lets
  real ids through.

**Verify:** `pnpm --filter @agentops/control test`.

### 5. Full gate

**Verify:** from repo root, `pnpm lint && pnpm typecheck && pnpm test`. e2e
(`pnpm e2e`) is **not** required: this change touches only `contracts` (a new
pure predicate + tests) and `control` (an HTTP handler guard) — none of
workflows / policies / activities / backends per AGENTS.md rule 6. Noted
explicitly so the skip is a decision, not an omission.

## Sequencing / ordering rationale

- Step 1 first because it is the shared dependency and is inert until consumed —
  it de-risks the compile of steps 2–4 and cannot itself break anything.
- Step 2 (the actual fix) before its tests (3, 4) is deliberate: the design's
  security goal is closed the moment the guard lands; steps 3–4 prove it and
  lock it against regression.
- Steps 3 and 4 are independent of each other and could be written in either
  order; kept contracts-before-control to mirror AGENTS rule 3 ("contracts
  first") and the step-1→2 dependency direction.
- The optional `handleListAgents` convergence (step 2) is sequenced last within
  its file so the security-critical guard is the primary, reviewable change and
  the cleanup is clearly separable — it can be dropped without affecting the fix
  if lint/typecheck ever objects.

## Assumptions

- **Prefix, not full-shape, matching.** Resolved in favour of
  `startsWith('agent:')` (not a `agent:<nonempty>:<nonempty>` regex). Every
  existing guard in the repo (`handleListAgents`, `orphanScheduleIds`) uses the
  bare prefix, and project/agent names may contain `:`/spaces, so a
  colon-splitting regex risks false negatives. Consistency wins; recorded in the
  design.
- **404, not 403/400, for rejected ids.** Resolved to `404` with the identical
  body as the existing not-found branch, to avoid an existence oracle and keep
  the endpoint's externally-observable shape unchanged for real clients.
- **Ownership check is out of scope.** Blocking triggering of orphaned `agent:`
  schedules for unmanaged projects (design Approach C) is deferred — not a
  privilege escalation and already handled by reconciliation.
- **No new typed schedule port.** The existing `client.schedule as any` access
  in the handler stays; introducing a typed trigger port is a separate refactor,
  not needed to close this hole.
- **`isAgentScheduleId('agent:')` returns true.** A bare-prefix id with no
  project/name is treated as an agent id (prefix semantics). This is not a
  reachable privilege escalation (it is not `reconcile:all`/`self-heal`) and
  matches the established invariant, so it is accepted rather than special-cased.
- **Optional `handleListAgents` convergence is included** in the same commit as
  a pure literal→helper swap, since the design explicitly calls for a single
  authoritative definition and the existing list test guards it. If it were to
  introduce any behavior delta it would be dropped; none is expected.
