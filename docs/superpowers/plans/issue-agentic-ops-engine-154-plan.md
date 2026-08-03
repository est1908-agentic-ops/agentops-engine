# Plan — issue-agentic-ops-engine-154

**[bughunt] Unauthenticated routes can start autonomous agent workflows with attacker-controlled prompts**

Date: 2026-07-21

Implements Approach A of `docs/superpowers/specs/issue-agentic-ops-engine-154-design.md`: gate
`POST /api/platform/runs` and `POST /api/devcycle/runs` with the existing
`x-control-crud-token` / `CONTROL_CRUD_TOKEN` guard, fail-closed when the token is unset, and
make the UI attach the token.

## Steps

### Step 1 — Gate the two workflow-start routes in `dispatch()`

**File:** `packages/control/src/create-control-server.ts`

In `dispatch()`, add the same guard the chat/agent routes use to the two POST branches:

- `POST /api/platform/runs` (currently line 287–289): before `return handleStartRun(deps, req)`,
  insert
  ```ts
  if (!authorizeControlToken(deps, req)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }
  ```
- `POST /api/devcycle/runs` (currently line 297–299): same guard before
  `return handleStartDevCycleRun(deps, req)`.

Use `authorizeControlToken` (the chat-route guard) rather than `authorizeProjectCrud` — both are
byte-for-byte identical today; the choice is about intent (these are "control writes that start
work", like chats). The guard runs *before* body parsing, so an unauthorized caller never reaches
the `400`/`409`/`422` paths (avoids leaking validation detail to anonymous callers). `authorizeControlToken`
already fails closed: an unset `projectCrudAuthToken` makes every request `401`.

Leave the GET/list/detail branches (`GET /api/platform/runs`, `GET /api/devcycle/runs`, `:workflowId`
detail) untouched — they stay open by the server's existing design.

**Verify:** `pnpm --filter @agentops/control typecheck` passes; the guard is present. Behavior is
verified end-to-end by Step 3's tests. (This is the de-risking step — it closes the actual
vulnerability — so it goes first.)

### Step 2 — Document the new gated routes in the `ControlDeps` doc comment

**File:** `packages/control/src/create-control-server.ts`

Extend the comment block on `projectCrudAuthToken` (near lines 45–59) to note that the two
workflow-start routes (`POST /api/platform/runs`, `POST /api/devcycle/runs`) are now gated behind
this token alongside chats, agent-trigger, tiers PUT, self-heal PUT, and projects CRUD, and that
the routes fail closed (401) when the token is unset. Keep it to a couple of lines; the goal is
that the security posture stays documented in one place.

**Verify:** manual read of the diff — the comment lists the two routes; `pnpm --filter
@agentops/control typecheck` still passes (comment-only change).

### Step 3 — Update the control-server tests

**File:** `packages/control/src/create-control-server.test.ts`

The existing `POST /api/platform/runs` and `POST /api/devcycle/runs` cases use the default `deps`
(no `projectCrudAuthToken`) and `postJson` (no token header); after Step 1 they would all get
`401`. Fix and extend:

1. Add a `projectCrudAuthToken: CRUD_TOKEN` to the base `deps` built in the top-level `beforeEach`
   (line ~63–68), so the harness has a configured token like the CRUD-gated describe blocks do.
   (`CRUD_TOKEN` is defined lower in the file at line 582; hoist its declaration above the
   `describe` or introduce a local constant with the same value near the top so `beforeEach` can
   reference it. Prefer hoisting the existing `const CRUD_TOKEN` / `CRUD_HEADERS` to the top of the
   file so there is a single definition.)
2. Add a header-aware POST helper next to `postJson`:
   ```ts
   async function postJsonWithHeaders(port, path, payload, headers) { ... }
   ```
   returning `{ status, body }`, mirroring the existing `getJsonWithHeaders`.
3. Update every existing `postJson(port, '/api/platform/runs', ...)` and
   `postJson(port, '/api/devcycle/runs', ...)` call in the success/400/409/422 cases to send
   `CRUD_HEADERS` (via `postJsonWithHeaders`, or by changing `postJson` to accept optional headers).
   These already assert `202`/`400`/`409`/`422` and must keep doing so *with* the token.
