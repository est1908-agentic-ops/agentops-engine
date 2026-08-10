# Design — Task issue-agentic-ops-engine-192

**[bughunt] Unbounded request-body buffering before auth/signature verification**

## Goal

The gateway's public webhook endpoints (`POST /webhooks/github`, `POST /webhooks/linear`)
read the **entire** HTTP request body into memory before verifying the HMAC signature. An
unauthenticated attacker can stream an arbitrarily large body and exhaust the process's
memory — a trivial pre-auth denial-of-service. The fix is to put a finite cap on how many
bytes any of the engine's raw-`node:http` servers will buffer, rejecting oversized requests
with `413 Payload Too Large` *before* the signature check and before `JSON.parse`, without
ever accumulating the full body.

The same unbounded-buffer pattern exists in the control server's `readJsonBody`; although
its mutating routes are token-gated *before* the body is read (so it is not strictly a
pre-auth hole), it is the identical defect and is fixed under the same theme for
defense-in-depth.

### Confirmed root cause

`packages/gateway/src/create-gateway-server.ts` — `readRawBody` (≈ lines 43–50):

```ts
function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk)); // no cumulative size check
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
```

`handleGithubWebhook`/`handleLinearWebhook` call `readRawBody(req)` and *then* call
`verifyGithubSignature`/`verifyLinearSignature`. The verifiers must hash the **raw** bytes
(HMAC over the exact body, before `JSON.parse`), so the fix cannot avoid reading the body —
it must *cap* it. Both servers use raw `node:http` (no Express/Fastify), so there is no
framework body-size limit anywhere; a grep confirms no existing `content-length` check,
`413`, or `maxBodySize` in `packages/`.

The verifier functions themselves already use `crypto.timingSafeEqual` correctly and are not
changed.

## Approaches considered

### A. Hand-rolled size cap inside the existing raw-body readers *(recommended)*

Give each reader a `maxBytes` limit. Reject an oversized `Content-Length` up front, and
during streaming track the cumulative byte count; when it exceeds the limit, stop
accumulating, destroy the request, and reject with a typed `PayloadTooLargeError`. The
handlers map that error to `413` before verifying the signature.

- **Trade-off:** ~15 lines of stream-handling logic to get right (mid-stream abort, the
  race between sending a response and destroying the socket). No new dependency; matches the
  repo's existing hand-rolled `node:http` style; fully unit-testable via the existing
  `fetch`-driven HTTP tests.
- **Cost/complexity:** Low. Touches two body readers + their call sites + `main.ts` wiring.

### B. Introduce a body-parsing library (`raw-body` / `getRawBody`)

Replace the hand-rolled readers with `raw-body`, which handles limits, `Content-Length`
mismatch, and encoding.

- **Trade-off:** Well-tested library, but adds a runtime dependency to `gateway` and
  `control` for ~15 lines of logic. AGENTS.md favors minimalism and the repo deliberately
  uses bare `node:http` with zero HTTP-framework deps. Ports/vendor rules don't forbid it,
  but it's disproportionate to the problem.
- **Cost/complexity:** Low code, but a new dependency and a larger review surface than the
  bug warrants.

### C. Enforce the limit only at the ingress (Traefik `maxRequestBodyBytes`)

Configure the reverse proxy in front of the gateway to reject large bodies.

- **Trade-off:** Protects all routes uniformly with no app code change, but the defense lives
  entirely outside the repo — it isn't covered by `pnpm test`, doesn't satisfy the code-level
  Definition of Done, and leaves the process vulnerable in any deployment or test context
  that reaches the server directly (the e2e/dev paths bind the server without Traefik). It
  fixes the deployment, not the code.
- **Cost/complexity:** Low, but out-of-repo and untestable here.

## Chosen approach

**Approach A.** It fixes the defect at the layer that actually owns the risk (the process
that buffers the bytes), needs no new dependency, matches the existing code style, and is
directly regression-testable with the gateway's existing HTTP test harness. B is rejected
because a dependency is disproportionate to ~15 lines and cuts against the repo's zero-HTTP-
framework convention. C is rejected because it is an out-of-repo mitigation that leaves the
code vulnerable and untested; it is worth adding as a *complementary* ingress hardening later
but is not the fix for this bug. (Approach A does not preclude C — belt and suspenders.)

