# Design — Non-constant-time comparison of control-plane CRUD auth token

**Task:** issue-agentic-ops-engine-100
**Date:** 2026-07-14
**Package:** `packages/control`

## Problem

The control server gates its mutating CRUD routes (create/update/delete
managed projects, trigger agent runs, replace tier routing, update self-heal
settings, platform chats) behind a single operator bearer token supplied in the
`X-Control-Crud-Token` header and compared against `deps.projectCrudAuthToken`.

The comparison is done with JavaScript's `===` string operator in two helpers in
`packages/control/src/create-control-server.ts`:

```ts
function authorizeProjectCrud(deps, req): boolean {
  return req.headers['x-control-crud-token'] === deps.projectCrudAuthToken;
}
function authorizeControlToken(deps, req): boolean {
  return Boolean(deps.projectCrudAuthToken) && req.headers['x-control-crud-token'] === deps.projectCrudAuthToken;
}
```

`===` on strings short-circuits at the first differing byte, so the time taken
to reject a wrong token correlates with how many leading bytes were correct.
Over many requests an attacker can measure these differences and recover the
token one byte at a time (a classic timing side-channel). This is exactly the
class of attack the repo already defends against for webhook signatures in
`packages/gateway/src/verify-signature.ts` and `verify-linear-signature.ts`,
which use `crypto.timingSafeEqual`. The control-plane CRUD token — arguably a
higher-value secret, since it authorizes fleet-wide writes — was left on the
naive comparison.

**Secondary correctness issue (in scope, same code):** `authorizeProjectCrud`
does not guard against an unset token. When `deps.projectCrudAuthToken` is
`undefined` and the header is absent, `undefined === undefined` evaluates to
`true`. The `/api/projects` routes happen to pre-check `isProjectCrudEnabled`,
but `/api/agents/:id/run` (line ~299), `/api/settings/self-heal` PUT (line ~336)
and `/api/tiers` PUT call `authorizeProjectCrud` directly with no such gate, so
a deployment without `CONTROL_CRUD_TOKEN` set would treat unauthenticated
requests to those routes as authorized. `authorizeControlToken` already guards
this with `Boolean(deps.projectCrudAuthToken)`; the fix should make both helpers
consistently fail-closed.

## Candidate approaches

### A. Inline `timingSafeEqual` in each helper (mirror the gateway pattern locally)

Rewrite both `authorizeProjectCrud` and `authorizeControlToken` to buffer both
sides, length-guard, and call `timingSafeEqual`, copying the shape used in
`verify-signature.ts`.

- **Pros:** Directly follows an already-reviewed in-repo pattern; no new
  surface.
- **Cons:** Duplicates the buffer/length-guard/fail-closed logic in two places;
  each copy is an opportunity to get the empty-token or array-header edge case
  wrong. Two near-identical blocks invite drift.

### B. One shared constant-time token helper in `packages/control`, used by both authorize functions (recommended)

Add a single private helper — `constantTimeTokenEqual(configured, provided)` —
in the control package (colocated in `create-control-server.ts`, or in the
existing `handler-util.ts`). It:
1. returns `false` if `configured` is empty/undefined (fail-closed),
2. normalizes the incoming header value (`string | string[] | undefined`) to a
   single string, returning `false` for missing/array values,
3. compares with `crypto.timingSafeEqual` over UTF-8 buffers, with a
   length-equality pre-check (since `timingSafeEqual` throws on unequal
   lengths).

Both `authorizeProjectCrud` and `authorizeControlToken` become one-liners
delegating to it. `authorizeControlToken`'s explicit `Boolean(...)` guard
becomes redundant (folded into the helper) but can stay for clarity.

- **Pros:** Single place to reason about constant-time behavior, fail-closed
  semantics, and header normalization; both call sites provably consistent;
  smallest correct change. Matches repo convention (`timingSafeEqual`) while
  removing duplication.
- **Cons:** Introduces one small helper. Trivial.

### C. Extract a cross-package `constantTimeEqual` util shared by control + gateway

Create a shared utility (e.g. in a `packages/*/crypto` or contracts-adjacent
location) and refactor the two gateway verifiers plus the control helpers to
use it.

- **Pros:** Maximal DRY across the whole repo.
- **Cons:** Out of scope. The gateway helpers are HMAC-specific (they compute
  the digest *and* compare); the shared surface is only the final comparison,
  which is a few lines. There is no existing shared low-level crypto util
  package, and AGENTS.md forbids creating new top-level packages without a
  separate design spec. This would touch three files across two packages and
  risk regressing already-correct, tested webhook verification for a marginal
  gain. Rejected as scope creep.

## Recommendation

**Approach B.** It fixes the timing side-channel using the repo's established
`timingSafeEqual` convention, eliminates the `undefined === undefined`
fail-open, and de-duplicates the two authorize helpers behind one audited
comparison — all within a single package and a single coherent change. A is
rejected for duplicating fragile edge-case handling; C is rejected as an
unnecessary cross-package refactor that widens blast radius and bumps against
the "no new packages without a spec" rule.

