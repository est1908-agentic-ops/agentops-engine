# Design — issue-agentic-ops-engine-154

**[bughunt] Unauthenticated routes can start autonomous agent workflows with attacker-controlled prompts**

Date: 2026-07-21

## Goal

The control server (`packages/control`) exposes an HTTP API. Two of its routes start
autonomous agent workflows from a request-body prompt with **no authentication**:

- `POST /api/platform/runs` → `handleStartRun` starts the `platform` workflow with the
  caller's `prompt` (and `hintRepos`). The platform agent can read cluster state and
  **initiate development work**.
- `POST /api/devcycle/runs` → `handleStartDevCycleRun` starts a `devCycle` for a registered
  repo with the caller's `prompt` as the issue `goal`, driving the full
  Design→Plan→Implement→Review→babysit pipeline against real project credentials.

Every *other* mutating/triggering route on the same server is already gated behind a
constant-time bearer-token check (`x-control-crud-token` compared to `CONTROL_CRUD_TOKEN` /
`deps.projectCrudAuthToken`): `POST /api/agents/:id/run`, all `/api/platform/chats*`,
`PUT /api/tiers`, `PUT /api/settings/self-heal`, and all `/api/projects*`. The two
workflow-start routes are the gap: anyone who can reach the control port can spin up
arbitrary, budget-consuming, credential-wielding agent runs with attacker-chosen prompts.

The fix: gate the two workflow-start routes with the same token mechanism the rest of the
write surface already uses, and fail closed when the token is unset.

## Alignment with the SLDS

This is a security hardening of an existing entry point into the development cycle
(`devCycle`) and platform assistance (`platform`), not a change to the lifecycle itself. It
preserves "Humans set intent and authority" — starting autonomous work now requires the
operator secret, matching how chats and agent triggers already work. No SLDS change needed.

## Approaches considered

### A. Gate the two workflow-start POST routes with the existing control token (recommended)

Add the same `authorize…(deps, req)` guard used by the chat routes to `POST
/api/platform/runs` and `POST /api/devcycle/runs` in `dispatch()`; return `401` when the
token is missing or wrong. Update the UI's `startRun` / `startDevCycleRun` fetch calls to
send `x-control-crud-token` (they currently send only `content-type`). The CLI already
attaches the token to every control request, and has no command that hits these two routes,
so it needs no change.

- **Trade-off:** GET/read routes (`GET /api/platform/runs`, `GET /api/devcycle/runs`,
  detail views) stay ungated, so run listings/prompts remain readable without a token.
  That is consistent with the server's existing deliberate posture (several GETs are
  documented as "safe to serve ungated") and is out of scope for *this* issue, which is
  specifically about **starting** workflows. Read hardening can be a separate change.
- **Cost:** Low. ~2 guard clauses, small UI header change, test updates.

### B. Blanket auth middleware over the whole `/api` surface

A single gate at the top of `dispatch()` requiring the token for every `/api/*` route
except `/healthz` (and static UI GETs).

- **Trade-off:** Strongest posture and also closes the read-leak — but it **breaks** the
  many GETs the UI and dashboards currently make without a token (`listRuns`, `getRun`,
  `listRepos`, `getBudgets`, `listTiers`, `listDevCycleTargets`, `listAgents`, self-heal
  GET), forcing a token onto read-only observability. It directly contradicts several
  in-code decisions that specific GETs are intentionally open. Larger blast radius, more
  test churn, and over-scoped relative to the issue.
- **Rejected:** bundles unrelated read-path policy changes into a targeted write-path fix.

### C. Introduce a dedicated "run token" separate from `CONTROL_CRUD_TOKEN`

A second env secret that specifically authorizes starting workflows, distinct from the
credential-CRUD token.

- **Trade-off:** Finer-grained separation of "may start work" vs "may edit credentials",
  but adds a second secret to provision/rotate and a second config-enable branch. The repo
  has a stated convention (see the `/api/tiers` comment) that **one operator secret governs
  all fleet-mutating writes**; chats — which also start workflows — already reuse this one
  token.
- **Rejected:** adds config surface and contradicts the established one-token design for no
  benefit this issue requires.

## Chosen approach

**Approach A.** It closes the exact vulnerability (unauthenticated workflow starts) with the
smallest, lowest-risk change, reuses the existing constant-time token comparison and
fail-closed convention, and stays aligned with the repo's "one operator secret for all
fleet-mutating writes" decision. B over-reaches into read-path policy that the codebase has
deliberately kept open; C invents a second secret the repo's convention argues against.

## Design

### What changes

