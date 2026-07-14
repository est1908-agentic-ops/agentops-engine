# Plan — Non-constant-time comparison of control-plane CRUD auth token

**Task:** issue-agentic-ops-engine-100
**Design:** `docs/superpowers/specs/issue-agentic-ops-engine-100-design.md` (Approach B —
one shared `constantTimeTokenEqual` helper in `packages/control`, delegated to by
both `authorizeProjectCrud` and `authorizeControlToken`)

## Summary

Two source-level facts changed by this work, both in
`packages/control/src/create-control-server.ts`:

1. Replace the naive `===` token comparison in `authorizeProjectCrud` and
   `authorizeControlToken` with a single `crypto.timingSafeEqual`-based helper
   (`constantTimeTokenEqual`), matching the repo's existing convention in
   `packages/gateway/src/verify-signature.ts`.
2. Make both helpers fail-closed when `projectCrudAuthToken` is unset, closing
   the latent `undefined === undefined → true` fail-open that affects the
   directly-gated routes (`POST /api/agents/:id/run`, `PUT /api/settings/self-heal`,
   `PUT /api/tiers`).

Tests are added/extended in
`packages/control/src/create-control-server.test.ts`. No contract, workflow,
policy, activity, or route-wiring changes; no new dependencies (`node:crypto` is
built in).

## Steps

### Step 1 — Add the constant-time helper and rewrite both authorize functions

**File:** `packages/control/src/create-control-server.ts`

- Extend the existing `node:crypto` import (line 1) to add `timingSafeEqual`:
  `import { randomUUID, timingSafeEqual } from 'node:crypto';`.
- Add a private helper above `authorizeProjectCrud` (~line 155):

  ```ts
  function constantTimeTokenEqual(
    configured: string | undefined,
    provided: string | string[] | undefined,
  ): boolean
  ```

  Behavior, in order (fail-closed at every branch):
  1. If `configured` is falsy (undefined/empty), return `false`.
  2. If `provided` is not a single string (undefined or `string[]` from a
     repeated header), return `false`.
  3. UTF-8 buffer both sides; if lengths differ, return `false` (avoids
     `timingSafeEqual` throwing on unequal lengths — this leaks only the
     configured token's *length*, an accepted trade-off matching
     `verify-signature.ts`).
  4. Return `timingSafeEqual(configuredBuf, providedBuf)`.

  Include a short comment explaining the timing-attack rationale, in the tone of
  the gateway comment.
- Rewrite the two helpers to delegate:

  ```ts
  function authorizeProjectCrud(deps, req): boolean {
    return constantTimeTokenEqual(deps.projectCrudAuthToken, req.headers['x-control-crud-token']);
  }
  function authorizeControlToken(deps, req): boolean {
    return constantTimeTokenEqual(deps.projectCrudAuthToken, req.headers['x-control-crud-token']);
  }
  ```

  Preserve the existing `X-Control-Crud-Token`-vs-`Authorization` explanatory
  comment on `authorizeProjectCrud`. The two functions are now identical; keep
  both names so the call sites and their intent (`authorizeControlToken` for
  chats, `authorizeProjectCrud` for project/agent/tier/self-heal) remain
  self-documenting, and the design's fail-closed guarantee holds uniformly.

  Decision (per design assumption): colocate the helper in
  `create-control-server.ts` rather than `handler-util.ts` — it is short and the
  server file already owns both call sites; moving it out would add an import for
  no readability gain.

**Verify:**
- `pnpm --filter @agentops/control typecheck` (or repo-root `pnpm typecheck`) is
  clean — confirms the new import and helper signature type-check.
- `pnpm lint` clean on the changed file.
- Behavior is exercised by the tests in Step 2; this step is not "done" until
  Step 2 passes.

### Step 2 — Add/extend auth tests

**File:** `packages/control/src/create-control-server.test.ts`

Using the existing `CRUD_TOKEN` / `CRUD_HEADERS` fixtures, `getJsonWithHeaders`,
and the projects/agents describe blocks:

1. **Timing-fix path coverage (correct + both wrong-token shapes).** Extend the
   existing `'returns 401 without/with-wrong the bearer token'` projects test (or
   add a sibling) to assert:
   - correct token → authorized (existing project CRUD tests already cover 200/201);
   - a wrong token of the **same length** as `CRUD_TOKEN` → 401;
   - a wrong token of a **different length** → 401 (guards the length-branch
     early-return path);
   - missing header → 401 (already asserted via `getJson`).
2. **Fail-closed regression (the in-scope correctness fix).** In the agents
   describe block, add a test: construct `deps` **without** `projectCrudAuthToken`
   (delete it before `listen`, mirroring the projects `503` test), then
   `POST /api/agents/:id/run` **with no token** and assert **401** (not 202, not
   an accidental authorize). This is the exact route that lacks an
   `isProjectCrudEnabled` pre-gate, so it proves the `undefined === undefined`
   fail-open is closed.
   - Also assert that with no configured token, a request that happens to send an
     empty `x-control-crud-token: ''` header → 401 (falsy-configured branch).

**Verify:**
- `pnpm --filter @agentops/control test` (vitest) — all new and existing control
  tests green. Specifically the two new assertions (different-length wrong token,
  and unconfigured-token → 401 on `/api/agents/:id/run`) must pass, and no
  previously-passing test regresses.

### Step 3 — Full gate + commit

**Verify (repo definition of done, AGENTS.md §6):**
- `pnpm lint && pnpm typecheck && pnpm test` all green locally.
- The e2e suite (`pnpm e2e`) is **not** required: this change touches neither
  workflows, policies, activities, nor backends — only the control HTTP server
  and its unit tests (AGENTS.md scopes e2e to those four areas).
- Commit with a `fix:` conventional-commit message describing the timing
  hardening + fail-closed correctness fix.

## Sequencing notes

- **Step 1 before Step 2** is the natural order (tests reference the new
  behavior), but the *risk* is de-risked by Step 2: the source change is small
  and its only observable behavioral change (unconfigured-token routes now
  return 401) is precisely what the new fail-closed test asserts. The
  same-length-vs-different-length wrong-token tests are the guard that the
  `timingSafeEqual` length pre-check didn't accidentally invert. I considered
  writing the tests first (TDD) — the new fail-closed test would fail against the
  current code, proving the bug — but chose source-then-test because both live in
  one small package and are committed together; the test's job here is
  regression-locking, and it is verified to pass at the end of Step 2 regardless
  of authoring order.
- **Helper placement is settled in Step 1** (colocated), so there is no separate
  "decide location" step to sequence.
- Step 3 is intentionally a distinct step: the per-package verifies in Steps 1–2
  are fast inner-loop checks; the repo-wide `lint && typecheck && test` gate is
  the definition-of-done check and must pass on the whole workspace before commit.

## Assumptions

Carried over from the design (none newly introduced):

- **Helper location:** colocated in `create-control-server.ts` (design left this
  to implementation; chosen for readability — the file owns both call sites).
- **Length leak acceptable:** the length pre-check leaks only the configured
  token's length, consistent with `verify-signature.ts`. Not hashing to a fixed
  length.
- **Fail-closed on unset token is desired:** an unconfigured CRUD token denies
  all mutating requests. This is treated as an in-scope correctness fix because
  it lives in the exact lines being rewritten and is required for the helper to
  be correct.
- **Array/duplicated header → deny:** a repeated `X-Control-Crud-Token`
  (presented by Node as `string[]`) returns `false`; a legitimate client sends
  exactly one value.
- **No happy-path behavior change:** the only externally observable change is
  that previously-fail-open unconfigured-token requests to
  `/api/agents/:id/run`, `/api/settings/self-heal` (PUT), and `/api/tiers` (PUT)
  now correctly return 401.
- **Both helper names retained:** although `authorizeProjectCrud` and
  `authorizeControlToken` become identical after delegating to the helper, both
  names are kept so call sites stay self-documenting; this is a naming choice,
  not a behavioral one.