## Assumptions

- **Byte limits.** The issue doesn't specify a cap. GitHub documents that webhook payloads
  are capped at 25 MB on their side, so I set the **gateway** default to **25 MiB**
  (`26_214_400`) — any finite cap fixes the unbounded-buffer bug, and choosing GitHub's own
  documented maximum guarantees no legitimate delivery is ever rejected. Linear payloads are
  far smaller and share the same generous cap. The **control** server handles small JSON
  bodies (prompts, tier configs), so its default is **1 MiB** (`1_048_576`).
- **Configurable via env.** Both limits are overridable via env in the respective `main.ts`
  (`GATEWAY_MAX_WEBHOOK_BODY_BYTES`, `CONTROL_MAX_BODY_BYTES`) and threaded through the
  server deps so tests can inject a tiny limit. This matches the repo's env-driven config
  convention and lets ops tune without a code change.
- **Scope includes the control server.** The reported vulnerability is the gateway's
  pre-auth path, but leaving the identical unbounded reader in `control/handler-util.ts`
  would be a half-fix. Both are fixed under one coherent theme ("no unbounded request-body
  buffering in the engine's raw-`node:http` servers"). This is deliberately called out in
  self-review below.
- **No shared util package.** Rather than create a new top-level package for a ~15-line
  helper (which AGENTS.md discourages), the bounded reader is implemented in each package's
  existing body reader. The two are small and independent; cross-package coupling for this
  isn't worth it.
- **Response-vs-destroy race.** On mid-stream overflow the handler sends the `413` response
  first (best effort) and then destroys the request stream to release the socket. A client
  may occasionally see a connection reset instead of the `413` body; the security invariant
  (bounded memory) holds regardless, and legitimate clients never hit this path.
- **SLDS alignment.** This is a security hardening of an HTTP boundary; it does not change
  any workflow, stage, status, or the SLDS lifecycle. No SLDS/README update is required.

## Design

### Components / files affected

**`packages/gateway/src/create-gateway-server.ts`** (primary fix)
- Add a `PayloadTooLargeError` (local typed error / sentinel) and a module constant
  `DEFAULT_MAX_WEBHOOK_BODY_BYTES = 25 * 1024 * 1024`.
- Change `readRawBody(req, maxBytes)`:
  - If the `content-length` header is present, numeric, and `> maxBytes` → reject
    immediately with `PayloadTooLargeError` (no reading).
  - On each `data` chunk, add to a running total; when it exceeds `maxBytes`, stop pushing
    chunks, reject with `PayloadTooLargeError`, and `req.destroy()`.
  - Otherwise behave as today (`Buffer.concat` on `end`).
- Add `maxWebhookBodyBytes?: number` to `GatewayDeps` (default to the constant when unset).
- In `handleGithubWebhook` and `handleLinearWebhook`, wrap the `await readRawBody(...)` in a
  `try/catch`; on `PayloadTooLargeError` respond `res.writeHead(413).end('payload too large')`
  and return — this happens **before** signature verification and `JSON.parse`. The outer
  `catch` in `createGatewayServer` remains the backstop for anything unexpected.

**`packages/gateway/src/main.ts`**
- Read `GATEWAY_MAX_WEBHOOK_BODY_BYTES` (parse to a positive integer; fall back to the
  default) and pass it as `maxWebhookBodyBytes` in the deps.

**`packages/control/src/handler-util.ts`** (defense-in-depth)
- Change `readJsonBody(req, maxBytes)` with the same `content-length` + cumulative-length cap
  and `PayloadTooLargeError` behavior; keep the existing empty-body → `{}` and
  invalid-JSON → reject semantics.
- Export the shared error type (or a small `isPayloadTooLarge` check) so callers can map it
  to `413`.

**`packages/control/src/create-control-server.ts`** (+ the other route modules that call
`readJsonBody`: `devcycle-routes.ts`, `chat-routes.ts`, `settings-routes.ts`,
`tiers-routes.ts`)
- Add `maxBodyBytes?: number` to `ControlDeps` (default `1 MiB`), thread the limit into
  `readJsonBody` calls, and map `PayloadTooLargeError` to a `413` response. Where a caller's
  existing `catch` currently returns `400 invalid JSON`, distinguish the oversize case and
  return `413` instead.

**`packages/control/src/main.ts`**
- Read `CONTROL_MAX_BODY_BYTES` (parse; fall back to default) into the deps.

### Data flow (gateway webhook, after fix)

1. Request arrives at `/webhooks/github` (or `/webhooks/linear`).
2. `readRawBody(req, limit)` — reject early on oversized `Content-Length`; abort + reject
   mid-stream if the body exceeds `limit`; otherwise return the (now bounded) raw buffer.
3. On `PayloadTooLargeError` → `413`, return. **No signature check, no parse, no workflow
   start.**
4. On success → existing flow: `verify*Signature` on the raw bytes → `401` if invalid →
   `JSON.parse` → route to the appropriate parser/starter.

### Error handling

- Oversized body → `413 Payload Too Large` (new).
- Existing paths unchanged: bad/missing signature → `401`; invalid JSON → `400`; unknown
  event → `204`/`202`; downstream failure → `500`.
- `req.destroy()` after the `413` releases the socket so a malicious client can't hold the
  connection open mid-upload.

### Tests

- **`packages/gateway/src/create-gateway-server.test.ts`**: inject a small
  `maxWebhookBodyBytes`; assert that (a) a body over the limit returns `413`, (b) the
  signature verifier / workflow client is never reached for an oversized body (memory not
  accumulated / no side effect), and (c) a normal-sized signed body still succeeds
  (existing tests). Include a case where `Content-Length` claims a large size.
- **`packages/control/src/create-control-server.test.ts`**: assert an oversized JSON body on
  a body-reading route returns `413` and normal bodies still work.
- Existing `verify-signature` / `verify-linear-signature` unit tests are unaffected.

### Definition of done

`pnpm lint && pnpm typecheck && pnpm test` green; `pnpm e2e` green (no
workflow/policy/activity/backend behavior changes, but the gateway is exercised). No new
dependencies. No TODOs.

## Self-review

- **Placeholders / TBD:** none.
- **Contradictions:** none. The one nuance — the control server reads its body *after* auth,
  unlike the gateway — is stated consistently in Goal, Assumptions, and Design.
- **Scope:** one coherent change — "cap request-body buffering in the engine's raw-`node:http`
  servers." It spans two packages (gateway + control) by design; this is called out
  explicitly rather than smoothed over. The gateway fix alone resolves the reported pre-auth
  vulnerability; the control fix is defense-in-depth for the identical pattern and could be
  split into a follow-up if a reviewer prefers a narrower PR.

## Brainstorm Summary
**Approaches considered:** (A) a hand-rolled byte cap inside the existing raw-`node:http` body readers; (B) adopt a `raw-body`/`getRawBody` dependency; (C) enforce the limit only at the Traefik ingress.
**Chosen approach:** (A) — cap the bytes in the readers, reject oversized requests with `413` before signature verification and `JSON.parse`, aborting the stream mid-upload.
**Why (decisive reasons):** No new dependency and it matches the repo's zero-HTTP-framework `node:http` style; it fixes the defect in the process that actually buffers the bytes; and it's directly regression-testable with the existing `fetch`-driven tests. B is disproportionate to ~15 lines; C is an out-of-repo mitigation that leaves the code vulnerable and untested.
**Key risks/assumptions:** Limits are env-configurable (gateway default 25 MiB = GitHub's documented cap, so no legit delivery is rejected; control default 1 MiB). Scope covers both the gateway (the real pre-auth hole) and control's identical reader (defense-in-depth, though it reads after auth). Minor best-effort race between sending the `413` and destroying the socket; memory-bound invariant holds regardless.
