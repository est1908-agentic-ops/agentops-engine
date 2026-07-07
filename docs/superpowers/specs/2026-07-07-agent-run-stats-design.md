# `agent_run_stats` Postgres Projection — Design

Status: draft · 2026-07-07 · Owner: Artem
Milestone: M4, sub-project 3 of 5 (see [decomposition](2026-07-06-m4-decomposition.md))

## Context

Every `runAgent` call's token/cost/model/outcome data goes into `InMemoryStatsStore` (`packages/activities/src/stats-store.ts`) — a plain in-process `Map`. It vanishes on worker restart and nothing outside the worker process can read it. That blocks two things M4 promises directly: "cost of last PR is a Grafana panel" (Grafana can't query a running Node process's memory) and Mission Control's run-detail view (a separate BFF process, sub-project 5). This doc makes it a real, persistent, externally-queryable projection.

**Follow-up scope added mid-implementation:** the user asked to also monitor this data's size growth, not just persist it. Folded in below as a small addition to the cross-repo (`agentops-platform`) half of this work, since it's a natural extension of the observability stack sub-project 1 already stood up, not a separate sub-project.

## Goal

`RunStats` rows persist in a dedicated Postgres database, survive worker restarts, and are queryable outside the worker process. The database and table's size/growth are visible in Prometheus (and therefore Grafana) without any new dashboard work — that's sub-project 4.

## Non-goals

- `heal_cases`, `repo_memory`, eval scores — the other three projections ARCHITECTURE.md §5.9 names. Decomposition doc scopes this sub-project to `agent_run_stats` only.
- A migration framework (Flyway, node-pg-migrate, Prisma migrate, etc.) — one table doesn't justify one. Idempotent DDL at startup instead (see below).
- A retention/archival policy for `agent_run_stats`'s unbounded row growth. The ask was to *monitor* size, not *bound* it — named as a real, deliberately-not-solved risk below rather than silently ignored.
- Grafana dashboards/panels for any of this — sub-project 4, needs this sub-project's data to exist first.
- Filtering/pagination on `StatsStore.all()` — nothing consumes it outside tests yet (checked: zero production call sites). Revisit when sub-project 4/5 need real queries against potentially-large tables.

## Design

### DB client: `pg` (node-postgres), no ORM/query builder

Matches this codebase's existing minimalism (plain `StatefulSet` over Bitnami's chart, no ORM anywhere else). One table with an insert-and-scan access pattern doesn't justify Kysely/Drizzle's type-generation machinery. Parameterized queries (`$1, $2, ...`) throughout — `stage`/`model`/`backend`/`outcome` are string values that end up in SQL, never string-concatenated.

### Schema

```sql
CREATE TABLE IF NOT EXISTS agent_run_stats (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  backend TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  wall_ms INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_run_stats_task_id_idx ON agent_run_stats (task_id);
```

