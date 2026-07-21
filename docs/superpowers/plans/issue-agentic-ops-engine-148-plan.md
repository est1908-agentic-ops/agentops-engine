# Plan — Task issue-agentic-ops-engine-148

**Goal:** [bughunt] TOCTOU race in filed-finding dedup lets whitebox-bughunt file duplicate GitHub issues

Design: `docs/superpowers/specs/issue-agentic-ops-engine-148-design.md` (Approach 2 — reserve → create → finalize, with release-on-error and self-healing stale-reservation reclaim).

This plan turns that design into an ordered, individually-verifiable set of steps. No implementation code is written here.

## Files that change (in edit order)

1. `packages/activities/src/filed-finding-store.ts` — extend interface + in-memory impl.
2. `packages/activities/src/postgres-filed-finding-store.ts` — implement the same surface against Postgres.
3. `packages/activities/src/create-activities.ts` — rewrite the `createIssue` dedup block to reserve → create → finalize / release.
4. `packages/activities/src/create-activities.test.ts` — add concurrency + release-on-error tests; keep the sequential dedup test.
5. `packages/activities/src/postgres-filed-finding-store.test.ts` (new) — unit-test `reserve`/`finalize`/`release` SQL and the stale-reclaim gate against a fake `Queryable`.
6. `packages/activities/src/filed-finding-store.test.ts` (new, if not folded into an existing file) — unit-test the in-memory store's atomic `reserve` semantics.

No change to `packages/workflows/src/whitebox-bughunt.ts`, `packages/contracts/src/tracker-types.ts`, or `e2e/whitebox-bughunt.e2e.test.ts` behavior (the last is only re-run as a regression check).

---

## Steps

### Step 1 — Extend the `FiledFindingStore` interface and the in-memory implementation

**File:** `packages/activities/src/filed-finding-store.ts`

- Add three methods to the `FiledFindingStore` interface:
  - `reserve(project, fingerprint): Promise<{ won: boolean; issueRef: string }>` — atomically claim `(project, fingerprint)`. `won: true` ⇒ this caller must `createIssue` + `finalize`; `won: false` ⇒ a row already exists, return its `issueRef` for dedup.
  - `finalize(project, fingerprint, issueRef): Promise<void>` — set the real ref on a reservation we won (only while still pending, i.e. `issueRef === ''`).
  - `release(project, fingerprint): Promise<void>` — delete our pending reservation (only while still pending) when the tracker call fails.
- Implement them in `InMemoryFiledFindingStore` as **synchronous get-and-set** with no `await` between the get and the set, so they are atomic under the JS event loop:
  - `reserve`: `get` the key. If absent → `set` a pending record (`issueRef: ''`), return `{ won: true, issueRef: '' }`. If present and pending (`issueRef === ''`) → treat as in-flight peer, return `{ won: false, issueRef: '' }` (no wall-clock staleness in the in-memory store — see Assumptions). If present and finalized → return `{ won: false, issueRef: existing.issueRef }`.
  - `finalize`: overwrite the record's `issueRef` only if the current stored record is pending.
  - `release`: delete the key only if the current stored record is pending.
- Decide on `find`/`record`: grep confirms their **only** callers are the `createIssue` dedup block (rewritten in Step 3) and the existing sequential dedup test (kept, but retargeted). Retire `find`/`record` from the interface and both implementations to avoid a second, still-racy write path. (If a later grep surfaces an unexpected caller, keep them — the design does not depend on removal.)

**Verification:**
- `pnpm --filter @agentops/activities typecheck` compiles (interface + in-memory impl consistent).
- New in-memory unit test (Step 6) asserts: first `reserve` returns `{ won: true, issueRef: '' }`; a second `reserve` before `finalize` returns `{ won: false, issueRef: '' }`; after `finalize('X')`, `reserve` returns `{ won: false, issueRef: 'X' }`; `release` on a pending key lets the next `reserve` win again.

### Step 2 — Implement `reserve`/`finalize`/`release` in the Postgres store

**File:** `packages/activities/src/postgres-filed-finding-store.ts`

