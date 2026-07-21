# Plan — issue-agentic-ops-engine-140

Fix the pooled-client leak in `PostgresTierStore.replaceAll` by releasing the
checked-out client in a `finally`, and make the `release` contract explicit on
the injected client shape. Approach A from the design.

Scope: two files in `packages/activities`. No contract, workflow, policy, or
vision changes.

## Steps

### Step 1 — Add the failing regression assertions to the test file

**File:** `packages/activities/src/postgres-tier-store.test.ts`

- In `fakePool()`: add a `release` spy on the returned *client* — a counter
  (e.g. `let releaseCount = 0`) with a `release() { releaseCount += 1 }` method,
  and expose it so the test can read it (return `releaseCount` via a getter, or
  attach `releaseCount` state the test can assert on — simplest is to expose a
  `client` handle or a `releases()` accessor from `fakePool()`).
- Extend the commit-path test (`replaceAll wraps DELETE+INSERTs in
  BEGIN/COMMIT …`) to assert the client's `release` was called exactly once.
- In the inline ROLLBACK-path test (`replaceAll issues ROLLBACK and rethrows
  when an INSERT fails mid-transaction`): add a `release` spy to the inline
  `client` and assert it is called exactly once after the rejection.
- Leave the `fakeDb()` (no-`connect()`) tests untouched — that path never checks
  out a client, so it must not gain a `release` expectation.

**Verify:** `pnpm --filter @agentops/activities test` (or repo-root `pnpm test`).
The two new assertions **fail** here (source not yet fixed), confirming the test
is a real regression guard for the leak. This is the de-risking step — it proves
the test catches the bug before the fix exists.

### Step 2 — Fix the leak in the store

**File:** `packages/activities/src/postgres-tier-store.ts`

- Widen the client shape returned by `connect()` so `release` is visible and
  type-checked. Change `PoolLike.connect` to return `Queryable & { release?(): void }`
  (inline) or introduce a small `interface ClientLike extends Queryable { release?(): void }`
  in the same file and use it as the `connect()` return type. No `any`.
- In `replaceAll`, wrap the existing `try { BEGIN … COMMIT } catch { ROLLBACK; throw }`
  with a `finally { client.release?.(); }` so the client is returned to the pool
  exactly once on: the COMMIT success path, the insert-failure/ROLLBACK path, and
  any unexpected throw. Do **not** `await` the release (pg's `release` is
  synchronous). Do not release inside both `catch` and after `COMMIT` — a single
  `finally` avoids pg's "client already released" double-release warning.
- Do not change transactional semantics: inserts stay awaited in position order,
  ROLLBACK-then-rethrow is unchanged, no retry, no change to the no-`connect()`
  fallback branch.

**Verify:** `pnpm --filter @agentops/activities test` — the Step 1 assertions now
**pass**; all pre-existing `PostgresTierStore` tests (BEGIN/COMMIT ordering,
ROLLBACK + rethrow, no-retry, no-`connect()` path) stay green.

### Step 3 — Full gate + self-check

**Files:** none (verification only).

- Run `pnpm lint && pnpm typecheck && pnpm test` at repo root. Typecheck
  specifically exercises the widened `connect()` return type against both the
  real `pg.Pool` injection sites (worker + control) and the test fakes.
- Confirm the real `pg.PoolClient` still satisfies the injected shape (it
  provides a synchronous `release()`), so no worker/control call site needs a
  change.

**Verify:** all three commands green. e2e (`pnpm e2e`) is not required — observable
tier-replacement behavior is unchanged, only resource cleanup is fixed — but run
it if the harness gates activities changes on it.

## Sequencing notes

- **Test before fix (Step 1 before Step 2).** Writing the assertions first proves
  they fail without the fix, which is the whole value of a leak regression test —
  a release spy added *after* the fix could pass vacuously. This ordering also
  de-risks the rest: it locks in exactly what "released once" means before I
  touch the source.
- **Type widening and the `finally` land together (Step 2).** They could be split,
  but the `finally { client.release?.() }` call only typechecks once `release` is
  on the `connect()` return type, so separating them would leave an intermediate
  non-compiling state. Kept as one coherent step.
- **Step 3 is deliberately last** — the full lint/typecheck/test gate only means
  something once both the test and the fix are in place.

## Assumptions

- **Release spy exposure in `fakePool()`.** The design says "add a `release`
  spy"; it doesn't prescribe how the test reads the count. Assumption: expose the
  count via a small accessor/handle on the object `fakePool()` returns (mirroring
  how it already exposes `calls`), rather than reaching into pg internals.
- **`release` is optional (`release?()`).** Following the design: optional keeps
  the minimal-injectable-shape convention and avoids forcing every fake to
  implement it; called as `client.release?.()`. The real pg pool always provides
  `release`, so the leak is closed in production; only controlled test fakes may
  omit it.
- **Call `release` synchronously, no argument, once in `finally`.** Matches
  `pg.PoolClient.release()`'s `void` signature and avoids the double-release
  warning. Not awaited.
- **Scope is `replaceAll` only.** The sibling methods (`ensureSchema`, `loadAll`,
  `seedIfEmpty`) use `this.db.query` directly and never call `connect()`, so they
  hold no client and have no leak. Per the design, they are left untouched.
