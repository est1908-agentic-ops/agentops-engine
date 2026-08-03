# Design — Task issue-agentic-ops-engine-148

**Goal:** [bughunt] TOCTOU race in filed-finding dedup lets whitebox-bughunt file duplicate GitHub issues

## Problem

`createIssue` in `packages/activities/src/create-activities.ts` (lines 304–339) dedups
findings with a non-atomic check-then-act sequence:

1. `filedFindings.find(project, fingerprint)` — **check** (Time Of Check)
2. `tracker.createIssue(...)` — external, side-effecting GitHub call
3. `filedFindings.record({...})` — **write** (Time Of Use)

Because steps 1 and 3 are separated by an `await` on a slow external call, two
executions racing on the same `(project, fingerprint)` both observe "not filed" at
step 1 and both proceed to step 2 — filing **two GitHub issues** for one finding.

Two concrete race vectors exist today:

- **Cross-run concurrency.** `findingFingerprint` is deterministic, so two overlapping
  `whiteboxBugHunt` runs for the same project (e.g. a scheduled run overlapping a manual
  one, or two schedules) that surface the same bug both pass the `find()` gate. These run
  as separate Temporal activity executions, possibly on different workers, so nothing in
  the process serializes them.
- **Activity retry after a partial write.** `createIssue` is proxied with
  `retry.maximumAttempts: 5`. If step 2 succeeds but the worker dies before step 3
  records the row, Temporal retries the activity; `find()` again returns null and a
  **second** issue is filed.

Note the race is not purely a Postgres concern: because Temporal runs activities
concurrently within one worker process, even `InMemoryFiledFindingStore` races — the
`await` on `tracker.createIssue` yields the event loop between another activity's
`find()` and `record()`. Any fix must close the window at the store-interface level, not
only in the Postgres backend.

## Candidate approaches

### Approach 1 — Serialize the whole section with a Postgres lock

Wrap `find` + `tracker.createIssue` + `record` in one transaction and take
`pg_advisory_xact_lock(hashtext(project || fingerprint))` (or `SELECT … FOR UPDATE` on a
reservation row) at the top. Concurrent activities on the same fingerprint block until
the first commits, then observe the recorded row and dedup.

- **Pro:** conceptually simple; the critical section is literally mutually exclusive.
- **Con:** holds an open DB transaction across an external GitHub API call (seconds, and
  it can hang/retry) — an anti-pattern that ties a DB connection up on network I/O and
  risks lock/connection-pool exhaustion. Postgres-specific: the advisory lock has no
  analogue in `InMemoryFiledFindingStore`, so the in-memory/e2e path stays racy unless a
  second mechanism is added. **Rejected.**

### Approach 2 — Reserve-before-create via the unique constraint (recommended)

Make the `PRIMARY KEY (project, fingerprint)` the atomic gate and reorder to
**reserve → create → finalize**:

1. **Reserve:** atomically insert a *pending* row (`issue_ref = ''` sentinel).
   `INSERT … ON CONFLICT (project, fingerprint) DO NOTHING` tells us, via row count,
   whether *this* caller won the reservation.
2. If we won → call `tracker.createIssue`, then **finalize** the row with the real
   `issue_ref`.
3. If we lost → a row already exists; return `deduped: true` with its `issue_ref`.

Concurrent callers now contend on the DB unique constraint (a single atomic op), not on
a check separated from a write, so exactly one caller ever reaches
`tracker.createIssue`. The in-memory store implements the same `reserve` as one
synchronous get-and-set with no `await` between them, which is atomic under the JS event
loop — closing the in-memory race too.

Two recovery paths keep the reservation from becoming a permanent "poison" that silently
drops a finding:

- **Fast path — release on failure.** If `tracker.createIssue` throws (transient GitHub
  error), the activity deletes its just-created pending reservation before rethrowing, so
  Temporal's retry re-reserves cleanly.