- Keep `ensureSchema` / `CREATE TABLE` as-is: the table already has `PRIMARY KEY (project, fingerprint)`, `issue_ref TEXT NOT NULL`, and `last_seen`. No new column, no migration.
- Add a module-level `STALE_RESERVATION` interval constant (15 minutes — see Assumptions) used in the reclaim predicate.
- `reserve` — a single atomic INSERT with a conflict-reclaim, then a fallback SELECT only on the lost path. Because `Queryable.query` returns **only `{ rows }`** (no `rowCount`), detect the winner via `RETURNING`:

  ```sql
  INSERT INTO filed_findings (project, fingerprint, issue_ref, last_seen)
  VALUES ($1, $2, '', now())
  ON CONFLICT (project, fingerprint) DO UPDATE SET last_seen = now()
    WHERE filed_findings.issue_ref = ''
      AND filed_findings.last_seen < now() - ($3)::interval
  RETURNING issue_ref
  ```

  - Returned a row ⇒ we **won** (fresh insert, or reclaimed a stale pending row) ⇒ `{ won: true, issueRef: '' }`.
  - Returned no rows ⇒ conflict with a row we may not reclaim (a finalized row, or a still-fresh pending peer) ⇒ we **lost**. Run `SELECT issue_ref …` and return `{ won: false, issueRef: row.issue_ref }` (may be `''` when the winner is an in-flight peer — acceptable; see Assumptions).
  - Pass the interval as a parameter (`$3 = '15 minutes'`) cast with `::interval` so the constant is not string-interpolated into SQL.
- `finalize` — `UPDATE filed_findings SET issue_ref = $3, last_seen = now() WHERE project = $1 AND fingerprint = $2 AND issue_ref = ''` (guards against clobbering a row a reclaimer already took over).
- `release` — `DELETE FROM filed_findings WHERE project = $1 AND fingerprint = $2 AND issue_ref = ''` (only deletes a still-pending row; a finalized row is never dropped).
- Remove `find`/`record` and their SQL (`SELECT_SQL`, `INSERT_SQL`) per Step 1's retirement decision.

**Verification:**
- `pnpm --filter @agentops/activities typecheck`.
- New Postgres unit test (Step 5) drives a fake `Queryable` (pattern from `postgres-stats-store.test.ts`) and asserts, by inspecting captured `sql`/`params`:
  - `reserve` issues the `INSERT … ON CONFLICT … RETURNING` with the interval param; returns `won: true` when the fake returns a RETURNING row, `won: false` + the SELECTed `issue_ref` when RETURNING is empty.
  - the reclaim predicate contains `issue_ref = ''` and `last_seen < now() - ($3)::interval`.
  - `finalize` and `release` are guarded with `issue_ref = ''`.

### Step 3 — Rewrite the `createIssue` dedup block

**File:** `packages/activities/src/create-activities.ts` (the `createIssue` method, current lines 314–337)

Replace the `find` → create → `record` sequence with:

```
if (req.dedupeFingerprint && filedFindings) {
  const { won, issueRef } = await filedFindings.reserve(req.project, req.dedupeFingerprint);
  if (!won) return { ref: issueRef, url: '', deduped: true };
  let created;
  try {
    created = await deps.tracker.createIssue({ repo, title, body, labels });
  } catch (err) {
    await filedFindings.release(req.project, req.dedupeFingerprint); // no poison; Temporal retry re-reserves
    throw err;
  }
  await filedFindings.finalize(req.project, req.dedupeFingerprint, created.ref);
  return { ref: created.ref, url: created.url, deduped: false };
}
// non-dedup path (no dedupeFingerprint / no store) unchanged:
const created = await deps.tracker.createIssue({ repo, title, body, labels });
return { ref: created.ref, url: created.url, deduped: false };
```

- `assertProjectOwnsRepo(req.repo, deps.registry)` stays first, unchanged.
- Return shape `{ ref, url, deduped }` is preserved exactly, so `whitebox-bughunt.ts` and the contract are untouched.

**Verification:**
- `pnpm --filter @agentops/activities typecheck`.
- Existing sequential dedup test (`createIssue dedups by fingerprint within a project`) still passes unchanged — proves the lost-caller path returns `{ ref, url: '', deduped: true }`.

### Step 4 — Add concurrency and release-on-error activity tests

**File:** `packages/activities/src/create-activities.test.ts`

- **Concurrency test:** define a tracker whose `createIssue` awaits a manually-controlled barrier (a promise resolved by the test) before returning, wrapping/extending `MemoryTrackerPort` so it still records the created issue and exposes a call count. Fire two `activities.createIssue(...)` calls with the **same** `dedupeFingerprint` without awaiting, then release the barrier. Assert:
  - the tracker's `createIssue` was called **exactly once**;
  - exactly one result has `deduped: false` and the other `deduped: true`, both with the same `ref`.
  - This is the direct regression for the TOCTOU vector — under the old code both callers passed `find()` and the tracker was called twice.
