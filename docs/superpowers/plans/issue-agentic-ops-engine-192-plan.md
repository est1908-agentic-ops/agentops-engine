# Plan — Task issue-agentic-ops-engine-192

**[bughunt] Unbounded request-body buffering before auth/signature verification**

Design: `docs/superpowers/specs/issue-agentic-ops-engine-192-design.md` (Approach A — hand-rolled
byte cap inside the existing raw-`node:http` body readers; reject oversized requests with `413`
before signature verification and `JSON.parse`, aborting the stream mid-upload).

## Summary of the change

Put a finite, env-configurable cap on how many bytes each raw-`node:http` server buffers:

- **Gateway (the real pre-auth hole):** `readRawBody` gains a `maxBytes` limit; the two webhook
  handlers map an over-limit body to `413` **before** signature verification and `JSON.parse`.
  Default 25 MiB (GitHub's own documented webhook cap, so no legitimate delivery is rejected).
- **Control (defense-in-depth, identical reader — reads after the token gate):** `readJsonBody`
  gains the same cap; every body-reading route maps the over-limit case to `413`. Default 1 MiB.

No new dependencies. The signature verifiers (`verify-signature.ts`, `verify-linear-signature.ts`)
are unchanged.

## Files changed, in order

The gateway is the reported vulnerability and also the place where the tricky stream-abort logic
lives, so it goes first and is fully tested before touching control. Control reuses the exact same
pattern; getting it right once in the gateway de-risks the rest.

### Step 1 — `packages/gateway/src/create-gateway-server.ts` (primary fix)

- Add a module constant `DEFAULT_MAX_WEBHOOK_BODY_BYTES = 25 * 1024 * 1024` (`26_214_400`).
- Add a typed error `class PayloadTooLargeError extends Error` (exported so tests/other code can
  detect it; a `name === 'PayloadTooLargeError'` check is the fallback).
- Change `readRawBody(req, maxBytes)`:
  - Parse the `content-length` header; if present, numeric, and `> maxBytes`, reject immediately
    with `PayloadTooLargeError` **without reading any body**.
  - On each `data` chunk, add `chunk.length` to a running total; when the total exceeds `maxBytes`,
    remove the listeners / stop pushing chunks, `reject(new PayloadTooLargeError())`, and
    `req.destroy()` to release the socket. Guard with a `settled` boolean so `end`/`error` after the
    abort can't double-resolve/reject the promise.
  - Otherwise behave as today: `Buffer.concat(chunks)` on `end`; reject on `error`.
- Add `maxWebhookBodyBytes?: number` to `GatewayDeps` (defaults to the constant when unset).
- In `handleGithubWebhook` and `handleLinearWebhook`, wrap
  `const rawBody = await readRawBody(req, deps.maxWebhookBodyBytes ?? DEFAULT_MAX_WEBHOOK_BODY_BYTES)`
  in a `try/catch`; on `PayloadTooLargeError` do `res.writeHead(413).end('payload too large'); return;`
  — this runs **before** `verify*Signature` and `JSON.parse`. Re-throw anything else so the outer
  `createGatewayServer` backstop still handles it as a `500`.

**Verify:** `pnpm --filter @agentops/gateway typecheck` compiles; covered by Step 2's tests.

### Step 2 — `packages/gateway/src/create-gateway-server.test.ts`

Add cases (reusing the existing `post`/`fetch` harness and `createGatewayServer` deps builder;
inject a tiny `maxWebhookBodyBytes`, e.g. `16`):

- Oversized GitHub webhook body → `413` (streamed body larger than the limit).
- Oversized body with a large **`Content-Length`** header → `413` (early-reject path).
- The signature verifier / workflow client is never reached for an oversized body — assert via a
  spy on `deps.client.workflow.start` (or the `buildScm`/managed-project deps) that it is not
  called, i.e. the `413` short-circuits before signature/parse/dispatch.
- Oversized Linear webhook body → `413` (same path on `/webhooks/linear`).
- A normal-sized, correctly-signed body still succeeds (existing tests must stay green; add one
  assertion that a body under the injected limit is processed as before).

**Verify:** `pnpm --filter @agentops/gateway test`.

### Step 3 — `packages/gateway/src/main.ts`

- Read `GATEWAY_MAX_WEBHOOK_BODY_BYTES`, parse to a **positive integer** (`Number.parseInt`, base
  10); fall back to `DEFAULT_MAX_WEBHOOK_BODY_BYTES` when unset, non-numeric, or `<= 0`.
- Pass it as `maxWebhookBodyBytes` in the `createGatewayServer({...})` deps.

**Verify:** `pnpm --filter @agentops/gateway typecheck`; manual read-through (main.ts has no unit
test — it is thin wiring exercised by `pnpm e2e`).

### Step 4 — `packages/control/src/handler-util.ts` (defense-in-depth)

- Add `class PayloadTooLargeError extends Error` and an `isPayloadTooLarge(err): boolean` helper,
  both exported.
- Add a module constant `DEFAULT_MAX_BODY_BYTES = 1024 * 1024` (`1_048_576`).
- Change `readJsonBody(req, maxBytes = DEFAULT_MAX_BODY_BYTES)`:
  - Same `content-length` early-reject and cumulative-length abort + `req.destroy()` as the gateway
    reader (`settled` guard).
  - Preserve existing semantics: empty body → `resolve({})`; non-empty invalid JSON →
    `reject(SyntaxError)` (callers still map that to `400`).

**Verify:** `pnpm --filter @agentops/control typecheck`; covered by Step 6's tests.

### Step 5 — `packages/control/src/create-control-server.ts` + route modules

- Add `maxBodyBytes?: number` to `ControlDeps` (default `DEFAULT_MAX_BODY_BYTES` when unset).
- Thread the limit into every `readJsonBody(req, deps.maxBodyBytes)` call and update each caller's
  existing `catch` to distinguish oversize from bad JSON:
  ```ts
  } catch (err) {
    if (isPayloadTooLarge(err)) return { status: 413, body: { error: 'payload too large' } };
    return { status: 400, body: { error: 'invalid JSON body' } };
  }
  ```
  Call sites to update (from `grep readJsonBody`):
  - `create-control-server.ts` — `handleStartRun` (line ~79)
  - `devcycle-routes.ts` — `handleStartDevCycleRun` (line ~33)
  - `chat-routes.ts` — `handleStartChat` (~20), `handleSendTurn` (~78), `handleDecision` (~94)
  - `settings-routes.ts` — `handleUpdateSelfHealSettings` (~63)
  - `tiers-routes.ts` — `handleReplaceTiers` (~81)
- Each route already has `deps`, so passing `deps.maxBodyBytes` needs no signature changes. The
  `HandlerResponse` `{ status: 413, ... }` flows through the existing `handleRequest` responder
  unchanged.

**Verify:** `pnpm --filter @agentops/control typecheck`; covered by Step 6.

### Step 6 — `packages/control/src/create-control-server.test.ts`

Using the existing `postJsonWithHeaders`/`fetch` harness and a `ControlDeps` with a tiny
`maxBodyBytes` and a valid `projectCrudAuthToken`:

- An oversized JSON body on a token-authed body-reading route (e.g. `POST /api/platform/runs` with
  `CRUD_HEADERS`) → `413`.
- A normal-sized body on the same route still works as before (regression guard).
- Optionally one over-limit `Content-Length` header case → `413`.

**Verify:** `pnpm --filter @agentops/control test`.

### Step 7 — `packages/control/src/main.ts`

- Read `CONTROL_MAX_BODY_BYTES`, parse to a positive integer, fall back to `DEFAULT_MAX_BODY_BYTES`;
  pass as `maxBodyBytes` in the `createControlServer({...})` deps.

**Verify:** `pnpm --filter @agentops/control typecheck`; manual read-through (wiring, no unit test).

### Step 8 — Full verification

- `pnpm lint && pnpm typecheck && pnpm test` — all green.
- `pnpm e2e` — green (no workflow/policy/activity/backend behavior change, but both servers are
  exercised; this confirms the gateway/control HTTP paths still work end-to-end).

## Sequencing rationale

- **Gateway first (Steps 1–3):** it is the actual reported pre-auth vulnerability and contains the
  only genuinely tricky logic — the mid-stream abort and the response-vs-`req.destroy()` race.
  Landing and testing it first de-risks the identical control change.
- **Test immediately after each core change (Steps 2, 6):** a bounded-reader change without a
  regression test that proves the short-circuit-before-verify property isn't done.
- **`main.ts` wiring last within each package (Steps 3, 7):** it depends on the exported
  default/constant and deps field existing, and is the lowest-risk part (env parse + pass-through).
- **Could-reorder note:** control (Steps 4–7) could technically precede gateway, but it is
  defense-in-depth on a route that is *already token-gated before the body is read*, so it is lower
  urgency and lower risk; doing it after the proven gateway pattern is strictly safer. The two
  packages are independent (no shared util), so there is no build-order coupling forcing a
  particular sequence — the order is chosen purely for risk, not necessity.

## Assumptions (resolved without a human)

- **Byte limits.** The issue specifies no cap. Gateway default = **25 MiB** (`26_214_400`),
  matching GitHub's documented webhook maximum so no legitimate delivery is ever rejected; Linear
  payloads are far smaller and share it. Control default = **1 MiB** (`1_048_576`) — it only
  handles small JSON (prompts, tier configs, decisions). Any finite cap fixes the unbounded-buffer
  bug; these are chosen to be safely above real traffic.
- **Env override names.** `GATEWAY_MAX_WEBHOOK_BODY_BYTES` and `CONTROL_MAX_BODY_BYTES`, parsed as
  positive base-10 integers with fallback to the defaults on unset/invalid/`<=0`. Matches the
  repo's env-driven config convention and lets tests inject a tiny limit via deps.
- **No shared util package.** AGENTS.md discourages new top-level packages for ~15 lines; the
  bounded reader is implemented independently in each package's existing body reader
  (`create-gateway-server.ts`, `handler-util.ts`). Cross-package coupling isn't worth it here.
- **Response-vs-destroy race.** On mid-stream overflow the handler writes the `413` first
  (best-effort) then `req.destroy()`s to free the socket. A malicious client may occasionally see a
  connection reset instead of the `413` body; the security invariant (bounded memory) holds
  regardless, and legitimate clients never reach this path. A `settled` guard prevents the
  promise from resolving/rejecting twice.
- **Scope includes control.** The reported hole is the gateway's pre-auth path, but leaving the
  identical unbounded reader in `handler-util.ts` would be a half-fix, so both are fixed under one
  theme. Control's fix is explicitly defense-in-depth (its mutating routes are token-gated *before*
  the body is read); it could be split into a follow-up PR if a narrower diff is preferred.
- **SLDS / contracts.** This is HTTP-boundary hardening — no workflow, stage, status, or SLDS
  lifecycle change, and no new cross-package data shape, so no `contracts` schema or README/SLDS
  update is required.

## Definition of done

`pnpm lint && pnpm typecheck && pnpm test` green; `pnpm e2e` green; no new dependencies; no TODOs.
New behavior (`413` on oversized bodies, before signature verification in the gateway) is covered
by unit tests in both `create-gateway-server.test.ts` and `create-control-server.test.ts`.