1. **`packages/control/src/create-control-server.ts` — `dispatch()`**
   Add a token guard to the two workflow-start branches, mirroring the chat/agent routes:
   - `POST /api/platform/runs`: if not authorized → `{ status: 401, body: { error:
     'unauthorized' } }`; otherwise call `handleStartRun`.
   - `POST /api/devcycle/runs`: same guard before `handleStartDevCycleRun`.

   Use the existing `authorizeControlToken(deps, req)` helper (the chat routes' guard),
   which delegates to `constantTimeTokenEqual(deps.projectCrudAuthToken,
   req.headers['x-control-crud-token'])`. That helper already **fails closed**: an unset
   `projectCrudAuthToken` makes every request unauthorized (`401`). No new dependency,
   config field, or env var is introduced. The read routes (`GET .../runs`, detail) are
   left unchanged (see scope note).

   Because `authorizeControlToken` and `authorizeProjectCrud` are byte-for-byte identical
   today, this reuse is purely about intent/readability; the two workflow-start routes are
   "control writes that start work," the same category as chats, so `authorizeControlToken`
   is the natural name to reuse. (No consolidation of the two helpers is in scope.)

2. **`packages/ui/src/api.ts` — `startRun` and `startDevCycleRun`**
   Replace the hand-built `headers: { 'content-type': 'application/json' }` with
   `crudHeaders(true)` (the same helper `startChat`/`createProject` already use), so the
   browser attaches the operator's `x-control-crud-token` from localStorage. No other UI
   change: the token-entry UI and localStorage plumbing already exist for the CRUD/chat
   routes, and error surfacing already turns a `401` body into a thrown `Error`.

3. **`packages/control/src/create-control-server.ts` — `ControlDeps` doc comment**
   Extend the existing comment block that enumerates the token-gated routes to include the
   two workflow-start routes, so the security posture stays documented in one place.

### What deliberately does NOT change

- **Read/list/detail routes** (`GET /api/platform/runs[/:id]`, `GET /api/devcycle/runs[/:id]`,
  targets, repos, budgets, tiers GET, agents list, self-heal GET) — unchanged; they remain
  open by the server's existing design. This issue is scoped to *starting* workflows.
- **The gateway** (`packages/gateway`) — its webhook routes are already authenticated by
  GitHub/Linear HMAC signature verification and the ArgoCD bearer token; not in scope.
- **`CONTROL_CRUD_TOKEN` provisioning / `main.ts` wiring** — the token is already read and
  passed as `projectCrudAuthToken`; no config change.

### Data flow (after)

`UI/CLI/operator → POST /api/platform/runs (+ x-control-crud-token) → dispatch guard →
constantTimeTokenEqual → handleStartRun → client.workflow.start(platform)`. Missing/wrong
token short-circuits at the guard with `401` before any Temporal call. Same shape for
`/api/devcycle/runs`.

### Error handling / behavior notes

- **Fail-closed is a deliberate behavior change:** a deployment with no `CONTROL_CRUD_TOKEN`
  set can no longer start platform/devCycle runs via the control API (it gets `401`) — this
  already matches how chats and agent triggers behave, and is the correct posture for a
  route that launches autonomous, credential-bearing work. Operators enable it by setting
  `CONTROL_CRUD_TOKEN` (the same secret that already unlocks projects/tiers/chats). This
  will be called out in the PR description.
- **401 body** matches the existing routes: `{ error: 'unauthorized' }`.
- Existing `400` (bad JSON / schema), `409` (already-started), and `422` (unknown repo)
  responses are unaffected — the guard runs first, so an unauthorized caller never reaches
  body parsing (avoids leaking validation detail to anonymous callers).

### Tests

- **`packages/control/src/create-control-server.test.ts`**: the harness that builds
  `ControlDeps` with a token must now send `x-control-crud-token` on the existing
  `POST /api/platform/runs` and `POST /api/devcycle/runs` cases (via the `postJson` helper /
  a small header-aware variant). Add cases asserting **`401` with no token and with a wrong
  token**, and **`202` with the correct token**, for both routes — mirroring the chat/agent
  route tests already in the suite.
- **`packages/ui`**: update/extend the `startRun` / `startDevCycleRun` unit tests (if
  present) to assert the `x-control-crud-token` header is sent, consistent with the existing
  `startChat` test.
- Full gate per AGENTS.md DoD: `pnpm lint && pnpm typecheck && pnpm test`; `pnpm e2e` if any
  e2e path starts runs through the control API (those helpers must attach the token).

## Assumptions

- **Scope is the write path only.** The issue title is about *starting* workflows, so I gate
  the two POST routes and intentionally leave the read/list GETs open, matching the server's
  documented existing posture. Assumption: closing read-side info exposure is a separate
  hardening task, not this bug.
- **Reuse `CONTROL_CRUD_TOKEN` rather than a new secret.** The repo states one operator
  secret governs all fleet-mutating writes, and chats (which also start workflows) already
  reuse it. Assumption: operators expect the same token to authorize starting runs.
- **Fail-closed when the token is unset** (401), rather than "open until configured."
  Assumption: for a route that launches autonomous credential-bearing agents, defaulting to
  closed is correct even though it is a behavior change for token-less deployments; this
  mirrors the chat/agent/projects routes.
- **Use `authorizeControlToken` (the chat guard) for these routes.** It is currently
  identical to `authorizeProjectCrud`; the choice is about intent. Assumption: no helper
  consolidation is desired as part of this fix.
- **Traefik basic-auth (issue #4) remains the ingress-level control** and this app-level
  token is defense-in-depth, not a replacement — consistent with every existing in-code
  comment.

## Self-review

- No placeholders or TBDs.
- No contradictions: the "gate writes, leave reads open" decision is stated consistently in
  Goal, Chosen approach, Design, and Assumptions.
- Single coherent change: authenticate the two unauthenticated workflow-start routes and
  make the UI send the token; no unrelated work bundled in.

## Brainstorm Summary
**Approaches considered:** (A) gate the two unauthenticated workflow-start POST routes with the existing control bearer token; (B) a blanket auth middleware over the whole `/api` surface; (C) introduce a separate dedicated "run" token.
**Chosen approach:** A — reuse the existing `x-control-crud-token` / `CONTROL_CRUD_TOKEN` guard (as chats/agents/projects/tiers already do) on `POST /api/platform/runs` and `POST /api/devcycle/runs`, and make the UI send the token.
**Why (decisive reasons):** Smallest, lowest-risk fix that matches the repo's "one operator secret for all fleet-mutating writes" convention. B breaks intentionally-open observability GETs and over-reaches; C adds a second secret the convention argues against.
**Key risks/assumptions:** Fail-closed is a deliberate behavior change — deployments with no `CONTROL_CRUD_TOKEN` can no longer start runs via the API (matches chats/agents today). Read/list GETs stay open by design; closing them is a separate task.