- **Release-on-error test:** a tracker whose `createIssue` throws on first call, succeeds on second (simulating Temporal's activity retry). Call `createIssue` once (expect it to reject), then call again with the same fingerprint; assert the second call **succeeds** with `deduped: false` (the failed reservation was released, not poisoned).

**Verification:**
- `pnpm --filter @agentops/activities test` — both new tests green plus the kept sequential test.

### Step 5 — Postgres store unit test (new)

**File:** `packages/activities/src/postgres-filed-finding-store.test.ts` (new)

- Reuse the `FakeDb implements Queryable` pattern from `postgres-stats-store.test.ts` (records `{ sql, params }`, seedable `rows`).
- Cover: `ensureSchema` emits the `CREATE TABLE IF NOT EXISTS filed_findings`; `reserve` win path (RETURNING row seeded) → `{ won: true }`; `reserve` lost path (RETURNING empty, SELECT seeded with a finalized `issue_ref`) → `{ won: false, issueRef }`; stale-reclaim predicate present in the SQL; `finalize`/`release` guarded by `issue_ref = ''`.

**Verification:** `pnpm --filter @agentops/activities test`.

### Step 6 — In-memory store unit test (new)

**File:** `packages/activities/src/filed-finding-store.test.ts` (new)

- Assert the atomic `reserve`/`finalize`/`release` state machine described in Step 1 (win → pending-peer-loses → finalize → finalized-loser-gets-ref → release-frees).

**Verification:** `pnpm --filter @agentops/activities test`.

### Step 7 — Full green gate + e2e regression

- Run the repo definition-of-done gate: `pnpm lint && pnpm typecheck && pnpm test`.
- Because the change touches `activities`, run the e2e suite, focusing on the bughunt path: `pnpm e2e` (or at minimum `e2e/whitebox-bughunt.e2e.test.ts`). Assert filed/deduped counts on the happy path are unchanged — the fix must be behavior-neutral when there is no race.

**Verification:** all of `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm e2e` green.

---

## Sequencing notes

- **Interface + in-memory first (Step 1), Postgres second (Step 2), consumer third (Step 3).** The consumer (`createIssue`) can't compile against methods that don't exist, so the store surface must land first. In-memory before Postgres because it's the simplest correct reference implementation and the one the activity tests exercise — it de-risks the semantics before the SQL details.
- **`find`/`record` retirement is decided in Step 1 but justified by the grep already run:** their only callers are the rewritten `createIssue` block and the one sequential test. Retiring them in the same steps that add the replacements avoids leaving a second, still-racy write path reachable. Reversible: if an unexpected caller appears at typecheck time, keep the methods — nothing else in the plan depends on their removal.
- **Tests after the code they cover, but the *existing* sequential dedup test is a gate on Step 3**, not a new step — it must keep passing through the rewrite, catching an accidental change to the lost-caller return shape immediately.
- **e2e last (Step 7).** It's the slowest and only meaningful once units are green; running it earlier would just be slow noise.
- Could Step 5/6 (store unit tests) run before Step 3? Yes — they don't depend on the activity rewrite. I kept them after Step 3/4 only for narrative flow; they may be authored in parallel with Step 1–2 without changing correctness.

## Assumptions

- **Staleness threshold = 15 minutes.** No existing config knob. Chosen to sit comfortably above the `createIssue` activity's 10-minute `startToCloseTimeout`, so a genuinely in-flight reservation is never reclaimed, while an abandoned pending row (worker hard-crash between reserve and create) becomes retryable. Lives as a constant in the Postgres store (I/O side, where `now()` is allowed — not in `packages/workflows`).
- **Staleness reclaim over an owner token.** The design rejected threading a per-run owner (`taskId`) through `CreateIssueInput` in favor of the timeout-based reclaim, which needs **no contract change**. Adopted.
- **`''` sentinel for pending, not a nullable `issue_ref`.** The table declares `issue_ref TEXT NOT NULL`, and `CREATE TABLE IF NOT EXISTS` would not apply a nullability change to an existing table anyway. Pending rows use `''`; `finalize` replaces it with the real ref.
- **Win detection via `RETURNING`, not `rowCount`.** The injected `Queryable` interface returns only `{ rows }`. The `reserve` INSERT uses `RETURNING issue_ref` so a returned row means "won" (fresh insert or stale reclaim) and an empty result means "lost" — then a fallback SELECT fetches the existing ref. This keeps the `Queryable` contract unchanged.
- **In-memory store has no wall-clock staleness reclaim.** `InMemoryFiledFindingStore` is process-local; a "stale pending" state only arises from a crash, which also wipes the in-memory map. So the in-memory `reserve` treats any existing pending row as an in-flight peer (`won: false, issueRef: ''`) with no time-based reclaim. This keeps it free of `Date.now()` and matches its single-process lifetime.
- **Lost-to-in-flight-peer returns `deduped: true` with a possibly-empty `ref`.** If a caller loses to a peer that has reserved but not yet finalized, the returned `issueRef` may be `''`. `whitebox-bughunt` only counts `deduped`, so this is harmless there; it is the design's accepted residual (no duplicate issue, no dropped finding) and strictly better than today's duplicate-filing.
- **`find`/`record` are removed.** Grep confirms no callers outside the rewritten path and its test. If that proves wrong at typecheck, they are kept — the fix does not require their deletion.
