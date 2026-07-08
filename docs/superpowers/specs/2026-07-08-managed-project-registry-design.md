# Managed project registry (DB-backed repos, credentials & config) — design

Status: draft v1 · 2026-07-08 · Owner: Artem

Depends on: [2026-07-08-product-to-project-rename-design.md](2026-07-08-product-to-project-rename-design.md) landing first (this doc uses the post-rename vocabulary throughout).

## 1. Why

Two gaps in today's model:

1. **Product config must live in the target repo.** `agentops.json` (or its alternates) is discovered by reading candidate paths straight from the repo via `ScmPort.readFile` (`packages/activities/src/load-project-config.ts` post-rename). A repo you don't control — a client repo, a third-party repo, anything you can't or don't want to add platform-specific files to — has no path onto the platform at all.
2. **Credentials, while already out of the repo, are still restart-coupled.** The static project registry (`projects` map in `charts/engine/values.yaml` → `PROJECT_REGISTRY_JSON` env var + one `GITHUB_TOKEN__<PROJECT>` K8s Secret per project) requires a Helm value change + `helm upgrade` to onboard a repo. It's also entirely symmetric-secret: whatever decrypts one credential could decrypt all of them if collected into one place, which is exactly what moving to a shared datastore would do carelessly.

This design adds a **DB-backed `ManagedProject`** record — repo + credential + optional product config — managed through `packages/control` (the platform console's existing BFF), so a repo can be fully onboarded without ever being touched, and rotated/registered without a deploy.

## 2. Scope

**In scope:** the `ManagedProject` data model, its Postgres storage, its encryption scheme, the resolution-flow fallback into today's mechanisms, and CRUD via `packages/control` + CLI.

**Out of scope** (explicitly deferred, not forgotten):
- Issue #2's provider/subscription/model registry, live usage monitoring, per-stage routing UI.
- Tracker config/credentials of any kind. Today's `TrackerPort` only has a GitHub adapter, and it's the same repo/token already used for SCM — there is no second credential to model. `ProjectRegistryEntrySchema.trackerType` stays a fixed `'github'` today; if a real second tracker (Linear/Gitea) is ever built, that's the point to revisit this schema, not before.
- Bulk-migrating existing statically-registered projects into the DB — one `engine project add` per repo covers onboarding; no migration tooling.
- Keypair rotation tooling (see §5) beyond documenting the manual procedure.

## 3. Data model (`packages/contracts`)

```ts
export const ManagedProjectSchema = z.object({
  id: z.string().uuid(),
  project: z.string().min(1),               // unique short slug
  repo: z.string().min(1),                  // owner/repo
  credentialSet: z.boolean(),               // never the token itself
  config: ProjectConfigSchema.nullable(),    // null = fall back to in-repo agentops.json
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ManagedProject = z.infer<typeof ManagedProjectSchema>;

// Write-side input — never echoed back as-is (the token is write-only)
export const UpsertManagedProjectRequestSchema = z.object({
  project: z.string().min(1),
  repo: z.string().min(1),
  token: z.string().min(1).optional(),      // omit on update to keep the existing credential
  config: ProjectConfigSchema.nullable().optional(),
});
```

Why one entity instead of three tables: a product config with no repo is meaningless, and per your call in this session — "product config include a repo" — confirms the record's identity *is* the repo; credentials and config are just properties of it, not siblings.

## 4. Storage (`packages/activities`, alongside the existing `postgres-stats-store.ts`)

```sql
CREATE TABLE IF NOT EXISTS managed_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL UNIQUE,
  repo TEXT NOT NULL UNIQUE,
  encrypted_token BYTEA NOT NULL,
  config JSONB,                         -- null => fall back to in-repo agentops.json
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`encrypted_token` is a self-contained blob: `ephemeralPublicKey(32) || iv(12) || authTag(16) || ciphertext` — no separate nonce/IV table. No migration framework exists in this repo (see §4.1) — this table is created the same way `postgres-stats-store.ts` creates `agent_run_stats`: an idempotent `CREATE TABLE IF NOT EXISTS` run at startup, not a versioned migration.

Two-part interface, split by capability rather than by convention, because the split *is* the security boundary (§5):

```ts
// CRUD only — never decrypts. Safe for `control` to hold entirely.
interface ManagedProjectStore {
  get(repo: string): Promise<ManagedProject | null>;
  list(): Promise<ManagedProject[]>;
  upsert(input: UpsertManagedProjectRequest): Promise<ManagedProject>;  // encrypts with the public key
  remove(repo: string): Promise<void>;
}

// Decrypts — only ever imported where the private key is actually mounted (gateway, worker; see §6).
function resolveToken(row: ManagedProjectRow, privateKey: Buffer): string;
```

### 4.1 On schema evolution

There's no migration tool anywhere in this codebase (no Flyway/Prisma/Drizzle/node-pg-migrate, no migrations directory) — every existing Postgres table, and this one, is created via an idempotent `CREATE TABLE IF NOT EXISTS` executed by the application at startup. That covers *creating* a table, but "how do we alter it later" needs an actual answer, not just "we don't have one yet":

**Policy, until it stops being enough:**

1. **Additive changes** (a new nullable column, a new index) get appended to the same `ensureSchema()`, run unconditionally on every startup right after the `CREATE TABLE`:
   ```sql
   ALTER TABLE managed_projects ADD COLUMN IF NOT EXISTS example_field TEXT;
   ```
   One line per historical change, each with an inline comment naming when/why — git blame plus that comment *is* the migration history, in lieu of dated migration files. Safe under concurrent execution: `worker` and `control` both run multiple replicas, and Postgres serializes `IF NOT EXISTS` DDL fine across pods hitting it at their own boot time during a rolling deploy.
2. **Rollout ordering constraint that comes free with "additive only":** new code must tolerate a just-added column being absent/NULL until every replica has restarted, since `ensureSchema()` runs per-pod at its own boot — old and new replicas coexist briefly mid-rollout. Never ship code in the same change that *requires* a column that same change adds.
3. **The trigger for a real migration tool:** the first time a change isn't purely additive — renaming/dropping a column, changing a type, a data backfill, anything needing to run exactly once rather than idempotently. That's the point to introduce `node-pg-migrate` (plain SQL migration files, no ORM, no code-gen — matches this codebase's zero-framework style in `gateway`/`control` and works directly against the `pg` package already in use) with a real applied-migrations tracking table. Not before — bringing in that machinery for a change `ADD COLUMN IF NOT EXISTS` already handles safely would be pure overhead for two tables that have never needed it.

### 4.2 Database rename: `agent_run_stats` → `agentops_engine`

`managed_projects` will live in the *same* Postgres database `agent_run_stats` already uses (one shared Postgres instance, separate databases per §1 of this doc's research — reusing it avoids repeating the manual `CREATE DATABASE` provisioning step described below). But naming that database after one table inside it was already a minor wart, and adding a second, unrelated table (credentials + config, not telemetry) makes it a real mismatch — ARCHITECTURE.md §5.9 also earmarks this same database for `heal_cases` and `repo_memory` down the line, so it's only going to hold more than "stats" over time.

**Rename the database to `agentops_engine`** — names the owner (this engine), not one tenant table inside it, mirroring how Temporal's own databases are named after Temporal (`temporal`, `temporal_visibility`), not after one of Temporal's tables. Table names stay specific (`agent_run_stats`, `managed_projects`, later `heal_cases`/`repo_memory`).

Also rename the now-misleading env vars and chart values, since `control` will read the same connection info for a table that has nothing to do with "agent stats":

| Old | New |
|---|---|
| `AGENT_STATS_DB_HOST/PORT/NAME/USER/PASSWORD` (`packages/worker/src/main.ts`) | `ENGINE_DB_HOST/PORT/NAME/USER/PASSWORD` |
| `agentStatsDb` (`charts/engine/values.yaml`, `templates/deployment.yaml`) | `engineDb` |
| `agentStatsDb` (`agentops-platform`'s `clusters/ops/engine/values.yaml`) | `engineDb` |

**Scope in `agentops-platform`:** `clusters/ops/platform/postgres/initdb-configmap.yaml`'s `20-agent-run-stats.sql` block creates `agent_run_stats`, not `agentops_engine` — update it to create the new name. `DEPLOY.md` Phase 9 needs the same terminology update.

**One real operational step, not just a git change:** the `agent_run_stats` database already exists live with real data in it (however little). `initdb` scripts only run against an empty data directory (the exact hazard DEPLOY.md Phase 9 already documents for this same database's original creation), so this rename does **not** happen automatically on redeploy. It needs an explicit, manual step against the live instance before (or as part of) shipping this — e.g. `ALTER DATABASE agent_run_stats RENAME TO agentops_engine;` via `kubectl exec`, run once, documented in `DEPLOY.md` as a required manual prerequisite the same way the original `CREATE DATABASE agent_run_stats` step is documented today. Not something to script from a local session against a live shared cluster.

## 5. Encryption: asymmetric, `control` is encrypt-only

Confirmed in this session: the DB stores encrypted tokens, decryption happens only at point of use, and the public API has no way to decrypt. Mechanism — hybrid public-key encryption using **Node's built-in `crypto` only** (X25519 key agreement + HKDF + AES-256-GCM), no new dependency:

- One keypair generated once. The **public key** is not a secret — it can sit in `control`'s deployment config directly. The **private key** is one new SOPS-encrypted secret in `agentops-platform` (same pattern as every other secret in this architecture: decrypted only at deploy time into a K8s Secret).
- `control` holds only the public key. It can encrypt a token an operator submits and store the ciphertext — it cannot decrypt anything, including rows it just wrote itself.
- The private key is mounted only into **`gateway`** and **`worker`** — the two components that already handle plaintext tokens today (gateway to fetch `agentops.json`/config before a task starts; worker's `createProjectScopedPorts` dispatcher to do the actual clone/push/PR operations during a run, and to drive issue/tracker calls, since GitHub is both today). Nothing changes for them except where the token comes from.
- `cli`'s `engine start` (operator-triggered, local path) also needs the private key when a repo is DB-registered — same reasoning, it resolves a `ScmPort` before starting a task exactly like gateway does.

**Why this is the right primitive, not just a nicer one:** `control` is the one component here with a browser-facing attack surface. Symmetric encryption can't give it "encrypt but not decrypt" — the same key does both. Asymmetric encryption can, and does here: an RCE/XSS/dependency compromise in the console yields ciphertext `control` itself cannot read.

**Rotation:** a single credential (a repo's token expired) is a normal authenticated `PUT` — unaffected by any of this. Rotating the *keypair* is a rare, manual, scripted migration: decrypt every row with the old private key, re-encrypt with the new public key, redeploy `control`'s new public key and the new private key secret together. No tooling built for this now — documented as a runbook step if/when it's needed.

## 6. Resolution flow

Added as a first lookup, ahead of today's path, in `cli`'s `resolveProjectEntry`, `gateway`'s webhook handler, and `worker`'s `createProjectScopedPorts` dispatcher — all three keyed by `repo`:

1. Look up `repo` in `ManagedProjectStore`.
2. **Found:** decrypt the token (private key required — see §5); build the `ScmPort` (and the GitHub `TrackerPort`, same credential — see §2). If `config` is non-null, use it directly — no repo file read at all. If `config` is null, fetch `agentops.json` from the repo exactly as today (lets someone register credentials before writing config).
3. **Not found:** fall back completely unchanged — static `PROJECT_REGISTRY_JSON` + in-repo file lookup.

This makes DB adoption opt-in per repo with zero migration of existing projects, and is the only path available to a repo that was never in the static registry and never given a file.

## 7. Admin surface (`packages/control`)

New contracts file `packages/contracts/src/control-projects-api.ts`. Routes, following `control`'s existing conventions (plain `node:http`, JSON `{"error": "..."}` on failure, one handler file per route):

| Route | Behavior |
|---|---|
| `GET /api/projects` | List all, `ManagedProjectSchema[]` — no tokens, ever. |
| `GET /api/projects/:repo` | One, or 404. |
| `POST /api/projects` | Create. `token` required. 409 on duplicate `repo` or `project`. |
| `PUT /api/projects/:repo` | Update config and/or rotate `token` — all fields optional except whatever's changing. `repo` and `project` are immutable identity fields once created; renaming either means delete + recreate. |
| `DELETE /api/projects/:repo` | Remove. |

**Blocking prerequisite, not a nice-to-have:** `control`'s ingress has no auth at all today (confirmed — `control-ingress.yaml` has TLS only), despite ARCHITECTURE.md §5.10 already calling for "Traefik basic-auth in front." That was an acceptable gap for a read-mostly console starting Temporal workflows; it is not acceptable once `control` can create/rotate credentials. Tracked as [issue #4](https://github.com/est1908-agentic-ops/agentops-engine/issues/4) — must land before (or alongside) these routes, not after.

CLI: `engine project add|list|show|update|remove`, implemented as a thin HTTP client of the routes above (new `CONTROL_BASE_URL` config + whatever basic-auth credential) — consistent with ARCHITECTURE.md §5.10's stated principle that Mission Control is a client of the same API, not a second control path.

## 8. Testing

- `contracts`: schema tests for the new types (same style as `control-api.ts`'s existing tests).
- `activities`: `PostgresManagedProjectStore` CRUD tests; crypto round-trip tests (encrypt with the public key, decrypt with the private key, and a tamper test proving a flipped ciphertext byte fails the GCM auth tag rather than silently decrypting garbage).
- `control`: handler tests mocking the store, matching the existing handler-test style.
- `cli`/`gateway`/`worker`: resolution-flow tests covering all three branches — DB hit with config, DB hit without config (falls back to a file read), DB miss (falls back to the static registry).

## 9. Non-goals

Restated from §2: issue #2's provider/subscription registry and usage monitoring, tracker config/credentials beyond today's single GitHub credential, bulk migration tooling, and keypair-rotation automation.