4. Add new auth cases for **both** routes, mirroring the agent-route tests (lines ~921–948):
   - `401` with **no** token header.
   - `401` with a **wrong** token (`x-control-crud-token: 'wrong'`).
   - `202` (or the route's success status) with the **correct** token — already covered by the
     updated success cases, but add an explicit assertion that `start` is *not* called on the
     unauthorized paths (parity with `expect(start).not.toHaveBeenCalled()`).
   - Fail-closed regression: with `delete deps.projectCrudAuthToken`, a request **with**
     `CRUD_HEADERS` still returns `401` and does not call `start` — mirroring the existing agent
     "fail-closed when CRUD token is unconfigured" test at line ~935.

**Verify:** `pnpm --filter @agentops/control test` (vitest) — all existing and new cases green.

### Step 4 — Make the UI send the token on the two start calls

**File:** `packages/ui/src/api.ts`

- `startRun` (line 100–107): replace `headers: { 'content-type': 'application/json' }` with
  `headers: crudHeaders(true)`.
- `startDevCycleRun` (line 127–134): same replacement.

`crudHeaders(true)` already sets `content-type` and attaches `x-control-crud-token` from
localStorage when present (the same helper `startChat`/`createProject` use). No other UI change:
the token-entry UI, localStorage plumbing, and `parseJsonResponse` 401→thrown-Error surfacing all
already exist.

**Verify:** `pnpm --filter @agentops/ui typecheck` passes. No UI unit tests exist for `api.ts`
(confirmed: no `*.test.*` under `packages/ui`), so no UI test to update — verified by grep. Manual
check: diff shows both functions now call `crudHeaders(true)` and no longer hand-build headers.

### Step 5 — Full definition-of-done gate

**Files:** none (verification only)

Run the AGENTS.md DoD gate from the repo root:

```bash
pnpm lint && pnpm typecheck && pnpm test
```

`pnpm e2e` only if an e2e path starts platform/devCycle runs through the control API; if so, its
helpers must attach `x-control-crud-token` (grep the e2e suite for `/api/platform/runs` and
`/api/devcycle/runs` first — see Assumptions).

**Verify:** all three commands green; e2e green if applicable.

## Sequencing notes

- **Step 1 (the guard) goes first** because it is the actual fix — it closes the vulnerability the
  issue is about. Everything else (docs, tests, UI header) supports it.
- **Step 3 (tests) must come after Step 1**, not before: the existing POST tests only start passing
  again once the harness sends the token, and the new 401 assertions only pass once the guard
  exists. Writing them first would leave the suite red between steps. I could have written the new
  auth-failure tests first (TDD-style, red → green), but the existing-passing tests would break the
  moment Step 1 lands regardless, so I keep code + test in adjacent steps to keep the suite
  coherent per commit.
- **Step 4 (UI) is independent** of Steps 1–3 and could be done first; I put it after the
  server-side fix so the security-relevant change and its tests land together and the UI change
  reads as a follow-on. It carries no behavioral risk to the server.
- **Step 2 (doc comment)** could fold into Step 1; kept separate only so the functional change and
  the documentation change are individually reviewable in the diff.

## Assumptions

- **No UI unit tests to update.** The design says "update/extend the `startRun`/`startDevCycleRun`
  unit tests (if present)". Grep shows no `*.test.*` files under `packages/ui`. Assumption: there
  are none to update; Step 4 is verified by typecheck + diff inspection only.
- **Reuse `authorizeControlToken`, not `authorizeProjectCrud`.** Both helpers are identical today;
  the design calls for `authorizeControlToken` on intent grounds (these routes start work, like
  chats). Assumption: no consolidation of the two helpers is in scope.
- **Base test deps gain a token.** Rather than special-casing each POST test, I add
  `projectCrudAuthToken: CRUD_TOKEN` to the shared `beforeEach` deps so every existing route test
  runs against a token-configured server (matching a real deployment). Assumption: no existing GET
  test depends on the token being *absent* — the read routes are ungated, so a configured token
  does not change their behavior. (Will confirm the full suite stays green in Step 3/5.)
- **e2e scope.** Assumption: the e2e suite may drive runs through the control API. Step 5 greps the
  e2e suite for the two route paths; if found, its request helpers get `x-control-crud-token`. If
  the e2e suite does not touch these routes, `pnpm e2e` is not required by AGENTS.md for a
  control-only change, but it will be run anyway if the grep is inconclusive.
- **Fail-closed is intended.** Per the design, a deployment with no `CONTROL_CRUD_TOKEN` can no
  longer start runs via the control API (401) — matching chats/agents/projects today. This is a
  deliberate behavior change to be called out in the PR description, not a regression to guard
  against.