`recorded_at` isn't in the `RunStats` zod contract — it's a DB-generated column, stamped by Postgres's own `now()` at insert time. This is activity-layer code, not workflow code, so a real wall-clock timestamp here doesn't touch the determinism boundary (AGENTS.md hard rule #1 only constrains `packages/workflows`). `id`/`recorded_at` exist for future ordering/pagination (sub-project 4/5) without being part of the contract every caller has to populate.

DDL runs as `CREATE TABLE IF NOT EXISTS` at store construction, idempotent, no versioning needed for a single table — the same "idempotent over a real migration framework" call this repo already made for `postgres/initdb-configmap.yaml`'s `temporal_visibility` creation.

### Schema ownership split (engine owns its table, platform owns the empty database)

Mirrors the existing Temporal precedent exactly: `agentops-platform`'s initdb script creates the *empty* `agent_run_stats` database (one line, parallel to the existing `temporal_visibility` block) — it has no business knowing this package's internal table shape. `packages/activities` (this repo) creates its own table inside that database at startup, the same way Temporal's chart owns and creates Temporal's own tables, not the initdb script.

### `StatsStore` becomes async

```ts
export interface StatsStore {
  record(stats: RunStats): Promise<void>;
  all(): Promise<RunStats[]>;
}
```

Was synchronous (`InMemoryStatsStore` never needed to await anything). A real Postgres write must be awaited by the calling activity — if `recordRunStats` returned before the `INSERT` actually committed, a crash between "activity resolves" and "row lands" loses the row with no retry, since Temporal already considers that activity complete. `InMemoryStatsStore` gets trivially-async methods; `create-activities.ts`'s `recordRunStats` now `await`s `deps.stats.record(...)`. Four call sites needed `await` added to already-`async` test functions (`create-activities.test.ts`, `e2e/happy-path.e2e.test.ts`) — checked, no other callers exist.

### `PostgresStatsStore` (`packages/activities/src/postgres-stats-store.ts`)

Takes an injectable `Queryable` (`{ query(sql, params): Promise<{ rows: unknown[] }> }`) rather than a concrete `pg.Pool` directly — same injectable-dependency pattern `K8sJobRunner` uses for its K8s client (`BatchV1ApiLike`) and `fake-batch-api.ts` for testing it. A real `pg.Pool` satisfies this interface as-is (no adapter needed); tests inject a fake that records executed SQL/params in memory. `all()` maps rows back through `RunStatsSchema.parse(...)` — round-tripping through the same zod schema the write path validates against, so a schema drift between the table and the contract fails loudly in a test rather than silently producing malformed `RunStats` objects.

### Wiring: `packages/worker/src/main.ts`

Gated on `AGENT_STATS_DB_HOST` presence — same environment-presence pattern as `KUBERNETES_SERVICE_HOST`/`OTEL_EXPORTER_OTLP_ENDPOINT`. When set, builds a `pg.Pool` from `AGENT_STATS_DB_{HOST,PORT,NAME,USER}` + `AGENT_STATS_DB_PASSWORD` (from `postgres-credentials`'s existing `password` key via `secretKeyRef` — same Postgres user/password already used for `temporal`/`temporal_visibility`, just a different database) and constructs `PostgresStatsStore`, ensuring the schema before the worker starts serving. When unset (local dev, e2e, tests), falls back to `InMemoryStatsStore` exactly as today.

### Chart wiring

`charts/engine/values.yaml`: new `agentStatsDb: { host: "", port: "5432", name: "agent_run_stats", user: "temporal" }` (host empty by default, same "chart ships no cluster assumption" pattern `otelExporterOtlpEndpoint` used). `templates/deployment.yaml`: five new env entries (`AGENT_STATS_DB_HOST/PORT/NAME/USER` as plain values, `AGENT_STATS_DB_PASSWORD` via the existing `postgres-credentials` secret), the whole block gated on `.Values.agentStatsDb.host` being non-empty so the default render stays unchanged (same trick that kept `otelExporterOtlpEndpoint` invisible in the golden file). `agentops-platform`'s `clusters/ops/engine/values.yaml` sets the real host — separate follow-up PR there, same division of labor the previous two sub-projects used.

### Monitoring the data's size (added scope, cross-repo)

`agentops-platform` gets a new `prometheus-community/prometheus-postgres-exporter` component (chart `8.1.0`, matching the version-pinning discipline sub-project 1 established), connected directly to the new `agent_run_stats` database using the same `postgres-credentials` secret (`config.datasource.passwordSecret`). Connecting there rather than to `temporal`/`postgres` gets both signals from one exporter with no custom queries file:

- `pg_database_size_bytes{datname=...}` for **every** database on the shared instance (Postgres's `pg_database` catalog is instance-wide, readable regardless of which database the exporter's connection is scoped to) — the "how big is the whole thing" view.
- `pg_stat_user_tables_*` (row counts, dead tuples, sequential scans) scoped to whatever database the exporter is connected to — i.e., specifically `agent_run_stats`'s own table, which is exactly what was asked to be monitored.

Scraped via the same `prometheus.io/scrape`/`prometheus.io/port` Service annotation convention every other component in this stack already relies on (plain `prometheus-community/prometheus`, no Operator/`ServiceMonitor` CRD installed) — no Prometheus-side config change needed.

## Testing strategy

- **Unit (`postgres-stats-store.test.ts`):** a fake `Queryable` capturing executed SQL/params, asserting `record()` issues the right parameterized `INSERT` and `all()` issues the right `SELECT` and correctly maps/validates rows back into `RunStats` via `RunStatsSchema`.
- **Not attempted: a real-Postgres integration test.** Docker is available in this sandbox, but nothing else in this repo spins up real infra for tests (K8s tests use a fake batch API, e2e uses memory ports + the `stub` backend) — matching that existing convention rather than introducing the first one. Named as a real gap, not glossed over: a schema mismatch between the hand-written SQL and what `pg` actually returns (column name casing, type coercion) wouldn't be caught by the fake-`Queryable` unit test alone.
- **Chart:** golden-file diff unaffected (env block empty-by-default, same as sub-project 2's).
- **Platform side:** `kustomize build --enable-helm` for the new `postgres-exporter` component; the `agent_run_stats` DB creation itself can't be verified without a real cluster (same limitation the `temporal_visibility` precedent already has).

## Named risks

- **No retention policy.** `agent_run_stats` grows one row per `runAgent` call forever. This sub-project makes growth *visible* (the ask), not *bounded*. Revisit once real usage data from the size metrics above shows whether it matters — premature to design retention for a table with zero real rows today.
- **Schema-drift risk between hand-written SQL and `pg`'s row shape isn't test-covered** (see Testing strategy) — the honest cost of not standing up a real-Postgres test fixture for one table.
- **`postgres-credentials`' single shared password is now used for a third purpose** (`temporal`, `temporal_visibility`, `agent_run_stats`) — consistent with ARCHITECTURE.md §5.2's "shared Postgres instance" design, not a new risk this doc introduces, but worth naming since it means rotating that password now affects three consumers instead of two.

## Package/file summary

- **New (`agentops-engine`):** `packages/activities/src/postgres-stats-store.ts` (+ test).
- **Changed (`agentops-engine`):** `packages/activities/src/stats-store.ts` (async interface), `packages/activities/src/create-activities.ts` (+ test, `await`), `e2e/happy-path.e2e.test.ts` (`await`), `packages/worker/src/main.ts`, `charts/engine/values.yaml` + `templates/deployment.yaml`, `packages/activities/package.json` (`pg`, `@types/pg`).
- **New (`agentops-platform`, separate PR):** `clusters/ops/platform/postgres-exporter/*`, one new line in `postgres/initdb-configmap.yaml`.
- **Not in either repo yet:** `agentops-platform`'s `clusters/ops/engine/values.yaml` real `agentStatsDb.host` value — same cross-repo follow-up pattern as the OTLP endpoint.

## Open questions carried forward

- Retention/archival policy once real growth data exists.
- Whether `all()` needs real filtering (by `taskId`, time range, stage) before sub-project 4/5 start querying it in earnest — deferred, YAGNI today.
