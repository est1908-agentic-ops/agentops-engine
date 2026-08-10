# Plan — Task issue-agentic-ops-engine-189

**[bughunt] Unauthenticated GET endpoints leak run prompts/history across all projects**

Design: `docs/superpowers/specs/issue-agentic-ops-engine-189-design.md` — Approach A
(centralized fail-closed token gate on every `/api/*` request, reusing the
existing `X-Control-Crud-Token` / `CONTROL_CRUD_TOKEN`; UI sends the token on
reads). No new secret, no chart/deploy change, no tenancy work.

## Summary of the change

Move authentication from ~6 per-route checks in `dispatch` to a **single gate at
the top of `dispatch`**: any request whose `pathname.startsWith('/api/')` must
present a valid control token or get `401 { error: 'unauthorized' }`, evaluated
*before* route matching. `/healthz` and static SPA assets stay open. This makes
every current and future `/api/*` route authenticated by default. Then update the
UI to attach the stored token on its API GETs, and update logs/docs/tests.

## Files changed, in order

### 1. `packages/control/src/create-control-server.ts` (core fix — de-risks everything else)

This is first because it *is* the security fix; every other step (tests, UI,
docs, logs) exists to support or describe it. Done here:

- **Add the gate** at the top of `dispatch`, immediately after `const { pathname } = url;`
  and after the `/healthz` short-circuit (order vs. healthz is irrelevant since
  `/healthz` is not under `/api/`, but keep healthz first so the liveness probe is
  never gated):
  ```ts
  if (pathname.startsWith('/api/') && !authorizeControlToken(deps, req)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }
  ```
