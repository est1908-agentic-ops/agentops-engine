# Design — issue-agentic-ops-engine-102

**Goal:** [bughunt] Non-constant-time comparison of ArgoCD plugin bearer token

## Problem

`packages/gateway/src/create-gateway-server.ts` authenticates the ArgoCD
ApplicationSet plugin-generator route (`POST /api/v1/getparams.execute`) by
comparing the incoming `Authorization` header against the expected value with a
plain JavaScript string inequality:

```ts
if (auth !== `Bearer ${deps.argocdPluginToken}`) { ... 401 }
```

JavaScript string `===`/`!==` short-circuits on the first differing byte, so the
time to reject a wrong token varies with how many leading bytes match. An
attacker who can measure response latency can, in principle, recover the token
byte-by-byte (a classic timing side channel). This is exactly the leak the repo
already guards against elsewhere: `verify-signature.ts` and
`verify-linear-signature.ts` both use `node:crypto`'s `timingSafeEqual` and
document *why*. The ArgoCD bearer-token path is the odd one out.

`ARGOCD_PLUGIN_TOKEN` is a long-lived shared secret (set from env, guarding the
generator that ArgoCD polls), so a token disclosure is meaningful: it would let
an attacker enumerate project-worker parameters. Fixing the comparison brings
this route in line with the other two authenticated gateway endpoints.

## Candidate approaches

### A. Inline `timingSafeEqual` inside `handleArgoCdGetParams`
Import `timingSafeEqual` and compare buffers directly in the handler: build the
expected `Bearer <token>` string, buffer both, length-check, then
`timingSafeEqual`.

- **Pros:** Smallest diff; entirely local to the one buggy call site.
- **Cons:** Duplicates the length-guard + buffer-compare boilerplate that already
  exists (twice) in the `verify-*` files. Bearer-token auth is conceptually the
  same "authenticate a request" concern those helpers cover, so inlining it
  where the other two are extracted is inconsistent and invites the next reader
  to miss the timing requirement again.

### B. Extract a small shared constant-time helper (recommended)
Add a dedicated module `packages/gateway/src/verify-bearer-token.ts` exporting a
pure function (e.g. `verifyBearerToken(authHeader: string | undefined, token:
string): boolean`) that builds the expected `Bearer <token>`, does a
length-guarded `timingSafeEqual`, and returns a boolean. `handleArgoCdGetParams`
calls it in place of the `!==` check. This mirrors the existing
`verifyGithubSignature` / `verifyLinearSignature` structure (one file, one
documented function, one focused unit test).

- **Pros:** Consistent with the established gateway pattern; the constant-time
  requirement lives in one obvious, well-commented place; trivially unit-testable
  in isolation without booting the HTTP server; handles the `undefined`/missing
  header case cleanly.
- **Cons:** One extra file. Marginally more code than option A.

### C. Generic `timingSafeStringEqual(a, b)` utility + refactor all three sites
Introduce one low-level constant-time string-equality primitive and rewrite
`verify-signature.ts`, `verify-linear-signature.ts`, and the ArgoCD path to use
it.

- **Pros:** Removes buffer-compare duplication across all three files.
- **Cons:** Out of scope — the task is a single bughunt fix on the ArgoCD path.
  Touching the two HMAC verifiers (which are already correct) adds risk and
  review surface for no security benefit. A broader dedup can be a separate
  refactor if desired.

## Recommendation

**Approach B.** It fixes the actual vulnerability, matches the repo's existing
convention for authenticating gateway requests (dedicated `verify-*.ts` module +
focused test + explanatory comment), keeps the change small and self-contained,
and does not disturb the already-correct HMAC verifiers. Approach A is rejected
for being inconsistent with the surrounding code; Approach C is rejected as
scope creep that touches correct, security-sensitive code unnecessarily.

## What changes