- **Safety net — self-healing stale reclaim.** If the worker hard-crashes between reserve
  and create (no chance to release), the pending row lingers. `reserve` treats a pending
  row (`issue_ref = ''`) whose `last_seen` is older than a staleness threshold as
  abandoned and reclaims it. The threshold is set comfortably above the activity's
  10-minute `startToCloseTimeout`, so a genuinely in-flight reservation is never stolen,
  while an abandoned one is eventually retryable.

The only remaining imperfect window — crash *after* a successful GitHub create but
*before* finalize — leaves an orphaned pending row pointing at a real issue. This
produces **no duplicate and no dropped finding** (future identical fingerprints dedup
against it; the issue does exist on GitHub); the sole cost is that we don't record the
issue ref. This is strictly better than today's behavior and an acceptable residual.

- **Pro:** closes both race vectors and the retry-dup at the store-interface level;
  covers Postgres and in-memory uniformly; no long-held transaction across the external
  call; no contract change (owner identity stays internal).
- **Con:** two-phase (adds a pending state and a nullable-ish `''` sentinel); needs a
  small additive schema migration (`last_seen` already exists; no new column required).

### Approach 3 — Push idempotency to the tracker / GitHub

Dedup at the GitHub layer: embed the fingerprint in the issue body/label and
`search`-before-create, or rely on a create idempotency key.

- **Con:** GitHub's REST API has no idempotency key for issue creation, and
  search-before-create is itself a TOCTOU (plus rate-limited and eventually consistent).
  It also leaves the in-memory/stub path unprotected and pushes tracker-specific dedup
  into `packages/ports`, violating the "dedup is engine policy" separation. **Rejected.**

## Recommendation

**Approach 2.** It is the only option that closes every identified race vector
(cross-run, activity-retry, and in-process/in-memory) at the right layer — the
`FiledFindingStore` — without holding a database transaction open across a slow external
call and without a tracker-specific dependency. A considered refinement of Approach 2 —
carrying an explicit per-run **owner token** (the `taskId`) to distinguish a caller's own
retry from a competitor — was rejected in favor of the **staleness reclaim**: it achieves
the same self-healing without threading a new field through the `CreateIssueInput`
contract (`packages/contracts`), keeping the change smaller and the published activity
surface unchanged.

## What will change and why

- **`packages/activities/src/filed-finding-store.ts`** — Extend the `FiledFindingStore`
  interface with an atomic reservation surface:
  - `reserve(project, fingerprint): Promise<{ won: boolean; issueRef: string }>` —
    atomically claim the fingerprint; `won: true` means this caller must create+finalize,
    `won: false` returns the existing `issueRef` for dedup. Encapsulates stale-pending
    reclaim.
  - `finalize(project, fingerprint, issueRef): Promise<void>` — set the real ref on a
    reservation we won (only when still pending).
  - `release(project, fingerprint): Promise<void>` — delete our pending reservation when
    the tracker call fails.
  - Update `InMemoryFiledFindingStore` to implement these as synchronous, race-free
    get-and-set operations. Keep `find`/`record` only if still needed elsewhere; otherwise
    retire them.
- **`packages/activities/src/postgres-filed-finding-store.ts`** — Implement `reserve`
  (INSERT … ON CONFLICT DO NOTHING with a stale-pending reclaim UPDATE gated on
  `last_seen < now() - <threshold>`), `finalize` (UPDATE issue_ref WHERE row is still
  pending), and `release` (DELETE the pending row). `ensureSchema` already creates the
  table with `last_seen`; confirm no new column is needed (it is not). Keep `issue_ref`
  NOT NULL by using `''` as the pending sentinel to avoid a nullability migration.
- **`packages/activities/src/create-activities.ts`** — Rewrite the `createIssue` dedup
  block (lines 314–337) to the reserve → create → finalize / release-on-error flow. The
  external `assertProjectOwnsRepo` check and the non-dedup (no `dedupeFingerprint`) path
  are unchanged.
- **`packages/workflows/src/whitebox-bughunt.ts`** — **No change.** It calls `createIssue`
  and reads `{ filed, deduped }`; the return shape is preserved.