- **Remove the now-redundant per-route `authorizeControlToken` checks** (they're all
  strictly weaker than the gate and now dead):
  - `POST /api/platform/runs` (lines ~218-220)
  - `POST /api/devcycle/runs` (lines ~231-233)
  - `POST /api/agents/:scheduleId/run` (lines ~257-259)
  - the chats block guard (lines ~263-265) — **keep** the
    `pathname === '/api/platform/chats' || startsWith('/api/platform/chats/')`
    branch itself (it's routing), just drop its inner auth check.
  - `PUT /api/settings/self-heal` (lines ~294-296)
- **Preserve the tierStore guard.** Line ~310 is
  `if (!deps.tierStore || !authorizeControlToken(deps, req)) return 401`. The auth
  half is now covered by the gate, but the `!deps.tierStore → 401` half is *feature
  gating*, not auth, and must stay: reduce it to
  `if (!deps.tierStore) { return { status: 401, body: { error: 'unauthorized' } }; }`.
- **Fix the misleading doc comments** so they no longer claim reads are open:
  - `ControlDeps.managedProjectStore` comment (lines ~44-54): drop the "unlike the
    routes below this needs no auth token" clause; the store is still read-only, but
    the routes reading it are now gated like everything under `/api/`.
  - `projectCrudAuthToken` comment (lines ~61-73): broaden its stated role from
    "gate every mutating route" to "gate every `/api/*` route (reads included),
    fail-closed (401) when unset". Keep the env var / header name unchanged.
  - `handleListProjects` "Read-only -- no auth token required" comment (line ~194):
    rewrite to note the request already passed the `/api/*` gate.
  - the "Read-only (see ControlDeps.managedProjectStore) -- no auth, no 503 gating"
    comment above the `/api/projects` GET routes (line ~316): correct it.

**Verify:** `pnpm --filter @agentops/control typecheck`; then run the control
test file (step 2 updates it) — `pnpm --filter @agentops/control test`.

### 2. `packages/control/src/create-control-server.test.ts` (update + regression coverage)

The gate flips several existing tests that deliberately send **no token** and
expect 200/404 — they must now send the token to reach the handler. Concretely:

- **Add the token header to existing GET calls** that expect success. The
  `getJson(port, path)` helper currently sends no headers. Simplest: extend
  `getJson` to accept optional headers, and pass `CRUD_HEADERS` at the call sites
  that need auth (all `/api/*` GETs). Affected:
  - `GET /api/platform/runs`, `GET /api/platform/runs/:workflowId` (all cases)
  - `GET /api/devcycle/runs`, `GET /api/devcycle/runs/:workflowId`, `GET /api/devcycle/targets`
  - `GET /api/registry/repos` (both cases)
- **Managed-project read suite (lines ~551-648).** Its `deps` sets *no*
  `projectCrudAuthToken` with a comment "these routes must not require one" — that
  premise is now false. Set `projectCrudAuthToken: CRUD_TOKEN` in that `beforeEach`
  and send `CRUD_HEADERS` on:
  - `GET /api/projects` (list, empty-store, no-store cases)
  - `GET /api/projects/:repo` (found/404, linear-shape cases)
  - the **"no write path -- POST/PUT/DELETE all 404"** test: these currently send
    no token and expect 404 (route-not-matched). With the gate, an *unauthenticated*
    POST/PUT/DELETE returns **401 before routing**, not 404. Add `CRUD_HEADERS` to
    each so they still reach the intended 404 (route-genuinely-absent) behavior.
- **Agents suite (lines ~650-729).** `GET /api/agents` "(ungated)" now requires the
  token — add `CRUD_HEADERS` and drop "ungated" from the name. The POST cases
  already send tokens / assert 401; they pass unchanged.
- **Self-heal suite (lines ~731-804).** `GET /api/settings/self-heal` "(ungated)"
  now requires the token — add `CRUD_HEADERS`, drop "ungated" from the name. The PUT
  cases already assert 401-without-token and 200-with-token; unchanged.
- **Add regression cases** (mirroring the existing write-route 401 tests) — for at
  least one representative leaking GET, ideally a run-detail GET (`GET
  /api/platform/runs/:workflowId`) plus `GET /api/projects`:
  - 401 with **no token**
  - 401 with a **wrong token**
  - 401 when the token is **unconfigured** (`delete deps.projectCrudAuthToken`,
    fail-closed) even if a header is sent
  - assert Temporal/store was **not** consulted (e.g. `getHandle`/`list` not called)
    where practical, proving the gate short-circuits before any data access.
- **Add carve-out assertions** proving the gate is scoped correctly:
  - `GET /healthz` still 200 **without** a token (an explicit case already exists at
    line ~115 — keep it; it doubles as the carve-out proof).
  - the static-file fallback test (lines ~526-546) serves `/` **without** a token —
    it already does; add an explicit assertion/comment that a non-`/api` GET is not
    gated so the intent is captured.
- Existing write-route 401 tests (platform, devcycle, agents, self-heal) keep
  passing unchanged — behavior for writes is identical.

`chat-routes.test.ts` and `tiers-routes.test.ts` call handlers **directly** (not
through the server), so the gate does not touch them — no changes needed. Note
this in the PR description.

**Verify:** `pnpm --filter @agentops/control test` green.

### 3. `packages/control/src/main.ts` (startup log messaging)

- Replace the "mutating routes ... are token-protected (CONTROL_CRUD_TOKEN set)"
  log (lines ~112-114) and the "CONTROL_CRUD_TOKEN is not set -- all mutating routes
  ... fail-closed with 401" warning (lines ~116-118) with messages stating that
  **all `/api/*` routes** require `CONTROL_CRUD_TOKEN` and fail-closed with 401 when
  unset (only `/healthz` + static assets served).
- Update the "`/api/projects (read-only)` serving from ..." log (line ~109) to drop
  the implication that it's unauthenticated (it still reads the ConfigMap dir; it's
  just gated now). No logic change — the token is already read here.

**Verify:** `pnpm --filter @agentops/control typecheck`; manual read of the log
strings. (Optional sanity: `MANAGED_PROJECTS_DIR=/tmp TEMPORAL_UI_BASE_URL=x
node -e` boot is not run since it needs Temporal; log text is a static-string
review.)

### 4. `packages/control/README.md` (auth documentation)

- Rewrite the `CONTROL_CRUD_TOKEN` bullet (line ~25) so it says the token gates
  **every `/api/*` route (reads and writes)**, fail-closed (401) when unset, with
  only `/healthz` and static SPA assets served without it. Remove the
  "read-only GETs (including `/api/projects`) are never gated" clause.
- Update the `MANAGED_PROJECTS_DIR` bullet (line ~24) wording that calls
  `/api/projects` etc. "read-only" routes — they remain read-only but are no longer
  unauthenticated.

**Verify:** manual read; `pnpm lint` (prettier/markdown if configured).

### 5. `packages/ui/src/api.ts` (send the token on API GETs)