### Constant-time detail (decided)

Follow the gateway convention: UTF-8 buffer both sides, pre-check
`length !== length` → `false`, then `timingSafeEqual`. This leaks only the
*length* of the configured token (via the early return), not its contents.
Leaking token length is an accepted trade-off here and matches the existing
`verify-signature.ts` behavior, so the two comparison sites in the repo stay
consistent and reviewable. A hash-both-sides-then-compare variant (SHA-256 both
values to a fixed 32-byte length, avoiding any length branch) was considered but
rejected: it diverges from the established pattern for no meaningful gain, since
the token length is not itself sensitive and an attacker who can brute-force by
length can already be rate-limited/basic-auth-fronted per the ingress design.

## What changes (components / files)

1. **`packages/control/src/create-control-server.ts`**
   - Add `timingSafeEqual` to the existing `node:crypto` import (line 1).
   - Add a private `constantTimeTokenEqual(configured: string | undefined,
     provided: string | string[] | undefined): boolean` helper implementing
     fail-closed + header normalization + constant-time compare, with a short
     comment explaining the timing-attack rationale (matching the tone of the
     gateway comments).
   - Rewrite `authorizeProjectCrud` and `authorizeControlToken` to delegate to
     the helper. No route wiring, status codes, or header name changes.

   (If `handler-util.ts` is the better home for the helper to keep the server
   file lean, place it there and export it internally to the package — decided
   during implementation; behavior is identical either way.)

2. **`packages/control/src/create-control-server.test.ts`**
   - Add/extend tests asserting: correct token → authorized (200); wrong token
     of the *same length* and of a *different length* → 401 (guards the
     length-branch path); missing header → 401; and — the fail-closed
     regression — when no `projectCrudAuthToken` is configured, a request to a
     directly-gated route (`POST /api/agents/:id/run`) with no token → 401 (not
     authorized). The existing `CRUD_TOKEN` / `CRUD_HEADERS` fixtures and
     `getJsonWithHeaders` helper already support this.

No contract, workflow, policy, activity, or backend code changes. No new
dependencies (`node:crypto` is built in). No prompt or vocabulary changes.

## Assumptions

- **Header home / helper location:** Whether the helper lives in
  `create-control-server.ts` or `handler-util.ts` is left to implementation;
  both are within `packages/control` and behavior is identical. Assumption:
  colocate in `create-control-server.ts` unless it makes the file materially
  harder to read.
- **Length-leak acceptable:** Assumed leaking the configured token's length via
  the length pre-check is acceptable, consistent with the existing gateway
  verifiers. Not hashing to fixed length.
- **Fail-closed on unset token is desired:** Assumed the intended semantics are
  that an unconfigured CRUD token denies all mutating requests (matching
  `authorizeControlToken`'s existing guard and the `isProjectCrudEnabled`
  intent), rather than the current accidental fail-open on the agent-run /
  self-heal / tiers routes. Recorded as an in-scope correctness fix since it
  lives in the same comparison being hardened.
- **Header normalization:** Node may present a repeated header as `string[]`.
  Assumed the correct behavior for a duplicated/array `X-Control-Crud-Token` is
  to deny (return `false`), since a legitimate client sends exactly one.
- **No behavior change for the happy path:** Assumed no client relies on the
  timing or on the fail-open behavior; the only observable change is that
  previously-"authorized" unconfigured-token requests now correctly get 401.

## Self-review

- No placeholders or TODOs.
- Sections are consistent: the timing fix and the fail-closed fix both live in
  the same two helpers and are addressed by the one recommended helper.
- Scope is a single coherent change confined to `packages/control` (one source
  file + its test). The secondary fail-closed correctness fix is not scope
  creep — it is in the exact lines being rewritten and is required for the
  helper to be correct.
- Honors AGENTS.md: no new packages, no new deps, contracts untouched, tests
  updated in the same PR, uses the repo's existing `timingSafeEqual` convention.

## Brainstorm Summary
**Approaches considered:** (A) inline `timingSafeEqual` in each of the two auth helpers, (B) one shared constant-time token helper in `packages/control` used by both, (C) a cross-package `constantTimeEqual` util shared with the gateway webhook verifiers.
**Chosen approach:** (B) — a single private `constantTimeTokenEqual` helper in the control package that both `authorizeProjectCrud` and `authorizeControlToken` delegate to.
**Why (decisive reasons):** Fixes the timing side-channel using the repo's established `crypto.timingSafeEqual` convention, de-duplicates the comparison behind one audited path, and folds in a fail-closed guard — all within one package/one change. (A) duplicates fragile edge-case handling; (C) is scope creep across two packages and bumps the "no new packages without a spec" rule.
**Key risks/assumptions:** Length pre-check leaks token *length* only (accepted, matches gateway). Also hardens a latent fail-open: `authorizeProjectCrud` currently returns true when both header and configured token are `undefined`, and some routes (`/api/agents/:id/run`, self-heal PUT) don't pre-gate on `isProjectCrudEnabled` — the helper now denies unconfigured-token requests.
