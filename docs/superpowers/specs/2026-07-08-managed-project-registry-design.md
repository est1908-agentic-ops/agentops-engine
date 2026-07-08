# Managed project registry (DB-backed repos, credentials & config) — design

Status: draft v1 · 2026-07-08 · Owner: Artem

Depends on: [2026-07-08-product-to-project-rename-design.md](2026-07-08-product-to-project-rename-design.md) landing first (this doc uses the post-rename vocabulary throughout).

## 1. Why

Two gaps in today's model:

1. **Product config must live in the target repo.** `agentops.json` (or its alternates) is discovered by reading candidate paths straight from the repo via `ScmPort.readFile` (`packages/activities/src/load-project-config.ts` post-rename). A repo you don't control — a client repo, a third-party repo, anything you can't or don't want to add platform-specific files to — has no path onto the platform at all.
2. **Credentials, while already out of the repo, are still restart-coupled.** The static project registry (`projects` map in `charts/engine/values.yaml` → `PROJECT_REGISTRY_JSON` env var + one `GITHUB_TOKEN__<PROJECT>` K8s Secret per project) requires a Helm value change + `helm upgrade` to onboard a repo. It's also entirely symmetric-secret: whatever decrypts one credential could decrypt all of them if collected into one place, which is exactly what moving to a shared datastore would do carelessly.