Attach `crudHeaders(false)` to the fetches that currently send no headers, so an
authenticated operator's reads keep working after the gate:

- `listRuns` (line ~110), `getRun` (line ~115)
- `listRepos` (line ~120)
- `listDevCycleRuns` (line ~137), `getDevCycleRun` (line ~142), `listDevCycleTargets` (line ~147)
- `listAgents` (line ~184)
- `listTiers` (line ~249)
- `getSelfHealSettings` (line ~267)
- `getBudgets` (line ~285)

`startRun`, `startDevCycleRun`, chat calls, `listProjects`, `getProject`,
`runAgent`, `replaceTiers`, `updateSelfHealSettings` already send `crudHeaders`.
The token store (`getCrudToken`/`setCrudToken`), the `crudHeaders` helper, and the
token-entry UI already exist — this only widens which calls attach the header.
`parseJsonResponse` already surfaces a non-`ok` body's `error` as a thrown
`Error`, so a 401 already propagates as an auth-required error to the caller (same
path the already-gated calls use) — no new error-handling code needed. Update the
top-of-file comment block (lines ~37-41) that says "The managed-project CRUD
routes are bearer-token-gated" to note the token is now sent on reads too.

**Verify:** `pnpm --filter @agentops/ui typecheck` and `pnpm --filter @agentops/ui
build`. There are no UI unit tests; correctness of header attachment is confirmed
by typecheck + a read of the diff (each GET fetch now passes `headers:
crudHeaders(false)`).

## Full-suite verification (definition of done)

Run from repo root, in order:

1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test`

All green. `pnpm e2e` is not required: the change touches only
`control`/`ui`/docs, not `workflows`/`policies`/`activities`/`backends`, so the
SLDS lifecycle is unaffected (running e2e remains harmless but is not gating).

## Sequencing rationale

- **Step 1 (the gate) first** because it is the actual fix and de-risks the rest:
  once it exists, the tests can be written against real behavior rather than a
  hypothesis, and every later step (UI, logs, docs) is describing/supporting a
  change that already compiles.
- **Step 2 (tests) immediately after** so the source change is proven and the
  now-401 test breakages are fixed in the same logical unit — the repo stays green
  after each pair of steps rather than carrying known-red tests.
- **Steps 3–4 (logs, README)** are pure messaging/doc updates with no logic; they
  could be reordered freely among themselves. Kept after code so their wording
  matches the final behavior exactly.
- **Step 5 (UI) last** among code changes. It could safely be done *before* the
  server gate (sending a header the server ignores is harmless), but doing it after
  keeps the risky server change isolated and verified first; the UI change cannot be
  verified end-to-end without the server change anyway. It must land in the **same
  PR** as step 1 — if the gate ships without it, the console's reads would break.

## Assumptions (resolved here; no human to consult)

- **Single global operator token; no per-project tenancy.** Confirmed by the code
  (one `CONTROL_CRUD_TOKEN`, no session/identity anywhere). Authentication — not
  per-project authorization — is the complete fix. Approach C (multi-tenancy) is an
  explicit out-of-scope follow-up, not done here.
- **`/healthz` and static SPA assets stay open.** The gate keys only on
  `pathname.startsWith('/api/')`; the liveness probe and the shell that prompts for
  the token must load unauthenticated.
- **Fail-closed applies to reads too.** With `CONTROL_CRUD_TOKEN` unset, all
  `/api/*` (reads included) return 401 — matching today's write behavior. Local dev
  must set the token to use the API. Accepted, documented behavior change.
- **All `/api/*` GETs become gated, including non-run metadata** (projects, repos,
  targets, tiers GET, self-heal GET, budgets, agents list). Uniform path-prefix
  gating is the point of Approach A; there's no reason a reader of these should be
  less authenticated than a reader of runs. Called out as an intended consequence in
  the PR description.
- **`devcycle-routes.ts`'s "safe to serve ungated" comment** (targets handler)
  refers to *data sensitivity*, not the transport-level gate; the route is still
  reached only after passing the gate. I leave that comment as-is (it's about what
  the payload contains) but will not rely on it — the gate covers the route.
- **Gateway server is out of scope** — it handles only signature-verified webhooks
  and does not expose this read surface.
- **`chat-routes.test.ts` / `tiers-routes.test.ts` need no changes** — they invoke
  handlers directly, bypassing `dispatch` and therefore the gate.
