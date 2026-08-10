# Design — Task issue-agentic-ops-engine-189

**[bughunt] Unauthenticated GET endpoints leak run prompts/history across all projects**

## Goal

The control server (`packages/control`, a raw `node:http` server) exposes read
endpoints — run lists/details, project metadata, targets, repos, budgets,
agents, tiers, self-heal settings — with **no authentication**. Any caller who
can reach the ingress gets:

- `GET /api/platform/runs` and `GET /api/devcycle/runs` — every run's status and
  a 120-char prompt snippet, pulled from Temporal filtered only by
  `WorkflowType` (`handler-util.ts` `listRunsByType`), i.e. spanning **all
  projects**.
- `GET /api/platform/runs/:workflowId` and `GET /api/devcycle/runs/:workflowId`
  — the **full** run prompt, a deep-link into the Temporal history UI, and (for
  devCycle) the full live workflow state, for any guessable/enumerable
  `workflowId` (devCycle IDs are the predictable `prompt-${project}-${taskId}`).
- `GET /api/projects`, `GET /api/projects/:repo`, `GET /api/devcycle/targets`,
  `GET /api/registry/repos` — project/repo metadata across all tenants.

The only auth mechanism in the codebase is a single global bearer token
(`X-Control-Crud-Token`, from `CONTROL_CRUD_TOKEN`), checked by
`authorizeControlToken`, and today it gates only the mutating routes (plus the
chat routes). The read surface is wide open. The code comments admit the
intended protection — Traefik basic-auth on the ingress (Issue #4) — "is still
required before the control ingress goes public" and was never landed.

The fix: make the control server **authenticate every data-bearing endpoint**,
fail-closed, so the read surface stops being unauthenticated.

## Approaches considered

### A. Centralized token gate on all `/api/*` requests (recommended)

Require the existing `X-Control-Crud-Token` for **any** request whose path
begins with `/api/`, checked once at the top of `dispatch` (before per-route
matching), fail-closed with 401. `/healthz` and static SPA asset serving stay
open so the browser console can load and prompt the operator for the token. The
now-redundant per-route token checks on mutating routes collapse into this
single gate. The UI's `api.ts` is updated to send the stored token header on all
its API GET fetches (it already stores and sends it for writes).

- **Trade-off:** Does not add per-project tenancy — an authenticated operator
  still sees all projects. That is correct for this system (see Assumptions):
  the token is a single global operator credential and the console is a
  single-operator viewer; there is no per-user/per-project identity to scope by.
- **Cost:** Small. One gate in `dispatch`, deletion of ~6 per-route checks, a
  doc-comment/log correction, a handful of UI fetch header additions, and test
  updates (existing GET tests must now send the token; add 401-without-token
  cases).
- **Benefit:** Secure-by-default for the whole class of bug — the leak happened
  because someone added GET routes and forgot to gate them. A path-prefix gate
  means every current and *future* `/api/*` route is authenticated unless
  someone deliberately carves out an exception.

### B. Per-route token check added to each read route

Add an `authorizeControlToken` guard to each leaking GET handler individually,
mirroring how the mutating routes do it today.

- **Trade-off:** Same auth outcome as A but leaves the "forgot to gate the new
  route" foot-gun fully in place — the next added GET is open again by default.
  More lines, more places to get wrong, and the router already demonstrated this
  failure mode.
- **Rejected:** strictly worse than A on safety and on diff size, for no
  compensating benefit.

### C. Introduce per-project authorization / multi-tenancy

Give each project (or caller) its own token/identity, thread a project scope
through the router, filter `listRunsByType`'s Temporal query by a project
predicate, and add project-ownership checks to the detail handlers.

- **Trade-off:** This is the only approach that would make cross-project
  visibility *impossible even for an authenticated caller* — but it requires an
  identity model that does not exist. There is no token→project mapping, no
  session, no per-user concept anywhere; managed-projects carry a `tokenSecret`
  *name* used by the engine to act on a repo, not to authenticate console
  readers. Building tenancy means new contracts, a credential-issuance story,
  and router/query rework across control and the UI.
- **Rejected:** disproportionate to the issue and to the deployment reality
  (one operator console). It would be a separate feature, not a bug fix, and
  bundling it here would violate the "one coherent change" rule. Recorded as
  follow-up under Assumptions.

## Chosen approach

**Approach A — a centralized fail-closed token gate on all `/api/*` requests,
with the UI sending the token on reads.**

It directly resolves the issue as filed: the endpoints stop being
unauthenticated. It closes the entire class of bug (open-by-default GET routes)
rather than the specific instances, so it is robust against the next route
someone adds. It reuses the existing, already-deployed token and header — no new
secret, no chart change, no deployment coordination — and it stays consistent
with the one authorization primitive the system has. B is rejected as a
strictly-worse version of the same fix; C is rejected as out-of-scope tenancy
work with no existing identity model to build on.

On the "across all projects" wording: once the endpoints require the operator
token, the remaining cross-project visibility is *authorized* visibility — the
single operator is meant to see every project's runs in the console. There is no
tenant boundary in this system for an authenticated caller to cross, so
authentication is the complete fix for the leak. (If per-tenant isolation is
later wanted, that is Approach C as a follow-up.)

## Assumptions

- **The control token is a single global operator credential, and the console is
  a single-operator viewer.** Confirmed by the code: one `CONTROL_CRUD_TOKEN`,
  no session/identity/per-project auth anywhere, and UI that stores one token in
  localStorage. → I treat authentication (not per-project authorization) as the
  correct and complete fix for this issue. Per-project tenancy (Approach C) is
  noted as a possible follow-up, not done here.
- **`/healthz` and static SPA assets must remain unauthenticated.** `/healthz` is
  a liveness probe; the SPA shell must load before the operator can enter the
  token. → The gate keys on `pathname.startsWith('/api/')` only; non-`/api` GETs
  (healthz, static files) are untouched.
- **Applying the gate to the currently-open read/GET routes that are *not*
  purely metadata (tiers GET, self-heal GET, budgets, agents list) is in scope
  and desirable.** They are all under `/api/` and expose operational data; a
  path-prefix gate covers them uniformly, and there is no reason a reader of
  those should be less authenticated than a reader of runs. → All `/api/*` GETs
  become authenticated; I will call this out in the PR description as an
  intended consequence.
- **Fail-closed when `CONTROL_CRUD_TOKEN` is unset applies to reads too.** This
  matches the existing mutating-route behavior (401 when the token is
  unconfigured). A control server with no token configured serves only
  `/healthz` and static assets. → Local dev must set `CONTROL_CRUD_TOKEN` to use
  the API; this is an accepted, documented behavior change (it is the secure
  default and mirrors what writes already do).
- **The gateway server is out of scope.** It handles only signature-verified
  inbound webhooks and does not expose the leaking surface.

## Design

Scoped to **one coherent change**: authenticate the control server's data
endpoints. Components affected:

### `packages/control/src/create-control-server.ts` (primary)

- Add a single authentication gate at the start of `dispatch` (or in
  `handleRequest` immediately before dispatch): if
  `pathname.startsWith('/api/')` and `authorizeControlToken(deps, req)` is
  false, return `{ status: 401, body: { error: 'unauthorized' } }`. This runs
  before any route matching, so every `/api/*` route — GET and mutating, present
  and future — is covered.
- Remove the now-redundant per-route `authorizeControlToken` checks (POST
  platform/devcycle runs, agent trigger, chats block, tiers PUT, self-heal PUT).
  The chats block's `startsWith('/api/platform/chats')` guard stays for routing
  but no longer needs its own auth check. Net behavior for writes is unchanged
  (still 401 without a valid token); the checks just move up to one place.
- Correct the misleading doc comments: the `ControlDeps.managedProjectStore` and
  `projectCrudAuthToken` comments and the `handleListProjects` /
  `handleGetProject` "Read-only — no auth token required" comments now describe
  the token as gating *all* `/api/*` traffic, reads included. Rename is not
  required; the token's role simply broadens from "mutation token" to "control
  API token". Keeping the env var / header name avoids a deployment change.
- Data flow is otherwise unchanged: authenticated requests reach the same
  handlers and Temporal/store calls as before.

### `packages/control/src/main.ts`

- Update the startup log lines that assert `/api/projects`,
  `/api/registry/repos`, and the read routes are open, and the
  "mutating routes are token-protected" message, to state that **all `/api`
  routes require `CONTROL_CRUD_TOKEN`** and fail-closed when it is unset. No
  logic change beyond messaging; the token is already read here.

### `packages/ui/src/api.ts`

- Send the stored token header (`crudHeaders(...)`) on the API GET fetches that
  currently send none: `getRuns`/`listRuns`, `getRun`, `listDevCycleRuns`,
  `getDevCycleRun`, `listTargets`, `listRepos`, `listAgents`, and the tiers /
  budgets / self-heal reads. The token store, header helper, and the token-entry
  UI (`ProjectsPage`) already exist — this only widens which calls attach the
  header. Handle 401 the same way existing gated calls do (surface an
  auth-required state rather than crashing).

### `packages/control/README.md`

- Update the endpoint/auth documentation to state that all `/api` routes require
  the control token.

### Error handling

- Unauthorized `/api/*` requests → `401 { error: 'unauthorized' }`, consistent
  with today's mutating-route response and the constant-time,
  fail-closed-when-unset semantics of `authorizeControlToken` /
  `constantTimeTokenEqual` (unchanged).
- `/healthz` and static asset serving are unaffected and continue to respond
  without a token.

### Tests (`packages/control/src/create-control-server.test.ts` and siblings)

- Existing GET tests (platform/devcycle run list & detail, targets, repos,
  projects, tiers GET, self-heal GET) must now send `CRUD_HEADERS`; update them.
- Add regression cases: each representative `/api/*` GET returns **401 without a
  token** and **401 with a wrong token**, and **401 when the token is
  unconfigured** (fail-closed), mirroring the existing write-route 401 tests.
- Add a case asserting `/healthz` and a static asset still succeed **without** a
  token (the carve-out is correct).
- Existing write-route 401 tests continue to pass unchanged (behavior
  preserved).

### Out of scope (explicitly)

- Per-project / multi-tenant authorization (Approach C).
- Any change to the gateway server, Temporal query shapes, or the
  managed-projects registry.
- Introducing a second token or a real identity/session system.

### Definition-of-done checks

`pnpm lint && pnpm typecheck && pnpm test` green; control tests updated as
above; README and startup logs updated (behavior/docs change); no new TODOs.
This does not touch `workflows`/`policies`/`activities`/`backends`, so the SLDS
lifecycle is unaffected and the e2e gate is not triggered by the change itself
(control-only), though running it remains harmless.

## Brainstorm Summary
**Approaches considered:** (A) one fail-closed token gate on every `/api/*`
request; (B) add the existing per-route token check to each open GET; (C) build
real per-project multi-tenancy (scoped tokens + project-filtered queries).
**Chosen approach:** A — a centralized gate at the top of `dispatch` reusing the
existing `X-Control-Crud-Token`, with the UI sending the token on reads.
**Why (decisive reasons):** It fixes the whole class of "open-by-default GET"
bugs (not just today's instances), reuses the already-deployed token/header (no
new secret, no chart/deploy change), and matches the system's single
authorization primitive. B leaves the foot-gun in place; C requires an identity
model that doesn't exist and would be a separate feature, out of scope.
**Key risks/assumptions:** The token is a single global operator credential and
the console is a single-operator viewer, so authentication (not per-project
scoping) is the complete fix — an authenticated operator seeing all projects is
authorized, not a leak. Fail-closed applies to reads too: unset token ⇒ only
`/healthz` + static assets served (a documented behavior change for local dev).
Per-tenant isolation is left as a possible follow-up.