- **Contracts** — **No change** to `CreateIssueInput` / `CreateIssueResult` in
  `packages/contracts/src/tracker-types.ts`; owner identity and reservation state stay
  internal to the activity/store.
- **Tests** —
  - `packages/activities/src/create-activities.test.ts`: keep the existing sequential
    dedup test; add a **concurrency** test that fires two `createIssue` calls with the
    same fingerprint interleaved (via a tracker whose `createIssue` awaits a released
    barrier) and asserts exactly one GitHub issue is created, one result has
    `deduped: false` and the other `deduped: true` with the same `ref`. Add a
    release-on-tracker-error test asserting a subsequent retry succeeds (no poison).
  - `packages/activities/src/create-activities.test.ts` / a store test: cover the
    stale-pending reclaim path.
  - `e2e/whitebox-bughunt.e2e.test.ts`: sanity that filing/dedup counts are unchanged for
    the happy path.

## Assumptions

- **Staleness threshold value.** No existing config knob for this. **Assumption:** use a
  fixed threshold (e.g. 15 minutes) that safely exceeds the `createIssue` activity's
  10-minute `startToCloseTimeout`, so an in-flight reservation is never reclaimed while an
  abandoned one becomes retryable. It lives in the Postgres store (I/O side; `now()` is
  permitted there, unlike `packages/workflows`).
- **Owner token vs. staleness reclaim.** The issue does not mandate a mechanism.
  **Assumption:** self-healing via staleness reclaim is preferable to an explicit owner
  token because it needs no contract change; the residual "reclaim a still-legitimate
  reservation" risk is eliminated by choosing the threshold above the activity timeout.
- **Pending-created-then-crash residual.** **Assumption:** an orphaned pending row that
  points at an already-created GitHub issue (crash between create and finalize) is
  acceptable — it yields no duplicate and no dropped finding, only an unrecorded ref, and
  is strictly better than the current duplicate-filing behavior. Not worth added
  complexity to close.
- **Sentinel vs. nullable `issue_ref`.** The table declares `issue_ref TEXT NOT NULL`.
  **Assumption:** use `''` as the pending sentinel to avoid a column-nullability
  migration on the existing table (which `CREATE TABLE IF NOT EXISTS` would not apply
  anyway).
- **`find`/`record` retirement.** **Assumption:** these were used only by the racy
  `createIssue` path; they will be replaced by `reserve`/`finalize`/`release`. If a
  grep finds other callers, keep them; the design does not otherwise depend on removing
  them.

## Self-review

- No placeholders; every named file and method corresponds to code inspected in this
  workspace.
- No contradictions: the workflow and contract shapes are explicitly unchanged; all
  behavior changes are confined to the store interface, its two implementations, and the
  `createIssue` activity body.
- Scope: this is **one coherent change** — making filed-finding dedup atomic. The store
  interface extension, its two implementations, the activity rewrite, and the tests are
  all in service of that single fix.

## Brainstorm Summary
**Approaches considered:** (1) serialize the whole check-create-record under a Postgres advisory lock / `FOR UPDATE`; (2) reserve-before-create using the `(project, fingerprint)` unique constraint as an atomic gate; (3) push dedup to GitHub via search-before-create / idempotency key.
**Chosen approach:** (2) reserve-before-create, with release-on-error plus self-healing stale-reservation reclaim.
**Why (decisive reasons):** Only option that closes all three race vectors (cross-run, activity-retry, in-process/in-memory) at the `FiledFindingStore` layer, uniformly for Postgres and in-memory, without holding a DB transaction open across the slow GitHub call and without a tracker-specific dependency. Needs no contract change.
**Key risks/assumptions:** Uses a fixed staleness threshold (~15 min) above the activity's 10-min timeout to reclaim abandoned reservations; a `''` sentinel avoids a nullability migration; a crash between GitHub-create and finalize can orphan one ref (no duplicate, no dropped finding) — an accepted residual.