This design adds a **DB-backed `ManagedProject`** record — repo + SCM credential + tracker config/credential + optional product config — managed through `packages/control` (the platform console's existing BFF), so a repo can be fully onboarded without ever being touched, and rotated/registered without a deploy.

## 2. Scope

**In scope:** the `ManagedProject` data model, its Postgres storage, its encryption scheme, the resolution-flow fallback into today's mechanisms, and CRUD via `packages/control` + CLI.

**Out of scope** (explicitly deferred, not forgotten):
- Issue #2's provider/subscription/model registry, live usage monitoring, per-stage routing UI.
- Non-GitHub trackers actually implemented — the schema allows `linear`/`gitea` as values but only `github` gets a real adapter here, matching today.
- Bulk-migrating existing statically-registered projects into the DB — one `engine project add` per repo covers onboarding; no migration tooling.
- Keypair rotation tooling (see §5) beyond documenting the manual procedure.

## 3. Data model (`packages/contracts`)

```ts
export const TrackerTypeSchema = z.enum(['github', 'linear', 'gitea']);

export const ManagedProjectSchema = z.object({
  id: z.string().uuid(),
  project: z.string().min(1),               // unique short slug
  repo: z.string().min(1),                  // owner/repo
  scm: z.object({
    type: z.literal('github'),
    credentialSet: z.boolean(),             // never the token itself
  }),
  tracker: z.object({
    type: TrackerTypeSchema,
    credentialSet: z.boolean(),
    config: z.record(z.string(), z.string()).optional(), // e.g. Linear team id
  }),
  config: ProjectConfigSchema.nullable(),   // null = fall back to in-repo agentops.json
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ManagedProject = z.infer<typeof ManagedProjectSchema>;

// Write-side input — never echoed back as-is (tokens are write-only)
export const UpsertManagedProjectRequestSchema = z.object({
  project: z.string().min(1),
  repo: z.string().min(1),
  scmToken: z.string().min(1).optional(),   // omit on update to keep the existing credential
  tracker: z.object({
    type: TrackerTypeSchema,
    token: z.string().min(1).optional(),    // omit => reuse the SCM credential (the common case: GitHub for both)
    config: z.record(z.string(), z.string()).optional(),
  }).optional(),                            // omit entirely => tracker defaults to { type: scm.type, reuse scm token }
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
  scm_type TEXT NOT NULL,
  scm_encrypted_token BYTEA NOT NULL,
  tracker_type TEXT NOT NULL,
  tracker_encrypted_token BYTEA,        -- null => reuse the SCM credential
  tracker_config JSONB,
  config JSONB,                         -- null => fall back to in-repo agentops.json
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Each `*_encrypted_token` column is a self-contained blob: `ephemeralPublicKey(32) || iv(12) || authTag(16) || ciphertext` — no separate nonce/IV table.

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
function resolveScmToken(row: ManagedProjectRow, privateKey: Buffer): string;
function resolveTrackerToken(row: ManagedProjectRow, privateKey: Buffer): string;
```

## 5. Encryption: asymmetric, `control` is encrypt-only

Confirmed in this session: the DB stores encrypted tokens, decryption happens only at point of use, and the public API has no way to decrypt. Mechanism — hybrid public-key encryption using **Node's built-in `crypto` only** (X25519 key agreement + HKDF + AES-256-GCM), no new dependency:

- One keypair generated once. The **public key** is not a secret — it can sit in `control`'s deployment config directly. The **private key** is one new SOPS-encrypted secret in `agentops-platform` (same pattern as every other secret in this architecture: decrypted only at deploy time into a K8s Secret).
- `control` holds only the public key. It can encrypt a token an operator submits and store the ciphertext — it cannot decrypt anything, including rows it just wrote itself.
- The private key is mounted only into **`gateway`** and **`worker`** — the two components that already handle plaintext tokens today (gateway to fetch `agentops.json`/config before a task starts; worker's `createProjectScopedPorts` dispatcher to do the actual clone/push/PR operations during a run). Nothing changes for them except where the token comes from.
- `cli`'s `engine start` (operator-triggered, local path) also needs the private key when a repo is DB-registered — same reasoning, it resolves a `ScmPort` before starting a task exactly like gateway does.

**Why this is the right primitive, not just a nicer one:** `control` is the one component here with a browser-facing attack surface. Symmetric encryption can't give it "encrypt but not decrypt" — the same key does both. Asymmetric encryption can, and does here: an RCE/XSS/dependency compromise in the console yields ciphertext `control` itself cannot read.

**Rotation:** a single credential (a repo's token expired) is a normal authenticated `PUT` — unaffected by any of this. Rotating the *keypair* is a rare, manual, scripted migration: decrypt every row with the old private key, re-encrypt with the new public key, redeploy `control`'s new public key and the new private key secret together. No tooling built for this now — documented as a runbook step if/when it's needed.

## 6. Resolution flow

Added as a first lookup, ahead of today's path, in `cli`'s `resolveProjectEntry`, `gateway`'s webhook handler, and `worker`'s `createProjectScopedPorts` dispatcher — all three keyed by `repo`:

1. Look up `repo` in `ManagedProjectStore`.
2. **Found:** decrypt the SCM token (private key required — see §5); build the `ScmPort`. If `config` is non-null, use it directly — no repo file read at all. If `config` is null, fetch `agentops.json` from the repo exactly as today (lets someone register credentials before writing config). Tracker token is the decrypted `tracker_encrypted_token`, or the SCM token if that column is null (the common case).
3. **Not found:** fall back completely unchanged — static `PROJECT_REGISTRY_JSON` + in-repo file lookup.

This makes DB adoption opt-in per repo with zero migration of existing projects, and is the only path available to a repo that was never in the static registry and never given a file.

## 7. Admin surface (`packages/control`)

New contracts file `packages/contracts/src/control-projects-api.ts`. Routes, following `control`'s existing conventions (plain `node:http`, JSON `{"error": "..."}` on failure, one handler file per route):

| Route | Behavior |
|---|---|
| `GET /api/projects` | List all, `ManagedProjectSchema[]` — no tokens, ever. |
| `GET /api/projects/:repo` | One, or 404. |
| `POST /api/projects` | Create. `scmToken` required. 409 on duplicate `repo` or `project`. |
| `PUT /api/projects/:repo` | Update config and/or rotate `scmToken`/tracker token — all fields optional except whatever's changing. `repo` and `project` are immutable identity fields once created; renaming either means delete + recreate. |
| `DELETE /api/projects/:repo` | Remove. |

**Blocking prerequisite, not a nice-to-have:** ARCHITECTURE.md §5.10 describes `control`'s near-term auth as "Traefik basic-auth in front, in-cluster; open in local dev." That was an acceptable posture for a read-mostly console starting Temporal workflows. It is not acceptable once `control` can create/rotate credentials — basic auth needs to actually be deployed and verified in front of `control` before these routes ship, not left as the already-planned-eventually item it currently is.

CLI: `engine project add|list|show|update|remove`, implemented as a thin HTTP client of the routes above (new `CONTROL_BASE_URL` config + whatever basic-auth credential) — consistent with ARCHITECTURE.md §5.10's stated principle that Mission Control is a client of the same API, not a second control path.

## 8. Testing

- `contracts`: schema tests for the new types (same style as `control-api.ts`'s existing tests).
- `activities`: `PostgresManagedProjectStore` CRUD tests; crypto round-trip tests (encrypt with the public key, decrypt with the private key, and a tamper test proving a flipped ciphertext byte fails the GCM auth tag rather than silently decrypting garbage).
- `control`: handler tests mocking the store, matching the existing handler-test style.
- `cli`/`gateway`/`worker`: resolution-flow tests covering all three branches — DB hit with config, DB hit without config (falls back to a file read), DB miss (falls back to the static registry).

## 9. Non-goals

Restated from §2: issue #2's provider/subscription registry and usage monitoring, non-GitHub tracker adapters, bulk migration tooling, and keypair-rotation automation.