- **New file `packages/gateway/src/verify-bearer-token.ts`** — exports
  `verifyBearerToken(authHeader: string | undefined, expectedToken: string):
  boolean`. Returns `false` for a missing header; otherwise compares
  `` `Bearer ${expectedToken}` `` against the header using a length-guard plus
  `timingSafeEqual` (length is checked first because `timingSafeEqual` throws on
  unequal-length buffers — the same pattern the existing verifiers use; the
  length of a bearer token is not itself the secret). A comment explains the
  constant-time rationale, consistent with the two sibling files.

- **`packages/gateway/src/create-gateway-server.ts`** — replace the
  `auth !== \`Bearer ${deps.argocdPluginToken}\`` check in
  `handleArgoCdGetParams` with `if (!verifyBearerToken(auth, deps.argocdPluginToken))`.
  Behavior is unchanged for callers: missing header, wrong token, and correct
  token still map to 401 / 401 / 200 respectively. The `!deps.argocdPluginToken`
  guard earlier in the handler still returns 404 when the generator is
  unconfigured, so `verifyBearerToken` is only reached with a non-empty token.

- **New test `packages/gateway/src/verify-bearer-token.test.ts`** — unit tests
  for the helper: `undefined` header → false, wrong token → false, malformed
  header (`"secret"` without `Bearer ` prefix) → false, exact match → true, and a
  differing-length header → false (exercises the length guard so `timingSafeEqual`
  is never called with mismatched lengths).

- **Existing `packages/gateway/src/argocd-project-workers.test.ts`** — no change
  required; its "401s on a missing or wrong bearer token" and "valid token"
  cases already cover the route end-to-end and must stay green, confirming the
  refactor is behavior-preserving.

No changes to the ArgoCD wire contract, env-var handling (`ARGOCD_PLUGIN_TOKEN`
in `main.ts`), or the generator response shape.

## Assumptions

- **Behavior must be identical for legitimate clients.** The fix only changes
  *how* the comparison is done, not the accept/reject outcomes, so ArgoCD's
  existing `Authorization: Bearer <token>` requests keep working. (Confirmed by
  the existing route tests.)
- **Token length is not sensitive.** Length-guarding before `timingSafeEqual`
  (required by the API) can leak whether the supplied header length equals the
  expected length, but not the token bytes. This matches the accepted trade-off
  already made in `verify-signature.ts`/`verify-linear-signature.ts`, so I kept
  the same approach rather than padding to a fixed length.
- **Scope is the ArgoCD path only.** The task is a single bughunt finding; the
  two HMAC verifiers are already constant-time, so I deliberately do not touch
  them (no dedup refactor here).
- **Helper naming/placement.** I assumed a co-located `verify-bearer-token.ts`
  module (matching `verify-signature.ts` / `verify-linear-signature.ts`) is
  preferred over a shared crypto-utils file, since the repo already favors one
  small file per verifier.

## Self-review

- No placeholders or TODOs; all files and function names are concrete.
- No contradictions: the 404-when-unconfigured guard is preserved and precedes
  the new check; the new helper only affects the auth decision, which the design
  states is behavior-preserving.
- This is one coherent change: a security fix to a single comparison, plus the
  minimal helper + test needed to do it in the repo's idiom.

## Brainstorm Summary
**Approaches considered:** (A) inline `timingSafeEqual` at the one call site; (B) extract a small `verifyBearerToken` helper module mirroring the existing `verify-signature.ts` verifiers; (C) a generic constant-time string-equality util refactoring all three auth sites.
**Chosen approach:** (B) — a dedicated `verify-bearer-token.ts` helper used by the ArgoCD plugin route.
**Why (decisive reasons):** Fixes the timing side channel while matching the repo's established one-file-per-verifier convention, stays small and self-contained, is unit-testable in isolation, and avoids touching the already-correct HMAC verifiers (rules out C as scope creep; A is inconsistent with surrounding code).
**Key risks/assumptions:** Behavior is unchanged for real clients (401/401/200 preserved); token *length* can still leak via the required length guard — accepted, same trade-off as existing verifiers; scope limited to the ArgoCD path.
