# Design — issue-agentic-ops-engine-140

## Goal

`PostgresTierStore.replaceAll` checks out a pooled Postgres client via
`this.db.connect()` to run its `BEGIN … COMMIT` transaction, but never returns
that client to the pool. Every live tier edit from Mission Control (`POST
/api/tiers` → `replaceAll`) permanently consumes one connection from the pg
`Pool`. After enough edits the pool's connection cap is reached and all
subsequent DB work — tier reads, stats writes, refreshes — blocks or times out.
This change makes `replaceAll` release its client on every path.

## Root cause

`packages/activities/src/postgres-tier-store.ts:101-110`:

```ts
const client = await this.db.connect();
try {
  await client.query('BEGIN');
  await client.query('DELETE FROM tiers');
  for (const ins of inserts) await client.query(ins.sql, ins.params);
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  throw err;
}
```

A `pg.PoolClient` returned by `Pool.connect()` must be handed back with
`client.release()`; until then the pool treats it as in-use. There is no
`finally`, so the client leaks on both the success and the error path. The
`PoolLike`/`Queryable` injected shape only declares `query`/`connect`, so
`release()` isn't even visible to the code — the type hides the omission.

## Candidate approaches

### A. Add a `finally { client.release() }` and surface `release` on the injected client type (recommended)

Extend the client shape returned by `connect()` to include an optional
`release()` method, then wrap the existing transaction body so the client is
released exactly once regardless of success, thrown insert, or thrown
`ROLLBACK`. A real `pg.PoolClient` satisfies this as-is; test fakes add a
`release` spy.

- **Pros:** Smallest possible change; fixes both leak paths; keeps the
  minimal-injectable-shape convention the other Postgres stores use; directly
  testable with the existing fake-pool pattern.
- **Cons:** Touches the injected type definition (small ripple into the test
  fakes, which is desirable for coverage).

### B. Introduce a shared `withClient(pool, fn)` transaction helper

Factor client acquire/transaction/release into a reusable helper (e.g. in a new
`pg-tx.ts`) and have `replaceAll` call it.

- **Pros:** Central place for correct client lifecycle if more transactional
  call sites appear later.
- **Cons:** `replaceAll` is currently the *only* transactional call site in the
  activities package; introducing an abstraction for one caller is premature and
  adds surface area to review. Rejected — YAGNI; can be extracted later if a
  second caller emerges.

### C. Replace the injected `PoolLike` with the real `pg` `Pool.query` transaction sugar / a query-builder

Drop the hand-rolled `BEGIN/COMMIT` and lean on a library-level transaction API.

- **Pros:** Less bespoke transaction code.
- **Cons:** The store deliberately depends only on a tiny injectable
  `Queryable`/`PoolLike` interface (mirrors `PostgresStatsStore`,
  `K8sJobRunner.BatchV1ApiLike`) so tests need no real Postgres. Pulling in a
  concrete pg/query-builder API would break that testability contract and is far
  out of scope for a connection-leak fix. Rejected.

## Recommended approach: A

It fixes the defect with the least risk, preserves the store's
dependency-injection contract, and is fully exercisable by the existing test
harness. B and C both expand scope beyond the one-line lifecycle bug.

## What changes and why

- **`packages/activities/src/postgres-tier-store.ts`**
  - Define the client shape returned by `connect()` as `Queryable` plus an
    optional `release?(): void` (either inline on `PoolLike.connect`'s return
    type or via a small `ClientLike` interface in the same file). This makes the
    release contract explicit and type-checked, satisfying the "no hidden shape"
    intent without introducing `any`.
  - In `replaceAll`, add a `finally` block that calls `client.release?.()` so the
    pooled client is returned exactly once on the COMMIT path, the
    insert-failure/ROLLBACK path, and any unexpected throw. The transactional
    semantics (awaited inserts, ROLLBACK-then-rethrow, no retry) are unchanged —
    only the lifecycle is fixed.

- **`packages/activities/src/postgres-tier-store.test.ts`**
  - Add a `release` spy to `fakePool()` (and the inline ROLLBACK-path fake pool)
    and assert it is called exactly once on both the commit path and the
    insert-failure path. This is the regression guard: without the fix these
    assertions fail. The `fakeDb()` (no-`connect()`) path is unaffected — it
    never checks out a client, so it needs no `release`.

No contract (`packages/contracts`) change is needed: `release` lives on the
infrastructure `PoolLike` shape, not on any cross-package data schema. No
workflow/policy/vision change — this is a pure activities-layer bug fix that
preserves observable behavior except for the eliminated leak.

## Testing / Definition of done

- New unit assertions prove the client is released once per `replaceAll`
  invocation on the commit and error paths.
- `pnpm lint && pnpm typecheck && pnpm test` green. e2e is not required —
  behavior of tier replacement is unchanged; only resource cleanup is fixed —
  but will be run if the harness gates on it.

## Assumptions

- **Release signature.** A real `pg.PoolClient.release()` is synchronous
  (returns `void`, optionally taking a destroy flag/error). Assumption: call it
  as `client.release?.()` with no argument in `finally`; do not `await` it.
- **Optional vs required `release`.** Making `release` optional (`release?()`)
  keeps the injected-shape convention flexible and avoids forcing every fake to
  implement it. Assumption: optional-with-`?.()` is safe because the real pool
  always provides it, and the only client that omits it in practice is a test
  fake we control. The no-`connect()` (`fakeDb`) path never reaches the release
  call at all.
- **Double-release safety.** Releasing once in `finally` (rather than after
  COMMIT and again in `catch`) avoids pg's "client already released" warning.
  Assumption: a single `finally` release is the correct idiom.
- **Scope.** The issue names only `replaceAll`. I inspected the other methods
  (`ensureSchema`, `loadAll`, `seedIfEmpty`) — they use `this.db.query` directly
  and never call `connect()`, so they hold no client and have no leak.
  Assumption: this fix is scoped to `replaceAll` only.

## Self-review

- No placeholders or TODOs.
- No contradictions: every section agrees the fix is a `finally`-release plus a
  typed `release?()` on the injected client, scoped to `replaceAll`.
- Single coherent change: one connection-leak fix in one file plus its
  regression test. Confirmed in scope.

## Brainstorm Summary
**Approaches considered:** (A) add a `finally { client.release?.() }` and surface `release` on the injected client type; (B) extract a shared `withClient`/transaction helper; (C) swap the minimal injectable `PoolLike` for a real pg/query-builder transaction API.
**Chosen approach:** A — release the pooled client in a `finally`, with `release?()` added to the client shape returned by `connect()`.
**Why (decisive reasons):** Smallest fix that closes both the commit and error leak paths, preserves the store's dependency-injection/testability contract, and is fully exercisable by the existing fake-pool tests. B is premature abstraction for the only transactional caller; C breaks the no-real-Postgres test contract.
**Key risks/assumptions:** `release` is treated as optional and called synchronously once in `finally` (a real `pg.PoolClient` always provides it); the sibling methods take no client so are untouched; scope is `replaceAll` only.
