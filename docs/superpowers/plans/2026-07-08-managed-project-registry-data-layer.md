# Managed Project Registry — Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a repo's credential + product config resolvable from Postgres instead of only the static `PROJECT_REGISTRY_JSON` registry + in-repo `agentops.json` — end to end, so a DB-registered repo can actually have a task started and run against it. This is the data layer only; the admin API/CLI that let an operator manage rows without raw SQL is a follow-up plan (see the "Scope" note below).

**Architecture:** A new `ManagedProject` Postgres table (`agentops_engine` database — renamed from `agent_run_stats`, since it now holds more than stats) stores `{ project, repo, encrypted_token, config }`. Credentials are encrypted with a hybrid X25519+HKDF+AES-256-GCM scheme (Node's built-in `crypto`, zero new dependency) so that whoever holds only the **public** key can encrypt but never decrypt — the private key lives only where `cli`, `gateway`, and `worker` already handle plaintext tokens today. Resolution is DB-first with a fallback to today's static registry + in-repo file, added at the same three points that already resolve credentials: `cli`'s `resolveProjectEntry`, `gateway`'s webhook handler (both per-request), and `worker`'s boot-time registry build (merged once at startup, since `worker` pre-builds all its ports at boot rather than per-request — a deliberate simplification over a fully dynamic dispatcher, noted in Task 6).

**Tech Stack:** TypeScript, `pg` (Postgres driver — already used by `worker`, newly added to `gateway`/`cli`), Node's built-in `crypto`, zod, vitest.

**Scope note:** This plan does NOT include `packages/control`'s CRUD routes or the `engine project` CLI subcommands (`docs/superpowers/specs/2026-07-08-managed-project-registry-design.md` §7) — those depend on this plan's store existing and are a separate follow-up plan. Without them, testing this plan's end state means inserting a row via a small script that calls `encryptForManagedProject` directly (shown in Task 9) — acceptable for this increment, not the long-term operator experience.

---

### Task 1: `packages/contracts` — the `ManagedProject` schema

**Files:**
- Create: `packages/contracts/src/managed-project.ts`
- Test: `packages/contracts/src/managed-project.test.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/contracts/src/managed-project.test.ts
import { describe, expect, it } from 'vitest';
import { ManagedProjectSchema, UpsertManagedProjectRequestSchema } from './managed-project';

describe('ManagedProjectSchema', () => {
  it('parses a valid managed project with a null config', () => {
    const parsed = ManagedProjectSchema.parse({
      id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      project: 'acme-web',
      repo: 'acme/web',
      credentialSet: true,
      config: null,
      createdAt: '2026-07-08T12:00:00.000Z',
      updatedAt: '2026-07-08T12:00:00.000Z',
    });
    expect(parsed.project).toBe('acme-web');
    expect(parsed.config).toBeNull();
  });

  it('parses a valid managed project with a set config', () => {
    const parsed = ManagedProjectSchema.parse({
      id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      project: 'acme-web',
      repo: 'acme/web',
      credentialSet: true,
      config: { stages: {}, routing: {}, brakes: { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 } },
      createdAt: '2026-07-08T12:00:00.000Z',
      updatedAt: '2026-07-08T12:00:00.000Z',
    });
    expect(parsed.config?.brakes.maxTokens).toBe(200_000);
  });

  it('rejects a missing repo', () => {
    expect(() =>
      ManagedProjectSchema.parse({
        id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        project: 'acme-web',
        credentialSet: true,
        config: null,
        createdAt: '2026-07-08T12:00:00.000Z',
        updatedAt: '2026-07-08T12:00:00.000Z',
      }),
    ).toThrow();
  });
});

describe('UpsertManagedProjectRequestSchema', () => {
  it('allows omitting token and config for an update', () => {
    const parsed = UpsertManagedProjectRequestSchema.parse({ project: 'acme-web', repo: 'acme/web' });
    expect(parsed.token).toBeUndefined();
    expect(parsed.config).toBeUndefined();
  });

  it('accepts an explicit null config to clear it back to file-based', () => {
    const parsed = UpsertManagedProjectRequestSchema.parse({ project: 'acme-web', repo: 'acme/web', config: null });
    expect(parsed.config).toBeNull();
  });

  it('rejects an empty token string', () => {
    expect(() => UpsertManagedProjectRequestSchema.parse({ project: 'acme-web', repo: 'acme/web', token: '' })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/contracts/src/managed-project.test.ts`
Expected: FAIL — `Cannot find module './managed-project'`.

- [ ] **Step 3: Write the schema**

```ts
// packages/contracts/src/managed-project.ts
import { z } from 'zod';
import { ProjectConfigSchema } from './project-config';

export const ManagedProjectSchema = z.object({
  id: z.string().uuid(),
  project: z.string().min(1),
  repo: z.string().min(1),
  credentialSet: z.boolean(),
  config: ProjectConfigSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ManagedProject = z.infer<typeof ManagedProjectSchema>;

export const UpsertManagedProjectRequestSchema = z.object({
  project: z.string().min(1),
  repo: z.string().min(1),
  token: z.string().min(1).optional(),
  config: ProjectConfigSchema.nullable().optional(),
});
export type UpsertManagedProjectRequest = z.infer<typeof UpsertManagedProjectRequestSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/contracts/src/managed-project.test.ts`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Export from the package barrel**

```ts
// packages/contracts/src/index.ts -- add this line (alphabetical position doesn't matter, this file isn't sorted)
export * from './managed-project';
```

- [ ] **Step 6: Typecheck and test the whole package**

Run: `pnpm --filter @agentops/contracts run typecheck && pnpm test -- packages/contracts`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): add ManagedProjectSchema and UpsertManagedProjectRequestSchema"
```

---

### Task 2: `packages/activities` — credential encryption

**Files:**
- Create: `packages/activities/src/credential-crypto.ts`
- Test: `packages/activities/src/credential-crypto.test.ts`
- Modify: `packages/activities/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/activities/src/credential-crypto.test.ts
import { describe, expect, it } from 'vitest';
import {
  decryptForManagedProject,
  encryptForManagedProject,
  generateManagedProjectKeyPair,
} from './credential-crypto';

