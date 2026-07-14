# Plan — issue-agentic-ops-engine-102

**Goal:** [bughunt] Non-constant-time comparison of ArgoCD plugin bearer token

**Design:** `docs/superpowers/specs/issue-agentic-ops-engine-102-design.md` — Approach B:
extract a dedicated `verify-bearer-token.ts` helper that does a length-guarded
`timingSafeEqual`, and call it from `handleArgoCdGetParams` in place of the plain `!==`
comparison. Scope is the ArgoCD plugin route only; the two HMAC verifiers are already
constant-time and are not touched.

## Steps

### 1. Add the constant-time helper — `packages/gateway/src/verify-bearer-token.ts` (new)

Export `verifyBearerToken(authHeader: string | undefined, expectedToken: string): boolean`:
- Return `false` immediately if `authHeader` is `undefined` (missing header) — mirrors the
  early `if (!signatureHeader) return false` in `verify-signature.ts`.
- Build the expected value `` `Bearer ${expectedToken}` ``, buffer both it and `authHeader`
  as UTF-8.
- Length-guard: if the two buffers differ in length, return `false` (required — `timingSafeEqual`
  throws on unequal-length buffers; the token length is not itself the secret).
- Return `timingSafeEqual(expectedBuf, actualBuf)`.
- Add a leading comment explaining the constant-time rationale, matching the tone of the comments
  in `verify-signature.ts` / `verify-linear-signature.ts` so the next reader sees *why*.

**Verify:** `pnpm --filter @agentops/gateway typecheck` (file compiles under strict mode). Full
behavioral verification comes from step 3's unit test.

### 2. Use the helper at the call site — `packages/gateway/src/create-gateway-server.ts`

- Add `import { verifyBearerToken } from './verify-bearer-token';` alongside the existing
  `verify-*` imports.
- In `handleArgoCdGetParams`, replace:
  ```ts
  if (auth !== `Bearer ${deps.argocdPluginToken}`) {
  ```
  with:
  ```ts
  if (!verifyBearerToken(auth, deps.argocdPluginToken)) {
  ```
  Everything else in the handler is unchanged: the `!deps.argocdPluginToken || !deps.argocdParams`
  404 guard still precedes this check (so `verifyBearerToken` is only reached with a non-empty
  token), the body is still drained before auth, and the 401/200 responses are untouched.

**Verify:** `pnpm --filter @agentops/gateway typecheck`, then the existing route test
`packages/gateway/src/argocd-project-workers.test.ts` ("401s on a missing or wrong bearer token"
and "returns the ArgoCD plugin-generator shape with a valid token") must stay green — this is the
end-to-end proof the refactor is behavior-preserving (401/401/200 preserved).

### 3. Add the helper unit test — `packages/gateway/src/verify-bearer-token.test.ts` (new)

Mirror the structure of `verify-signature.test.ts`. Cases:
- `undefined` header → `false` (missing header).
- Wrong token (`Bearer wrong`) → `false`.
- Malformed header without the `Bearer ` prefix (e.g. `"secret"`) → `false`.
- Exact match (`Bearer <token>`) → `true`.
- Differing-length header → `false` (exercises the length guard so `timingSafeEqual` is never
  called with mismatched-length buffers — asserts no throw).

**Verify:** `pnpm test` (root vitest run) — the new test file passes and no existing test regresses.

## Sequencing notes

- **Helper (1) before call-site (2):** step 2's import would not typecheck until the module in
  step 1 exists, so the helper must land first. This is also the natural de-risking order — the
  isolated, trivially-testable unit comes before wiring it into the HTTP handler.
- **Test (3) after the code it covers:** written last so it imports the real, final signature. It
  could be written first (TDD), but since the helper is a few lines and the behavior is fully
  specified by the design, ordering the test after keeps the plan's verification steps monotonic
  (each step is green before the next starts). Either order is safe; I did not reorder.
- The existing `argocd-project-workers.test.ts` is intentionally left unchanged — it is the
  regression guard for step 2 and must pass as-is.

## Final verification (definition of done)

From the repo root: `pnpm lint && pnpm typecheck && pnpm test`, all green. The e2e suite is not
required here — this change touches only `packages/gateway` (not workflows/policies/activities/
backends), and the design explicitly leaves the ArgoCD wire contract, env handling, and generator
response shape unchanged.

## Assumptions

- **Helper naming/placement.** A co-located `verify-bearer-token.ts` module (one file per verifier,
  matching `verify-signature.ts` / `verify-linear-signature.ts`) rather than a shared crypto-utils
  file — the design chose this and the repo already favors it.
- **Behavior is identical for legitimate clients.** The fix changes only *how* the comparison is
  done; missing header → 401, wrong token → 401, correct token → 200 are all preserved. Guarded by
  the unchanged route test.
- **Token length is not sensitive.** Length-guarding before `timingSafeEqual` can leak whether the
  supplied header length equals the expected length but not the token bytes — the same accepted
  trade-off already made in the two HMAC verifiers, so no fixed-length padding is added.
- **Scope is the ArgoCD path only.** The two HMAC verifiers are already constant-time and are not
  modified (rules out the generic-utility refactor of design option C as out-of-scope).
- **No test-timing assertion.** The unit test verifies correctness (accept/reject outcomes) and the
  length guard, not wall-clock constant-timeness — timing assertions are flaky and the security
  property is guaranteed by using `crypto.timingSafeEqual`, consistent with how the existing
  verifier tests are written.