describe('credential-crypto', () => {
  it('round-trips a token through encrypt then decrypt', () => {
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const blob = encryptForManagedProject(publicKey, 'ghp_super-secret-token');
    expect(decryptForManagedProject(privateKey, blob)).toBe('ghp_super-secret-token');
  });

  it('produces a different ciphertext each time (random ephemeral key + IV)', () => {
    const { publicKey } = generateManagedProjectKeyPair();
    const blobA = encryptForManagedProject(publicKey, 'same-plaintext');
    const blobB = encryptForManagedProject(publicKey, 'same-plaintext');
    expect(blobA).not.toBe(blobB);
  });

  it('cannot be decrypted with a different keypair\'s private key', () => {
    const pairA = generateManagedProjectKeyPair();
    const pairB = generateManagedProjectKeyPair();
    const blob = encryptForManagedProject(pairA.publicKey, 'secret');
    expect(() => decryptForManagedProject(pairB.privateKey, blob)).toThrow();
  });

  it('rejects a tampered ciphertext (GCM auth tag catches it, does not silently decrypt garbage)', () => {
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const blob = encryptForManagedProject(publicKey, 'secret');
    const bytes = Buffer.from(blob, 'base64');
    bytes[bytes.length - 1] ^= 0xff; // flip the last ciphertext byte
    const tampered = bytes.toString('base64');
    expect(() => decryptForManagedProject(privateKey, tampered)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/activities/src/credential-crypto.test.ts`
Expected: FAIL — `Cannot find module './credential-crypto'`.

- [ ] **Step 3: Write the crypto module**

```ts
// packages/activities/src/credential-crypto.ts
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const AES_KEY_LENGTH = 32; // AES-256
// Fixed, non-secret domain-separation string for HKDF -- distinguishes this
// key-derivation use from any other HKDF use of the same shared secret,
// should one ever exist. Not a secret itself.
const HKDF_INFO = Buffer.from('agentops-managed-project-credential');

export interface ManagedProjectKeyPair {
  /** Base64 SPKI DER. Not a secret -- safe to store as a plain chart value. */
  publicKey: string;
  /** Base64 PKCS8 DER. A secret -- SOPS-encrypt it, mount only where decryption happens. */
  privateKey: string;
}

export function generateManagedProjectKeyPair(): ManagedProjectKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return { publicKey: publicKey.toString('base64'), privateKey: privateKey.toString('base64') };
}

function importPublicKey(base64Der: string): KeyObject {
  return createPublicKey({ key: Buffer.from(base64Der, 'base64'), format: 'der', type: 'spki' });
}

function importPrivateKey(base64Der: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(base64Der, 'base64'), format: 'der', type: 'pkcs8' });
}

function deriveAesKey(sharedSecret: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', sharedSecret, Buffer.alloc(0), HKDF_INFO, AES_KEY_LENGTH));
}

// Self-describing blob so we never depend on the ephemeral public key's DER
// length being some assumed constant: [2-byte BE length][ephemeral pubkey DER][iv][authTag][ciphertext].
function packBlob(ephemeralPublicKeyDer: Buffer, iv: Buffer, authTag: Buffer, ciphertext: Buffer): Buffer {
  const lengthPrefix = Buffer.alloc(2);
  lengthPrefix.writeUInt16BE(ephemeralPublicKeyDer.length, 0);
  return Buffer.concat([lengthPrefix, ephemeralPublicKeyDer, iv, authTag, ciphertext]);
}

function unpackBlob(blob: Buffer): { ephemeralPublicKeyDer: Buffer; iv: Buffer; authTag: Buffer; ciphertext: Buffer } {
  const ephemeralPublicKeyLength = blob.readUInt16BE(0);
  let offset = 2;
  const ephemeralPublicKeyDer = blob.subarray(offset, offset + ephemeralPublicKeyLength);
  offset += ephemeralPublicKeyLength;
  const iv = blob.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const authTag = blob.subarray(offset, offset + AUTH_TAG_LENGTH);
  offset += AUTH_TAG_LENGTH;
  const ciphertext = blob.subarray(offset);
  return { ephemeralPublicKeyDer, iv, authTag, ciphertext };
}

/**
 * Encrypts `plaintext` for the holder of the matching private key.
 * `packages/control` is meant to hold only `recipientPublicKeyBase64` --
 * by construction, this function's caller cannot decrypt what it just wrote.
 */
export function encryptForManagedProject(recipientPublicKeyBase64: string, plaintext: string): string {
  const recipientPublicKey = importPublicKey(recipientPublicKeyBase64);
  const ephemeral = generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const ephemeralPrivateKey = createPrivateKey({ key: ephemeral.privateKey, format: 'der', type: 'pkcs8' });
  const sharedSecret = diffieHellman({ privateKey: ephemeralPrivateKey, publicKey: recipientPublicKey });
  const aesKey = deriveAesKey(sharedSecret);

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return packBlob(ephemeral.publicKey, iv, authTag, ciphertext).toString('base64');
}

/**
 * Decrypts a blob produced by `encryptForManagedProject`. Requires the
 * recipient's private key -- only `cli`/`gateway`/`worker` are ever given
 * it; `packages/control` never imports this function.
 */
export function decryptForManagedProject(recipientPrivateKeyBase64: string, blobBase64: string): string {
  const { ephemeralPublicKeyDer, iv, authTag, ciphertext } = unpackBlob(Buffer.from(blobBase64, 'base64'));
  const ephemeralPublicKey = createPublicKey({ key: ephemeralPublicKeyDer, format: 'der', type: 'spki' });
  const recipientPrivateKey = importPrivateKey(recipientPrivateKeyBase64);
  const sharedSecret = diffieHellman({ privateKey: recipientPrivateKey, publicKey: ephemeralPublicKey });
  const aesKey = deriveAesKey(sharedSecret);

  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/activities/src/credential-crypto.test.ts`
Expected: PASS, all 4 tests green. If the "tampered ciphertext" test doesn't throw, `decipher.setAuthTag`/`.final()` isn't being reached correctly — re-check `unpackBlob`'s offsets against `packBlob`'s write order before assuming the crypto primitives themselves are wrong.

- [ ] **Step 5: Export from the package barrel**

```ts
// packages/activities/src/index.ts -- add this line
export * from './credential-crypto';
```

- [ ] **Step 6: Typecheck and test the whole package**

Run: `pnpm --filter @agentops/activities run typecheck && pnpm test -- packages/activities`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/activities
git commit -m "feat(activities): add X25519/HKDF/AES-256-GCM credential encryption"
```

---

### Task 3: `packages/activities` — the Postgres store

**Files:**
- Create: `packages/activities/src/postgres-managed-project-store.ts`
- Test: `packages/activities/src/postgres-managed-project-store.test.ts`
- Modify: `packages/activities/src/index.ts`

- [ ] **Step 1: Write the failing test**

This mirrors `postgres-stats-store.test.ts`'s style: a fake `Queryable` in-memory table, no real Postgres needed.

```ts
// packages/activities/src/postgres-managed-project-store.test.ts
import { describe, expect, it } from 'vitest';
import { generateManagedProjectKeyPair, decryptForManagedProject } from './credential-crypto';
import { PostgresManagedProjectStore } from './postgres-managed-project-store';
import type { Queryable } from './postgres-stats-store';

// A tiny fake Postgres that's just enough to exercise INSERT/SELECT/UPDATE/
// DELETE/ON CONFLICT for this one table -- not a general SQL engine.
function createFakeDb(): Queryable {
  const rows: Array<{
    id: string;
    project: string;
    repo: string;
    encrypted_token: string;
    config: unknown;
    created_at: Date;
    updated_at: Date;
  }> = [];
  let nextId = 1;

  return {
    async query(sql: string, params: unknown[] = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (normalized.startsWith('CREATE TABLE')) {
        return { rows: [] };
      }
      if (normalized.startsWith('SELECT * FROM managed_projects WHERE repo')) {
        const [repo] = params as [string];
        const found = rows.filter((r) => r.repo === repo);
        return { rows: found };
      }
      if (normalized.startsWith('SELECT * FROM managed_projects ORDER BY project')) {
        return { rows: [...rows].sort((a, b) => a.project.localeCompare(b.project)) };
      }
      if (normalized.startsWith('INSERT INTO managed_projects')) {
        const [project, repo, encryptedToken, config] = params as [string, string, string, unknown];
        const existingIndex = rows.findIndex((r) => r.repo === repo);
        const now = new Date();
        if (existingIndex >= 0) {
          rows[existingIndex] = { ...rows[existingIndex], project, encrypted_token: encryptedToken, config, updated_at: now };
          return { rows: [rows[existingIndex]] };
        }
        const row = { id: String(nextId++), project, repo, encrypted_token: encryptedToken, config, created_at: now, updated_at: now };
        rows.push(row);
        return { rows: [row] };
      }
      if (normalized.startsWith('DELETE FROM managed_projects')) {
        const [repo] = params as [string];
        const index = rows.findIndex((r) => r.repo === repo);
        if (index >= 0) {
          rows.splice(index, 1);
        }
        return { rows: [] };
      }
      throw new Error(`createFakeDb: unhandled query: ${normalized}`);
    },
  };
}

describe('PostgresManagedProjectStore', () => {
  it('returns null for an unregistered repo', async () => {
    const store = new PostgresManagedProjectStore(createFakeDb());
    expect(await store.get('acme/nope')).toBeNull();
    expect(await store.getEncryptedToken('acme/nope')).toBeNull();
  });

  it('creates a new project, requiring a token', async () => {
    const store = new PostgresManagedProjectStore(createFakeDb());
    const { publicKey, privateKey } = generateManagedProjectKeyPair();

    const created = await store.upsert({ project: 'acme-web', repo: 'acme/web', token: 'ghp_abc123' }, publicKey);

    expect(created.project).toBe('acme-web');
    expect(created.credentialSet).toBe(true);
    expect(created.config).toBeNull();

    const encrypted = await store.getEncryptedToken('acme/web');
    expect(encrypted).not.toBeNull();
    expect(decryptForManagedProject(privateKey, encrypted!)).toBe('ghp_abc123');
  });

  it('throws when creating a new project without a token', async () => {
    const store = new PostgresManagedProjectStore(createFakeDb());
    const { publicKey } = generateManagedProjectKeyPair();
    await expect(store.upsert({ project: 'acme-web', repo: 'acme/web' }, publicKey)).rejects.toThrow(/token is required/);
  });

  it('updates config without a new token, preserving the existing credential', async () => {
    const store = new PostgresManagedProjectStore(createFakeDb());
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    await store.upsert({ project: 'acme-web', repo: 'acme/web', token: 'ghp_abc123' }, publicKey);

    const config = { stages: {}, routing: {}, brakes: { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 } };
    const updated = await store.upsert({ project: 'acme-web', repo: 'acme/web', config }, publicKey);

    expect(updated.config).toEqual(config);
    const encrypted = await store.getEncryptedToken('acme/web');
    expect(decryptForManagedProject(privateKey, encrypted!)).toBe('ghp_abc123'); // unchanged
  });

  it('rotates the token, preserving the existing config', async () => {
    const store = new PostgresManagedProjectStore(createFakeDb());
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const config = { stages: {}, routing: {}, brakes: { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 } };
    await store.upsert({ project: 'acme-web', repo: 'acme/web', token: 'ghp_old', config }, publicKey);

    const updated = await store.upsert({ project: 'acme-web', repo: 'acme/web', token: 'ghp_new' }, publicKey);

    expect(updated.config).toEqual(config); // unchanged
    const encrypted = await store.getEncryptedToken('acme/web');
    expect(decryptForManagedProject(privateKey, encrypted!)).toBe('ghp_new');
  });

  it('clears config back to file-based with an explicit null', async () => {
    const store = new PostgresManagedProjectStore(createFakeDb());
    const { publicKey } = generateManagedProjectKeyPair();
    const config = { stages: {}, routing: {}, brakes: { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 } };
    await store.upsert({ project: 'acme-web', repo: 'acme/web', token: 'ghp_abc123', config }, publicKey);

    const updated = await store.upsert({ project: 'acme-web', repo: 'acme/web', config: null }, publicKey);

    expect(updated.config).toBeNull();
  });

  it('lists all projects sorted by project name', async () => {
    const store = new PostgresManagedProjectStore(createFakeDb());
    const { publicKey } = generateManagedProjectKeyPair();
    await store.upsert({ project: 'zebra', repo: 'acme/zebra', token: 't1' }, publicKey);
    await store.upsert({ project: 'apple', repo: 'acme/apple', token: 't2' }, publicKey);

    const list = await store.list();
    expect(list.map((p) => p.project)).toEqual(['apple', 'zebra']);
  });

  it('removes a project', async () => {
    const store = new PostgresManagedProjectStore(createFakeDb());
    const { publicKey } = generateManagedProjectKeyPair();
    await store.upsert({ project: 'acme-web', repo: 'acme/web', token: 't1' }, publicKey);

    await store.remove('acme/web');

    expect(await store.get('acme/web')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/activities/src/postgres-managed-project-store.test.ts`
Expected: FAIL — `Cannot find module './postgres-managed-project-store'`.

- [ ] **Step 3: Write the store**

```ts
// packages/activities/src/postgres-managed-project-store.ts
import { ManagedProjectSchema, UpsertManagedProjectRequestSchema, type ManagedProject, type UpsertManagedProjectRequest } from '@agentops/contracts';
import { encryptForManagedProject } from './credential-crypto';
import type { Queryable } from './postgres-stats-store';

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS managed_projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project TEXT NOT NULL UNIQUE,
    repo TEXT NOT NULL UNIQUE,
    encrypted_token TEXT NOT NULL,
    config JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

interface ManagedProjectRow {
  id: string;
  project: string;
  repo: string;
  encrypted_token: string;
  config: unknown;
  created_at: Date;
  updated_at: Date;
}

function rowToManagedProject(row: ManagedProjectRow): ManagedProject {
  return ManagedProjectSchema.parse({
    id: row.id,
    project: row.project,
    repo: row.repo,
    credentialSet: true,
    config: row.config ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

export class PostgresManagedProjectStore {
  constructor(private readonly db: Queryable) {}

  /** Idempotent -- safe to call every time a process starts, same as PostgresStatsStore. */
  async ensureSchema(): Promise<void> {
    await this.db.query(CREATE_TABLE_SQL);
  }

  private async getRow(repo: string): Promise<ManagedProjectRow | null> {
    const { rows } = await this.db.query('SELECT * FROM managed_projects WHERE repo = $1', [repo]);
    return (rows[0] as ManagedProjectRow | undefined) ?? null;
  }

  async get(repo: string): Promise<ManagedProject | null> {
    const row = await this.getRow(repo);
    return row ? rowToManagedProject(row) : null;
  }

  /** Raw encrypted blob, or null if unregistered. Decrypt with credential-crypto's decryptForManagedProject -- this class never touches a private key. */
  async getEncryptedToken(repo: string): Promise<string | null> {
    const row = await this.getRow(repo);
    return row?.encrypted_token ?? null;
  }

  async list(): Promise<ManagedProject[]> {
    const { rows } = await this.db.query('SELECT * FROM managed_projects ORDER BY project');
    return (rows as ManagedProjectRow[]).map(rowToManagedProject);
  }

  /**
   * Encrypts with `publicKey` -- this class never accepts or needs a private
   * key. `token` omitted on an existing project keeps its current credential;
   * `config` omitted keeps its current config, `null` clears it to
   * file-based, an object sets it.
   */
  async upsert(input: UpsertManagedProjectRequest, publicKey: string): Promise<ManagedProject> {
    const parsed = UpsertManagedProjectRequestSchema.parse(input);
    const existingRow = await this.getRow(parsed.repo);

    if (!existingRow && !parsed.token) {
      throw new Error(`PostgresManagedProjectStore.upsert: a token is required to create a new project ("${parsed.repo}")`);
    }

    const encryptedToken = parsed.token ? encryptForManagedProject(publicKey, parsed.token) : existingRow!.encrypted_token;
    const config = parsed.config === undefined ? (existingRow?.config ?? null) : parsed.config;

    const { rows } = await this.db.query(
      `INSERT INTO managed_projects (project, repo, encrypted_token, config)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (repo) DO UPDATE SET
         project = EXCLUDED.project,
         encrypted_token = EXCLUDED.encrypted_token,
         config = EXCLUDED.config,
         updated_at = now()
       RETURNING *`,
      [parsed.project, parsed.repo, encryptedToken, config],
    );
    return rowToManagedProject(rows[0] as ManagedProjectRow);
  }

  async remove(repo: string): Promise<void> {
    await this.db.query('DELETE FROM managed_projects WHERE repo = $1', [repo]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/activities/src/postgres-managed-project-store.test.ts`
Expected: PASS, all 8 tests green.

- [ ] **Step 5: Export from the package barrel**

```ts
// packages/activities/src/index.ts -- add this line
export * from './postgres-managed-project-store';
```

- [ ] **Step 6: Typecheck and test the whole package**

Run: `pnpm --filter @agentops/activities run typecheck && pnpm test -- packages/activities`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/activities
git commit -m "feat(activities): add PostgresManagedProjectStore"
```

---

### Task 4: `packages/activities` — DB-first resolution helper

**Files:**
- Create: `packages/activities/src/resolve-managed-projects.ts`
- Test: `packages/activities/src/resolve-managed-projects.test.ts`
- Modify: `packages/activities/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/activities/src/resolve-managed-projects.test.ts
import { describe, expect, it } from 'vitest';
import type { ResolvedProjectEntry } from '@agentops/contracts';
import { encryptForManagedProject, generateManagedProjectKeyPair } from './credential-crypto';
import { loadManagedProjectRegistry, resolveManagedProjectEntry } from './resolve-managed-projects';
import type { PostgresManagedProjectStore } from './postgres-managed-project-store';

function fakeStore(rows: Array<{ project: string; repo: string; encryptedToken: string; config?: unknown }>) {
  return {
    async get(repo: string) {
      const row = rows.find((r) => r.repo === repo);
      return row ? { id: '1', project: row.project, repo: row.repo, credentialSet: true, config: row.config ?? null, createdAt: '', updatedAt: '' } : null;
    },
    async getEncryptedToken(repo: string) {
      return rows.find((r) => r.repo === repo)?.encryptedToken ?? null;
    },
    async list() {
      return rows.map((r) => ({ id: '1', project: r.project, repo: r.repo, credentialSet: true, config: r.config ?? null, createdAt: '', updatedAt: '' }));
    },
  } as unknown as PostgresManagedProjectStore;
}

const staticRegistry: ResolvedProjectEntry[] = [
  { project: 'legacy', repo: 'acme/legacy', trackerType: 'github', tokenEnvVar: 'GITHUB_TOKEN__LEGACY', token: 'static-token' },
];

describe('resolveManagedProjectEntry', () => {
  it('resolves from the DB when the repo is managed there, decrypting the token', async () => {
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const blob = encryptForManagedProject(publicKey, 'db-token');
    const store = fakeStore([{ project: 'acme-web', repo: 'acme/web', encryptedToken: blob }]);

    const resolved = await resolveManagedProjectEntry({ store, privateKey }, staticRegistry, 'acme/web');

    expect(resolved).toEqual({
      project: 'acme-web',
      repo: 'acme/web',
      trackerType: 'github',
      tokenEnvVar: '(managed-project, not env-backed)',
      token: 'db-token',
    });
  });

  it('falls back to the static registry when the repo is not DB-managed', async () => {
    const store = fakeStore([]);
    const resolved = await resolveManagedProjectEntry({ store, privateKey: 'unused' }, staticRegistry, 'acme/legacy');
    expect(resolved).toEqual(staticRegistry[0]);
  });

  it('falls back to the static registry when no DB deps are configured at all', async () => {
    const resolved = await resolveManagedProjectEntry(undefined, staticRegistry, 'acme/legacy');
    expect(resolved).toEqual(staticRegistry[0]);
  });

  it('returns null when neither source has the repo', async () => {
    const store = fakeStore([]);
    const resolved = await resolveManagedProjectEntry({ store, privateKey: 'unused' }, staticRegistry, 'acme/nowhere');
    expect(resolved).toBeNull();
  });
});

describe('loadManagedProjectRegistry', () => {
  it('decrypts every managed project into a ResolvedProjectEntry', async () => {
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const store = fakeStore([
      { project: 'a', repo: 'acme/a', encryptedToken: encryptForManagedProject(publicKey, 'token-a') },
      { project: 'b', repo: 'acme/b', encryptedToken: encryptForManagedProject(publicKey, 'token-b') },
    ]);

    const entries = await loadManagedProjectRegistry({ store, privateKey });

    expect(entries).toEqual([
      { project: 'a', repo: 'acme/a', trackerType: 'github', tokenEnvVar: '(managed-project, not env-backed)', token: 'token-a' },
      { project: 'b', repo: 'acme/b', trackerType: 'github', tokenEnvVar: '(managed-project, not env-backed)', token: 'token-b' },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/activities/src/resolve-managed-projects.test.ts`
Expected: FAIL — `Cannot find module './resolve-managed-projects'`.

- [ ] **Step 3: Write the resolver**

```ts
// packages/activities/src/resolve-managed-projects.ts
import type { ResolvedProjectEntry } from '@agentops/contracts';
import { decryptForManagedProject } from './credential-crypto';
import type { PostgresManagedProjectStore } from './postgres-managed-project-store';

// ResolvedProjectEntry.tokenEnvVar only ever mattered during the static
// PROJECT_REGISTRY_JSON load (to look up the real env var name) -- nothing
// downstream reads it after resolution. This sentinel makes a DB-sourced
// entry visually distinct in logs/debugging without adding an optional
// field that would need updating at every existing call site.
const MANAGED_PROJECT_TOKEN_ENV_VAR_SENTINEL = '(managed-project, not env-backed)';

export interface ManagedProjectRegistryDeps {
  store: PostgresManagedProjectStore;
  /** Base64 PKCS8 DER private key -- decrypts credentials this process is allowed to use. */
  privateKey: string;
}

async function resolveOne(deps: ManagedProjectRegistryDeps, repo: string): Promise<ResolvedProjectEntry | null> {
  const managedProject = await deps.store.get(repo);
  if (!managedProject) {
    return null;
  }
  const encryptedToken = await deps.store.getEncryptedToken(repo);
  if (!encryptedToken) {
    return null; // shouldn't happen (get() and getEncryptedToken() query the same row) -- fall through to the static registry rather than throw
  }
  return {
    project: managedProject.project,
    repo: managedProject.repo,
    trackerType: 'github',
    tokenEnvVar: MANAGED_PROJECT_TOKEN_ENV_VAR_SENTINEL,
    token: decryptForManagedProject(deps.privateKey, encryptedToken),
  };
}

/**
 * DB-first lookup for one repo, falling back to `staticRegistry`. `deps`
 * is undefined when no DB is configured at all (ENGINE_DB_HOST/private key
 * unset) -- falls straight through to the static registry, same as today.
 */
export async function resolveManagedProjectEntry(
  deps: ManagedProjectRegistryDeps | undefined,
  staticRegistry: ResolvedProjectEntry[],
  repo: string,
): Promise<ResolvedProjectEntry | null> {
  if (deps) {
    const resolved = await resolveOne(deps, repo);
    if (resolved) {
      return resolved;
    }
  }
  return staticRegistry.find((entry) => entry.repo === repo) ?? null;
}

/**
 * All DB-managed projects, decrypted -- used once at worker boot to merge
 * into the same registry array it builds ports from (worker pre-builds
 * ports for every registered repo at startup rather than per request, so
 * DB entries need to be present in that same list; see the data-layer
 * plan's Task 6 for why this is boot-time rather than fully dynamic).
 */
export async function loadManagedProjectRegistry(deps: ManagedProjectRegistryDeps): Promise<ResolvedProjectEntry[]> {
  const managedProjects = await deps.store.list();
  const entries: ResolvedProjectEntry[] = [];
  for (const project of managedProjects) {
    const resolved = await resolveOne(deps, project.repo);
    if (resolved) {
      entries.push(resolved);
    }
  }
  return entries;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/activities/src/resolve-managed-projects.test.ts`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Export from the package barrel**

```ts
// packages/activities/src/index.ts -- add this line
export * from './resolve-managed-projects';
```

- [ ] **Step 6: Typecheck and test the whole package**

Run: `pnpm --filter @agentops/activities run typecheck && pnpm test -- packages/activities`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/activities
git commit -m "feat(activities): add DB-first project resolution with static-registry fallback"
```

---

### Task 5: Rename `agent_run_stats` → `agentops_engine`

**Files:**
- Modify: `packages/worker/src/main.ts:237-252` (`buildStatsStore`)
- Modify: `charts/engine/values.yaml` (`agentStatsDb` block)
- Modify: `charts/engine/templates/deployment.yaml` (env var block)

This is the database rename from `docs/superpowers/specs/2026-07-08-managed-project-registry-design.md` §4.2 — done now because `managed_projects` (Task 6 onward) lands in this same database, and naming it after one table (`agent_run_stats`) was already a mismatch.

- [ ] **Step 1: Rename the env vars and default database name in `buildStatsStore`**

```ts
// packages/worker/src/main.ts -- replace the existing buildStatsStore function (currently lines 237-252)
export async function buildStatsStore(): Promise<StatsStore> {
  const host = process.env.ENGINE_DB_HOST;
  if (!host) {
    return new InMemoryStatsStore();
  }
  const pool = new Pool({
    host,
    port: process.env.ENGINE_DB_PORT ? Number(process.env.ENGINE_DB_PORT) : 5432,
    database: process.env.ENGINE_DB_NAME ?? 'agentops_engine',
    user: process.env.ENGINE_DB_USER ?? 'temporal',
    password: process.env.ENGINE_DB_PASSWORD,
  });
  const store = new PostgresStatsStore(pool);
  await store.ensureSchema();
  return store;
}
```

- [ ] **Step 2: Update the two log lines in `main()` that reference the old env var name**

```ts
// packages/worker/src/main.ts -- in main(), replace the stats-store log block
const stats = await buildStatsStore();
console.log(
  stats instanceof PostgresStatsStore
    ? 'agentops worker: agent_run_stats persisted to Postgres (ENGINE_DB_HOST set)'
    : 'agentops worker: agent_run_stats in-memory only (ENGINE_DB_HOST not set)',
);
```

- [ ] **Step 3: Rename the chart value block**

```yaml
# charts/engine/values.yaml -- replace the `agentStatsDb:` block (originally at lines 30-40)
# Host empty by default -- same "chart ships no cluster assumption" pattern as
# otelExporterOtlpEndpoint above. agentops-platform's values override sets
# the real host once the agentops_engine database exists there.
# Password comes from the same postgres-credentials secret Temporal already
# uses (shared Postgres instance, separate database, per ARCHITECTURE.md §5.2).
# Named after the engine, not "agent_run_stats" -- it also holds
# managed_projects (see docs/superpowers/specs/2026-07-08-managed-project-registry-design.md).
engineDb:
  host: ""
  port: "5432"
  name: agentops_engine
  user: temporal
  passwordSecretName: postgres-credentials
```

- [ ] **Step 4: Rename the env vars in the worker Deployment template**

```bash
grep -n "AGENT_STATS_DB\|agentStatsDb" charts/engine/templates/deployment.yaml
```

Expected: 5 lines (`AGENT_STATS_DB_HOST/PORT/NAME/USER/PASSWORD`, all reading from `.Values.agentStatsDb.*`). Replace that whole block:

```yaml
            {{- if .Values.engineDb.host }}
            - name: ENGINE_DB_HOST
              value: {{ .Values.engineDb.host | quote }}
            - name: ENGINE_DB_PORT
              value: {{ .Values.engineDb.port | quote }}
            - name: ENGINE_DB_NAME
              value: {{ .Values.engineDb.name | quote }}
            - name: ENGINE_DB_USER
              value: {{ .Values.engineDb.user | quote }}
            - name: ENGINE_DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.engineDb.passwordSecretName }}
                  key: password
            {{- end }}
```

(Use `sed -i '' 's/AGENT_STATS_DB/ENGINE_DB/g; s/agentStatsDb/engineDb/g' charts/engine/templates/deployment.yaml` to apply this mechanically if the surrounding lines match exactly — verify with `git diff` afterward that only this block changed.)

- [ ] **Step 5: Typecheck and test**

Run: `pnpm --filter @agentops/worker run typecheck && pnpm test -- packages/worker`
Expected: both PASS (no existing test references `AGENT_STATS_DB_*` directly, confirmed by inspection before writing this plan).

Run: `helm lint charts/engine && bash charts/engine/tests/run.sh`
Expected: both PASS.

- [ ] **Step 6: Note the cross-repo manual step (do not attempt from here)**

`agentops-platform`'s `clusters/ops/engine/values.yaml` has the matching `agentStatsDb.host` value pointing at the live database, and `clusters/ops/platform/postgres/initdb-configmap.yaml` creates `agent_run_stats` for fresh installs. Both need the same rename in a separate `agentops-platform` PR, and the **live** database needs a one-time manual `ALTER DATABASE agent_run_stats RENAME TO agentops_engine;` via `kubectl exec` before that PR's values change takes effect — document this in that PR's description, do not execute it from this session (it's a live shared cluster, not something to script speculatively here).

- [ ] **Step 7: Commit**

```bash
git add packages/worker charts/engine
git commit -m "refactor: rename agent_run_stats database to agentops_engine"
```

---

### Task 6: `packages/worker` — merge the DB registry at boot

**Files:**
- Modify: `packages/worker/src/main.ts`
- Test: `packages/worker/src/main.test.ts`
- Modify: `charts/engine/values.yaml`
- Modify: `charts/engine/templates/deployment.yaml`

**Why boot-time, not per-request:** `buildActivityDependencies` (line 55) builds one `ScmPort`/`TrackerPort` per registered repo up front and hands them to `createProjectScopedPorts`, which is a synchronous `Map`-backed dispatcher — retrofitting it to fall back to an async DB call per repo would touch `packages/ports`' dispatcher contract and every caller of it. Merging DB-registered repos into the same array the static registry already produces gets the same practical outcome (a task can run against a DB-only repo) with far less risk, at the cost of a worker restart being needed to pick up a *newly*-added DB registration (same limitation the static registry already has today).

- [ ] **Step 1: Write the failing test** for the new merge function

```ts
// packages/worker/src/main.test.ts -- add this describe block (imports below assume they're merged with the file's existing imports)
import { mergeStaticAndManagedRegistries } from './main';

describe('mergeStaticAndManagedRegistries', () => {
  it('returns the static registry unchanged when there are no managed projects', () => {
    const staticEntry = { project: 'legacy', repo: 'acme/legacy', trackerType: 'github' as const, tokenEnvVar: 'X', token: 'static' };
    expect(mergeStaticAndManagedRegistries([staticEntry], [])).toEqual([staticEntry]);
  });

  it('includes managed projects alongside distinct static entries', () => {
    const staticEntry = { project: 'legacy', repo: 'acme/legacy', trackerType: 'github' as const, tokenEnvVar: 'X', token: 'static' };
    const managedEntry = { project: 'acme-web', repo: 'acme/web', trackerType: 'github' as const, tokenEnvVar: 'Y', token: 'db' };
    const merged = mergeStaticAndManagedRegistries([staticEntry], [managedEntry]);
    expect(merged).toHaveLength(2);
    expect(merged).toEqual(expect.arrayContaining([staticEntry, managedEntry]));
  });

  it('lets a managed project win over a static entry for the same repo', () => {
    const staticEntry = { project: 'old-name', repo: 'acme/web', trackerType: 'github' as const, tokenEnvVar: 'X', token: 'static' };
    const managedEntry = { project: 'acme-web', repo: 'acme/web', trackerType: 'github' as const, tokenEnvVar: 'Y', token: 'db' };
    const merged = mergeStaticAndManagedRegistries([staticEntry], [managedEntry]);
    expect(merged).toEqual([managedEntry]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/worker/src/main.test.ts -t mergeStaticAndManagedRegistries`
Expected: FAIL — `mergeStaticAndManagedRegistries is not exported`.

- [ ] **Step 3: Add the merge function and wire it into `main()`**

```ts
// packages/worker/src/main.ts -- add this import alongside the existing @agentops/activities import block
import {
  createActivities,
  InMemoryStageResultStore,
  InMemoryStatsStore,
  loadEnv,
  loadManagedProjectRegistry,
  loadProjectRegistry,
  MemoryWorkspaceManager,
  PostgresManagedProjectStore,
  PostgresStatsStore,
  SpawnGitCommandRunner,
  WorkspaceManager,
  type ManagedProjectRegistryDeps,
  type StatsStore,
  type Workspaces,
} from '@agentops/activities';
```

```ts
// packages/worker/src/main.ts -- add this function near buildActivityDependencies (after it, before buildJobRunnerOptions is fine)
/**
 * DB-registered projects take precedence over a static entry for the same
 * repo (docs/superpowers/specs/2026-07-08-managed-project-registry-design.md
 * §6) -- filter the static list down to repos the managed registry doesn't
 * already cover, then put managed entries first for readability in logs.
 */
export function mergeStaticAndManagedRegistries(
  staticRegistry: ResolvedProjectEntry[],
  managedRegistry: ResolvedProjectEntry[],
): ResolvedProjectEntry[] {
  const managedRepos = new Set(managedRegistry.map((entry) => entry.repo));
  return [...managedRegistry, ...staticRegistry.filter((entry) => !managedRepos.has(entry.repo))];
}

function buildManagedProjectDeps(pool: Pool | undefined): ManagedProjectRegistryDeps | undefined {
  const privateKey = process.env.PROJECT_CREDENTIAL_PRIVATE_KEY;
  if (!pool || !privateKey) {
    return undefined;
  }
  return { store: new PostgresManagedProjectStore(pool), privateKey };
}
```

```ts
// packages/worker/src/main.ts -- in main(), replace:
//   const registry = loadProjectRegistry();
// with:
  const staticRegistry = loadProjectRegistry();
  const enginePool = process.env.ENGINE_DB_HOST
    ? new Pool({
        host: process.env.ENGINE_DB_HOST,
        port: process.env.ENGINE_DB_PORT ? Number(process.env.ENGINE_DB_PORT) : 5432,
        database: process.env.ENGINE_DB_NAME ?? 'agentops_engine',
        user: process.env.ENGINE_DB_USER ?? 'temporal',
        password: process.env.ENGINE_DB_PASSWORD,
      })
    : undefined;
  const managedProjectDeps = buildManagedProjectDeps(enginePool);
  if (managedProjectDeps) {
    await managedProjectDeps.store.ensureSchema();
  }
  const managedRegistry = managedProjectDeps ? await loadManagedProjectRegistry(managedProjectDeps) : [];
  const registry = mergeStaticAndManagedRegistries(staticRegistry, managedRegistry);
```

This constructs a second `Pool` to the same `agentops_engine` database (separate from `buildStatsStore`'s own pool) rather than sharing one — a deliberate simplicity choice: two small connection pools to one low-traffic admin database costs nothing meaningful, and avoids changing `buildStatsStore`'s existing signature/tests.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/worker/src/main.test.ts`
Expected: PASS, all tests green including the 3 new ones.

- [ ] **Step 5: Add the new chart values and env var**

```yaml
# charts/engine/values.yaml -- add near engineDb (Task 5's block)
# Base64 PKCS8 DER private key for decrypting managed-project credentials
# (docs/superpowers/specs/2026-07-08-managed-project-registry-design.md §5).
# Empty by default -- unset means the worker/gateway/cli fall through to the
# static PROJECT_REGISTRY_JSON registry only, same "off by default" pattern
# as engineDb.host above. Generate with credential-crypto's
# generateManagedProjectKeyPair() and store the private half SOPS-encrypted.
projectCredentialPrivateKeySecretName: ""
```

```yaml
# charts/engine/templates/deployment.yaml -- add inside the same {{- if .Values.engineDb.host }} block from Task 5, after ENGINE_DB_PASSWORD
            {{- if .Values.projectCredentialPrivateKeySecretName }}
            - name: PROJECT_CREDENTIAL_PRIVATE_KEY
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.projectCredentialPrivateKeySecretName }}
                  key: privateKey
            {{- end }}
```

- [ ] **Step 6: Update the LIVE-mode log line to reflect the merged registry**

```bash
grep -n "LIVE mode" packages/worker/src/main.ts
```

Confirm it still reads correctly against the renamed `registry` variable (it already iterates `registry`, which now includes merged DB entries — no code change needed here, just confirm by reading it that nothing references the old `staticRegistry`-only variable by mistake).

- [ ] **Step 7: Typecheck and test**

Run: `pnpm --filter @agentops/worker run typecheck && pnpm test -- packages/worker`
Expected: both PASS.

Run: `helm lint charts/engine && bash charts/engine/tests/run.sh`
Expected: both PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/worker charts/engine
git commit -m "feat(worker): merge DB-registered projects into the registry at boot"
```

---

### Task 7: `packages/cli` — DB-first resolution

**Files:**
- Modify: `packages/cli/package.json` (add `pg`, `@types/pg`)
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/main.test.ts`

- [ ] **Step 1: Add the `pg` dependency**

```bash
cd packages/cli
pnpm add pg@^8.22.0
pnpm add -D @types/pg@^8.20.0
cd ../..
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/cli/src/main.test.ts -- add this describe block (adjust the existing import line for buildStartScmPort to also import the new function if it's in the same import statement)
import { buildStartScmPortWithManagedProjects } from './main';
import { encryptForManagedProject, generateManagedProjectKeyPair } from '@agentops/activities';

describe('buildStartScmPortWithManagedProjects', () => {
  it('builds a GithubScmPort from a DB-registered project when the static registry has nothing', async () => {
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const store = {
      async get(repo: string) {
        return repo === 'acme/web' ? { id: '1', project: 'acme-web', repo, credentialSet: true, config: null, createdAt: '', updatedAt: '' } : null;
      },
      async getEncryptedToken(repo: string) {
        return repo === 'acme/web' ? encryptForManagedProject(publicKey, 'db-token') : null;
      },
    } as any;

    const scm = await buildStartScmPortWithManagedProjects({ store, privateKey }, [], 'acme-web', 'acme/web');

    expect(scm).toBeDefined(); // real assertion: doesn't throw "no project registered", proving the DB path was used
  });

  it('falls back to the static registry when the repo is not DB-managed', async () => {
    const registry = [{ project: 'legacy', repo: 'acme/legacy', trackerType: 'github' as const, tokenEnvVar: 'X', token: 'static-token' }];
    const store = { async get() { return null; }, async getEncryptedToken() { return null; } } as any;

    const scm = await buildStartScmPortWithManagedProjects({ store, privateKey: 'unused' }, registry, 'legacy', 'acme/legacy');

    expect(scm).toBeDefined();
  });

  it('throws when neither the DB nor the static registry has the repo', async () => {
    const store = { async get() { return null; }, async getEncryptedToken() { return null; } } as any;
    await expect(buildStartScmPortWithManagedProjects({ store, privateKey: 'unused' }, [], 'nope', 'acme/nope')).rejects.toThrow(
      /no project registered/,
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test -- packages/cli/src/main.test.ts -t buildStartScmPortWithManagedProjects`
Expected: FAIL — `buildStartScmPortWithManagedProjects is not exported`.

- [ ] **Step 4: Add the DB-aware wrapper and wire it into `cmdStart`**

```ts
// packages/cli/src/main.ts -- add to the existing @agentops/activities import
import {
  loadEnv,
  loadProjectConfig,
  loadProjectRegistry,
  resolveManagedProjectEntry,
  SpawnGitCommandRunner,
  type ManagedProjectRegistryDeps,
} from '@agentops/activities';
```

```ts
// packages/cli/src/main.ts -- add after buildStartScmPort
/**
 * DB-first variant of buildStartScmPort: tries the managed-project registry
 * before the static one. `managedProjectDeps` is undefined when
 * ENGINE_DB_HOST/PROJECT_CREDENTIAL_PRIVATE_KEY aren't set -- falls straight
 * through to today's behavior in that case.
 */
export async function buildStartScmPortWithManagedProjects(
  managedProjectDeps: ManagedProjectRegistryDeps | undefined,
  registry: ResolvedProjectEntry[],
  project: string,
  repo: string,
): Promise<ScmPort> {
  if (registry.length === 0 && !managedProjectDeps) {
    const scm = new MemoryScmPort();
    seedDemoAgentopsConfig(scm, repo);
    return scm;
  }
  const entry = await resolveManagedProjectEntry(managedProjectDeps, registry, repo);
  if (!entry) {
    throw new Error(`no project registered for repo "${repo}" — check the project registry`);
  }
  if (entry.project !== project) {
    throw new Error(`repo "${repo}" is registered under project "${entry.project}", not "${project}" — check --project`);
  }
  const git = new SpawnGitCommandRunner({ authToken: () => entry.token });
  return createGithubPorts(entry.token, git).scm;
}
```

```ts
// packages/cli/src/main.ts -- add near the top of the file, after loadEnv()
import { PostgresManagedProjectStore } from '@agentops/activities';
import { Pool } from 'pg';

function buildCliManagedProjectDeps(): ManagedProjectRegistryDeps | undefined {
  const host = process.env.ENGINE_DB_HOST;
  const privateKey = process.env.PROJECT_CREDENTIAL_PRIVATE_KEY;
  if (!host || !privateKey) {
    return undefined;
  }
  const pool = new Pool({
    host,
    port: process.env.ENGINE_DB_PORT ? Number(process.env.ENGINE_DB_PORT) : 5432,
    database: process.env.ENGINE_DB_NAME ?? 'agentops_engine',
    user: process.env.ENGINE_DB_USER ?? 'temporal',
    password: process.env.ENGINE_DB_PASSWORD,
  });
  return { store: new PostgresManagedProjectStore(pool), privateKey };
}
```

```ts
// packages/cli/src/main.ts -- replace cmdStart's body
async function cmdStart(taskId: string, goal: string, project: string, repo: string, issueRef?: string): Promise<void> {
  const client = await getClient();
  const scm = await buildStartScmPortWithManagedProjects(buildCliManagedProjectDeps(), loadProjectRegistry(), project, repo);
  const config = await loadProjectConfig(scm, repo);
  const input: TaskInput = { taskId, project, repo, issueRef, goal, config };
  const handle = await client.workflow.start(devCycle, { taskQueue: TASK_QUEUE, workflowId: taskId, args: [input] });
  console.log(`started ${handle.workflowId}`);
}
```

Leave `buildStartScmPort`/`resolveProjectEntry` in place unchanged (existing tests still cover the static-only path directly) — `buildStartScmPortWithManagedProjects` is the new entry point `cmdStart` actually calls.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- packages/cli/src/main.test.ts`
Expected: PASS, all tests green including the 3 new ones.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @agentops/cli run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): resolve DB-registered projects before falling back to the static registry"
```

---

### Task 8: `packages/gateway` — DB-first resolution

**Files:**
- Modify: `packages/gateway/package.json` (add `pg`, `@types/pg`)
- Modify: `packages/gateway/src/create-gateway-server.ts`
- Modify: `packages/gateway/src/create-gateway-server.test.ts`
- Modify: `packages/gateway/src/main.ts`
- Modify: `charts/engine/templates/gateway-deployment.yaml`

- [ ] **Step 1: Add the `pg` dependency**

```bash
cd packages/gateway
pnpm add pg@^8.22.0
pnpm add -D @types/pg@^8.20.0
cd ../..
```

- [ ] **Step 2: Write the failing test**

This file already defines module-level `sign(body)`, `labeledPayload(overrides)`, and `post(port, path, body, headers)` helpers (used by every existing test below `describe('createGatewayServer', ...)`) — reused verbatim here via a second, sibling `describe` block with its own `beforeEach`, so the shared registry-populated setup above isn't disturbed:

```ts
// packages/gateway/src/create-gateway-server.test.ts -- add this whole new describe block, as a sibling to the existing describe('createGatewayServer', ...) block, after it in the file. Add `encryptForManagedProject, generateManagedProjectKeyPair` to this file's existing @agentops/activities import if one exists, or add a new import line for them.
import { encryptForManagedProject, generateManagedProjectKeyPair } from '@agentops/activities';

describe('createGatewayServer with a managed-project registry', () => {
  let server: ReturnType<typeof createGatewayServer>;
  let port: number;
  let start: ReturnType<typeof vi.fn>;
  let privateKey: string;

  beforeEach(async () => {
    start = vi.fn().mockResolvedValue(undefined);
    const keyPair = generateManagedProjectKeyPair();
    privateKey = keyPair.privateKey;
    const registeredScm = new MemoryScmPort();
    const managedProjectDeps = {
      store: {
        async get(repo: string) {
          return repo === 'octocat/hello-world'
            ? { id: '1', project: 'my-project', repo, credentialSet: true, config: null, createdAt: '', updatedAt: '' }
            : null;
        },
        async getEncryptedToken(repo: string) {
          return repo === 'octocat/hello-world' ? encryptForManagedProject(keyPair.publicKey, 'db-token') : null;
        },
      } as never,
      privateKey,
    };
    const deps: GatewayDeps = {
      client: { workflow: { start } } as never,
      taskQueue: 'agentops-devcycle',
      webhookSecret: SECRET,
      triggerLabel: TRIGGER_LABEL,
      registry: [], // deliberately empty -- proves the DB path resolved this, not the static one
      buildScm: () => registeredScm,
      managedProjectDeps,
    };
    server = createGatewayServer(deps);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(() => {
    server.close();
  });

  it('starts devCycle for a repo that only the DB registry has, not the static one', async () => {
    const body = JSON.stringify(labeledPayload());
    const res = await post(port, '/webhooks/github', body, {
      'content-type': 'application/json',
      'x-github-event': 'issues',
      'x-hub-signature-256': sign(body),
    });
    expect(res.status).toBe(202);
    expect(start).toHaveBeenCalledTimes(1);
    const [, options] = start.mock.calls[0];
    expect(options.args[0]).toMatchObject({ project: 'my-project', repo: 'octocat/hello-world', goal: 'Add a widget' });
  });

  it('still falls through to "no project registered" for a repo neither source has', async () => {
    const body = JSON.stringify(labeledPayload({ repository: { full_name: 'octocat/unregistered' } }));
    const res = await post(port, '/webhooks/github', body, {
      'content-type': 'application/json',
      'x-github-event': 'issues',
      'x-hub-signature-256': sign(body),
    });
    expect(res.status).toBe(202);
    expect(start).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test -- packages/gateway/src/create-gateway-server.test.ts`
Expected: FAIL — `managedProjectDeps` doesn't exist on `GatewayDeps` yet (TypeScript error) or the request resolves via the empty static registry and returns "no project registered" instead of 202.

- [ ] **Step 4: Add `managedProjectDeps` to `GatewayDeps` and use it in `handleRequest`**

```ts
// packages/gateway/src/create-gateway-server.ts -- replace the imports and GatewayDeps interface
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Client } from '@temporalio/client';
import { loadProjectConfig, resolveManagedProjectEntry, type ManagedProjectRegistryDeps } from '@agentops/activities';
import type { ResolvedProjectEntry } from '@agentops/contracts';
import type { ScmPort } from '@agentops/ports';
import { parseIssueLabeledEvent } from './parse-issue-labeled';
import { startDevCycleForIssue } from './start-dev-cycle';
import { verifyGithubSignature } from './verify-signature';

export interface GatewayDeps {
  client: Client;
  taskQueue: string;
  webhookSecret: string;
  triggerLabel: string;
  registry: ResolvedProjectEntry[];
  // Injectable so tests don't need a live GitHub client — the real caller
  // (main.ts) builds a GithubScmPort from the entry's token.
  buildScm: (entry: ResolvedProjectEntry) => ScmPort;
  // Undefined when ENGINE_DB_HOST/PROJECT_CREDENTIAL_PRIVATE_KEY aren't set —
  // every lookup falls through to `registry` only, same as before this field existed.
  managedProjectDeps?: ManagedProjectRegistryDeps;
}
```

```ts
// packages/gateway/src/create-gateway-server.ts -- replace the body of handleRequest from "const entry = deps.registry.find(...)" through the end of the try block
  const entry = await resolveManagedProjectEntry(deps.managedProjectDeps, deps.registry, event.repo);
  if (!entry) {
    console.warn(`gateway: no project registered for repo "${event.repo}" — ignoring labeled event`);
    res.writeHead(202).end('no project registered for this repo');
    return;
  }

  try {
    const scm = deps.buildScm(entry);
    const config = await loadProjectConfig(scm, entry.repo);
    const result = await startDevCycleForIssue(deps.client, deps.taskQueue, entry.project, event, config);
    console.log(
      result.started
        ? `gateway: started devCycle ${result.taskId} for ${event.issueRef}`
        : `gateway: devCycle ${result.taskId} already running for ${event.issueRef} — ignored duplicate label event`,
    );
    res.writeHead(202).end(JSON.stringify(result));
  } catch (err) {
    console.error(`gateway: failed to start devCycle for ${event.issueRef}:`, err);
    res.writeHead(500).end('failed to start task');
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- packages/gateway/src/create-gateway-server.test.ts`
Expected: PASS, including the new test and every pre-existing one (the static-registry path is unchanged behaviorally — `resolveManagedProjectEntry` with `managedProjectDeps: undefined` falls straight through to `deps.registry.find`, identical to the old code).

- [ ] **Step 6: Wire the new deps into `packages/gateway/src/main.ts`**

```ts
// packages/gateway/src/main.ts
import { Client, Connection } from '@temporalio/client';
import { loadEnv, loadProjectRegistry, PostgresManagedProjectStore, SpawnGitCommandRunner, type ManagedProjectRegistryDeps } from '@agentops/activities';
import type { ResolvedProjectEntry } from '@agentops/contracts';
import { createGithubPorts } from '@agentops/ports';
import { Pool } from 'pg';
import { createGatewayServer } from './create-gateway-server';

loadEnv();

const TASK_QUEUE = 'agentops-devcycle';

function buildScm(entry: ResolvedProjectEntry) {
  const git = new SpawnGitCommandRunner({ authToken: () => entry.token });
  return createGithubPorts(entry.token, git).scm;
}

function buildGatewayManagedProjectDeps(): ManagedProjectRegistryDeps | undefined {
  const host = process.env.ENGINE_DB_HOST;
  const privateKey = process.env.PROJECT_CREDENTIAL_PRIVATE_KEY;
  if (!host || !privateKey) {
    return undefined;
  }
  const pool = new Pool({
    host,
    port: process.env.ENGINE_DB_PORT ? Number(process.env.ENGINE_DB_PORT) : 5432,
    database: process.env.ENGINE_DB_NAME ?? 'agentops_engine',
    user: process.env.ENGINE_DB_USER ?? 'temporal',
    password: process.env.ENGINE_DB_PASSWORD,
  });
  return { store: new PostgresManagedProjectStore(pool), privateKey };
}

async function main(): Promise<void> {
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error('GITHUB_WEBHOOK_SECRET is required');
  }

  const registry = loadProjectRegistry();
  console.log(
    registry.length > 0
      ? `agentops gateway: ${registry.length} project(s) registered: ${registry.map((e) => `${e.project} (${e.repo})`).join(', ')}`
      : 'agentops gateway: no PROJECT_REGISTRY_JSON set — every webhook will be acknowledged and ignored',
  );

  const managedProjectDeps = buildGatewayManagedProjectDeps();
  if (managedProjectDeps) {
    await managedProjectDeps.store.ensureSchema();
    console.log('agentops gateway: managed-project DB lookup ENABLED (ENGINE_DB_HOST set)');
  }

  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE });

  const server = createGatewayServer({
    client,
    taskQueue: TASK_QUEUE,
    webhookSecret,
    triggerLabel: process.env.TRIGGER_LABEL ?? 'agentops',
    registry,
    buildScm,
    managedProjectDeps,
  });

  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => {
    console.log(`agentops gateway listening on :${port}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 7: Add the gateway's chart env vars**

```yaml
# charts/engine/templates/gateway-deployment.yaml -- add alongside the existing PROJECT_REGISTRY_JSON env entry
            {{- if .Values.engineDb.host }}
            - name: ENGINE_DB_HOST
              value: {{ .Values.engineDb.host | quote }}
            - name: ENGINE_DB_PORT
              value: {{ .Values.engineDb.port | quote }}
            - name: ENGINE_DB_NAME
              value: {{ .Values.engineDb.name | quote }}
            - name: ENGINE_DB_USER
              value: {{ .Values.engineDb.user | quote }}
            - name: ENGINE_DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.engineDb.passwordSecretName }}
                  key: password
            {{- end }}
            {{- if .Values.projectCredentialPrivateKeySecretName }}
            - name: PROJECT_CREDENTIAL_PRIVATE_KEY
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.projectCredentialPrivateKeySecretName }}
                  key: privateKey
            {{- end }}
```

(The gateway didn't have any Postgres access before this task — this is new surface for it, worth noting in the PR description, though it's read-only from the gateway's perspective, same trust level as the credentials it already resolves from the static registry today.)

- [ ] **Step 8: Typecheck, test, and render the chart**

Run: `pnpm --filter @agentops/gateway run typecheck && pnpm test -- packages/gateway`
Expected: both PASS.

Run: `helm lint charts/engine && bash charts/engine/tests/run.sh`
Expected: both PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/gateway charts/engine
git commit -m "feat(gateway): resolve DB-registered projects before falling back to the static registry"
```

---

### Task 9: Full-repo verification and a manual end-to-end smoke test

**Files:** none (verification only).

- [ ] **Step 1: Full lint, typecheck, test, e2e**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e
```

Expected: all PASS.

- [ ] **Step 2: Helm chart verification**

```bash
helm lint charts/engine && bash charts/engine/tests/run.sh
```

Expected: both PASS.

- [ ] **Step 3: Manual smoke test against a local Postgres**

There's no admin API yet (that's Plan 2), so registering a test project means calling the crypto + store functions directly. This also doubles as a real end-to-end proof the whole chain works, not just its unit tests:

```bash
# Start a local Postgres if one isn't already running, e.g.:
docker run --rm -d --name agentops-engine-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16

cat <<'EOF' > /tmp/seed-managed-project.mjs
import { generateManagedProjectKeyPair, encryptForManagedProject, PostgresManagedProjectStore } from '@agentops/activities';
import { Pool } from 'pg';

const pool = new Pool({ host: 'localhost', port: 5432, database: 'postgres', user: 'postgres', password: 'postgres' });
const store = new PostgresManagedProjectStore(pool);
await store.ensureSchema();

const { publicKey, privateKey } = generateManagedProjectKeyPair();
await store.upsert({ project: 'smoke-test', repo: 'octocat/hello-world', token: 'fake-token-for-smoke-test' }, publicKey);

console.log('PROJECT_CREDENTIAL_PRIVATE_KEY=' + privateKey);
console.log('registered:', await store.get('octocat/hello-world'));
await pool.end();
EOF
node --experimental-vm-modules /tmp/seed-managed-project.mjs
```

Expected output: a `PROJECT_CREDENTIAL_PRIVATE_KEY=...` line and `registered: { project: 'smoke-test', repo: 'octocat/hello-world', credentialSet: true, config: null, ... }`.

- [ ] **Step 4: Confirm the worker picks it up**

```bash
ENGINE_DB_HOST=localhost ENGINE_DB_NAME=postgres ENGINE_DB_USER=postgres ENGINE_DB_PASSWORD=postgres \
  PROJECT_CREDENTIAL_PRIVATE_KEY=<paste the value printed above> \
  pnpm --filter @agentops/worker run start 2>&1 | head -20
```

Expected: a log line reading `agentops worker: LIVE mode — 1 project(s) registered: smoke-test (octocat/hello-world) — ...` — proving `loadManagedProjectRegistry` successfully queried Postgres, decrypted the token, and merged it into the registry the worker logs at boot. Stop the worker (`Ctrl-C`) once confirmed; this was a manual smoke test, not something to leave running.

- [ ] **Step 5: Clean up**

```bash
docker stop agentops-engine-pg
rm /tmp/seed-managed-project.mjs
```

- [ ] **Step 6: Confirm the diff is scoped as described**

```bash
git diff main --stat
```

Skim the full diff once more: new files in `packages/contracts` and `packages/activities`, the `agent_run_stats`→`agentops_engine` rename in `packages/worker`/`charts/engine`, and the DB-first resolution changes in `packages/cli`/`packages/gateway`/`packages/worker`. Nothing in `packages/control` should appear — that's Plan 2.

---

### Task 10: Open the PR, pass CI, and resolve the Bugbot review

**Files:** none (integration / review).

> Sequential and partly asynchronous — CI and Bugbot run on the remote PR.
> **HARD GATE: Do not mark this task complete until ALL Bugbot comments are
> resolved (fixed or replied to) AND CI is green. Check with
> `gh pr view --json reviews,comments` before claiming done.**
>
> Repo-specific note: per [[reference_bugbot_inactive_agentops]], Bugbot has
> historically never responded on this repo's PRs despite retriggers — if
> `gh pr comment --body "bugbot run"` produces no review after a reasonable
> wait, don't block indefinitely on Step 5/6; note in the PR that Bugbot
> didn't respond, consistent with prior PRs here, and proceed once CI is
> green and a subagent code review (Step 3) is clean.
>
> Also note: merging to `main` on this repo auto-builds and pushes 3 Docker
> images and auto-pushes a tag-bump commit directly to `agentops-platform`
> main (no PR gate on that side — see `.github/workflows/ci.yaml`'s
> `bump-platform` job), which ArgoCD then syncs into the live `dev-agents`
> cluster. Since this PR adds a new required manual step of its own (the
> `agentops-platform` database rename from Task 5, Step 6) that must land
> *before* this merges — sequence that first, confirm the renamed database
> exists live, then merge this PR, not the other way around.

- [ ] **Step 1: Sync the latest `main`**

```bash
git fetch origin
git merge origin/main
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e && helm lint charts/engine && bash charts/engine/tests/run.sh
```

Resolve conflicts + commit first if any, then fix any fallout from the merge.

- [ ] **Step 2: Push and open the PR**

```bash
git status --short && git rev-parse --abbrev-ref HEAD   # clean tree, on feature branch (not main)
git push -u origin HEAD
gh pr create --repo est1908-agentic-ops/agentops-engine --base main --fill \
  --title "feat: DB-backed managed project registry (data layer)"
```

- [ ] **Step 3: Subagent code review**

REQUIRED SUB-SKILL: `requesting-code-review`. Dispatch a code reviewer subagent over the diff (BASE_SHA = merge-base with `main`, HEAD_SHA = HEAD). Fix Critical and Important findings, commit, push, then proceed. Pay particular attention to any finding touching `credential-crypto.ts` or `postgres-managed-project-store.ts` — this PR's actual security property (control can encrypt but never decrypt) depends on those two files being correct.

- [ ] **Step 4: Make every CI check pass**

```bash
gh pr checks --repo est1908-agentic-ops/agentops-engine --watch
```

On failure: `gh run view --repo est1908-agentic-ops/agentops-engine --log-failed`, reproduce locally, fix, commit, push, re-watch. Do not proceed while red.

- [ ] **Step 5: Wait for the Bugbot review**

```bash
gh pr view --repo est1908-agentic-ops/agentops-engine --json reviews,comments
gh pr comment --repo est1908-agentic-ops/agentops-engine --body "bugbot run"   # only if it hasn't reviewed yet
```

- [ ] **Step 6: Address each Bugbot comment**

REQUIRED SUB-SKILL: `receiving-code-review`. Verify before acting — reply to false positives; TDD-fix real findings, commit each referencing the finding, push once.

**Then mark each addressed thread resolved** (completion is gated on the unresolved-thread count, not just on having replied/fixed):

```bash
gh api graphql -f query='query($o:String!,$r:String!,$p:Int!){repository(owner:$o,name:$r){pullRequest(number:$p){reviewThreads(first:100){nodes{id isResolved path comments(first:1){nodes{body}}}}}}}' -F o=est1908-agentic-ops -F r=agentops-engine -F p=<number>
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=<thread-id>
```

**After pushing:** return to Step 4 (re-watch CI), then Step 5 (wait for re-review). Loop until Bugbot reports no unresolved comments — or, per the repo-specific note above, it's confirmed non-responsive again.

- [ ] **Step 7: Final verification**

```bash
gh pr checks --repo est1908-agentic-ops/agentops-engine                          # all green
gh pr view --repo est1908-agentic-ops/agentops-engine --json reviews,comments    # no comment left unaddressed
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e && helm lint charts/engine && bash charts/engine/tests/run.sh   # suite green locally
```

Confirm no unresolved review threads remain, then mark this task complete. Do not merge as part of this task — the `agentops-platform` companion rename (Task 5, Step 6) needs to land first, and merging here also auto-deploys; leave that as a final, explicit human/operator decision.
