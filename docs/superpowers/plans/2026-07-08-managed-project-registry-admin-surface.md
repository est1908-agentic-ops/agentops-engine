# Managed Project Registry — Admin Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators register, rotate, and remove managed projects through an HTTP API + a `engine project` CLI — no raw SQL, no per-project Helm edit — and close the data-layer gap where a DB-registered project's stored `config` was ignored. This is Plan 2; Plan 1 (data layer: schema, crypto, store, DB-first token resolution) shipped on PR #7 and is the foundation this builds on.

**Architecture:** Five CRUD routes on `packages/control`'s existing `node:http` server, backed by the data layer's `PostgresManagedProjectStore`. The security boundary from the design (§5) is enforced structurally: `control` imports the store **and only the store**, constructs it with the **public key** alone, and never imports `decryptForManagedProject` — so a compromise of control yields ciphertext control itself cannot read. A new `resolveProjectConfig` helper in `packages/activities` closes the config-resolution gap (design §6): when a managed project's DB `config` is non-null, use it directly; otherwise fall back to the existing in-repo `loadProjectConfig`. The CLI is a thin `fetch` client of the control API (`CONTROL_BASE_URL` + a bearer token). Auth: since GitHub issue #4 (Traefik basic-auth on control's ingress) is not landed, the `/api/projects` routes are gated behind an app-level bearer token (`CONTROL_CRUD_TOKEN`); with no token configured the routes return `503` and a loud startup warning. Issue #4 remains a documented merge prerequisite before the control ingress is exposed publicly.

**Tech Stack:** TypeScript, zod, `node:http`, `pg` (Postgres driver), Node's built-in `crypto` (via the data layer), vitest.

---

## Auth / merge-blocker decision (read before Task 3)

Design §7 calls control's ingress "no auth today" a **blocking prerequisite** for credential CRUD. GitHub issue #4 (Traefik basic-auth) is **not landed** (confirmed: no `basic-auth`/auth middleware anywhere in `charts/` or `packages/control`). This plan resolves the blocker with the option the task brief allows — **app-level bearer-token gating + a documented merge blocker** — rather than implementing Traefik middleware (a separate platform/chart concern that belongs to issue #4's own design):

- All five `/api/projects*` routes require `Authorization: Bearer <CONTROL_CRUD_TOKEN>`. Wrong/missing → `401`.
- With no `CONTROL_CRUD_TOKEN` (or no public key / no DB) configured, the routes return `503` and control logs a loud warning at boot.
- The chart's control ingress stays `enabled: false` by default (already the case). **Do not enable the control ingress publicly without issue #4.** Stated as an explicit prerequisite in Task 8.

This is defense-in-depth at the app layer plus the auth for the local/CLI path (`CONTROL_BASE_URL=http://localhost:3001`). It is deliberately **not** a substitute for issue #4.

---

## File structure

**Create:**
- `packages/contracts/src/control-projects-api.ts` — request/response zod schemas for the five routes.
- `packages/contracts/src/control-projects-api.test.ts` — schema tests (style of `control-api.test.ts`).
- `packages/activities/src/resolve-project-config.ts` — `resolveProjectConfig` helper (DB config vs file fallback).
- `packages/activities/src/resolve-project-config.test.ts` — its tests.

**Modify:**
- `packages/contracts/src/index.ts` — export the new schemas.
- `packages/activities/src/postgres-managed-project-store.ts` — add `getByProject` (for POST 409-on-duplicate-project).
- `packages/activities/src/postgres-managed-project-store.test.ts` — fake-DB branch + `getByProject` tests.
- `packages/activities/src/index.ts` — export `resolveProjectConfig`.
- `packages/control/src/create-control-server.ts` — five handlers + auth guard + `ControlDeps` fields + dispatch.
- `packages/control/src/create-control-server.test.ts` — handler tests mocking the store.
- `packages/control/src/main.ts` — build the store (public key + `pg` + `ENGINE_DB_*`), call `ensureSchema()`, wire crud token, warn.
- `packages/control/package.json` — add `pg` + `@types/pg`.
- `packages/gateway/src/create-gateway-server.ts` — use `resolveProjectConfig` for the config branch.
- `packages/gateway/src/create-gateway-server.test.ts` — config-branch tests (DB config used; null falls back to file).
- `packages/cli/src/main.ts` — `engine project add|list|show|update|remove` (HTTP client) + use `resolveProjectConfig` in `cmdStart`.
- `packages/cli/src/main.test.ts` — CLI HTTP-client tests mocking `fetch`.
- `charts/engine/templates/control-deployment.yaml` — `ENGINE_DB_*`, `PROJECT_CREDENTIAL_PUBLIC_KEY`, `CONTROL_CRUD_TOKEN` env.
- `charts/engine/values.yaml` — `projectCredentialPublicKey`, `projectCrudTokenSecretName` values.

**Responsibilities:** contracts = shapes only; activities = pure resolution helper + store read methods (no private key); control = encrypt-only CRUD over HTTP (never decrypts); gateway/cli = config-branch consumers + CLI client.

---

### Task 1: `packages/contracts` — the projects-API schemas

**Files:**
- Create: `packages/contracts/src/control-projects-api.ts`
- Test: `packages/contracts/src/control-projects-api.test.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/contracts/src/control-projects-api.test.ts
import { describe, expect, it } from 'vitest';
import {
  CreateManagedProjectRequestSchema,
  UpdateManagedProjectRequestSchema,
  ManagedProjectListResponseSchema,
} from './control-projects-api';

describe('CreateManagedProjectRequestSchema', () => {
  it('requires project, repo, and a non-empty token', () => {
    expect(() => CreateManagedProjectRequestSchema.parse({ project: 'acme-web', repo: 'acme/web', token: '' })).toThrow();
    expect(() => CreateManagedProjectRequestSchema.parse({ project: 'acme-web', repo: 'acme/web' })).toThrow();
  });

  it('accepts a minimal create body', () => {
    const parsed = CreateManagedProjectRequestSchema.parse({ project: 'acme-web', repo: 'acme/web', token: 'ghp_abc' });
    expect(parsed.config).toBeUndefined();
  });

  it('accepts an explicit null config to register file-based on create', () => {
    const parsed = CreateManagedProjectRequestSchema.parse({ project: 'acme-web', repo: 'acme/web', token: 'ghp_abc', config: null });
    expect(parsed.config).toBeNull();
  });

  it('accepts a full config object', () => {
    const config = {
      stages: {},
      routing: {},
      brakes: { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 },
    };
    const parsed = CreateManagedProjectRequestSchema.parse({ project: 'acme-web', repo: 'acme/web', token: 'ghp_abc', config });
    expect(parsed.config?.brakes.maxTokens).toBe(200_000);
  });
});

describe('UpdateManagedProjectRequestSchema', () => {
  it('allows an empty body (a no-op update)', () => {
    const parsed = UpdateManagedProjectRequestSchema.parse({});
    expect(parsed.token).toBeUndefined();
    expect(parsed.config).toBeUndefined();
  });

  it('accepts a token rotation', () => {
    expect(UpdateManagedProjectRequestSchema.parse({ token: 'ghp_new' }).token).toBe('ghp_new');
  });

  it('distinguishes null (clear config) from omitted (keep config)', () => {
    expect(UpdateManagedProjectRequestSchema.parse({ config: null }).config).toBeNull();
    expect(UpdateManagedProjectRequestSchema.parse({}).config).toBeUndefined();
  });

  it('rejects an empty token string', () => {
    expect(() => UpdateManagedProjectRequestSchema.parse({ token: '' })).toThrow();
  });

  it('has no project or repo field — those are immutable identity', () => {
    // Parsing extra keys does not error (zod strips them by default), but the
    // *type* carries no project/repo; assert the parsed result has none.
    const parsed = UpdateManagedProjectRequestSchema.parse({ project: 'sneaky', token: 'ghp_x' });
    expect((parsed as Record<string, unknown>).project).toBeUndefined();
  });
});

describe('ManagedProjectListResponseSchema', () => {
  it('parses a list of managed projects (no token field is present on items)', () => {
    const parsed = ManagedProjectListResponseSchema.parse([
      {
        id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
        project: 'acme-web',
        repo: 'acme/web',
        credentialSet: true,
        config: null,
        createdAt: '2026-07-08T12:00:00.000Z',
        updatedAt: '2026-07-08T12:00:00.000Z',
      },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].credentialSet).toBe(true);
    expect((parsed[0] as unknown as Record<string, unknown>).token).toBeUndefined();
    expect((parsed[0] as unknown as Record<string, unknown>).encryptedToken).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- packages/contracts/src/control-projects-api.test.ts`
Expected: FAIL — `Cannot find module './control-projects-api'`.

- [ ] **Step 3: Write the schemas**

```ts
// packages/contracts/src/control-projects-api.ts
import { z } from 'zod';
import { ManagedProjectSchema, ProjectConfigSchema } from './managed-project';

// POST /api/projects — create. `token` is required (you cannot create a
// managed project with no credential). `repo`/`project` are the identity.
export const CreateManagedProjectRequestSchema = z.object({
  project: z.string().min(1),
  repo: z.string().min(1),
  token: z.string().min(1),
  config: ProjectConfigSchema.nullable().optional(),
});
export type CreateManagedProjectRequest = z.infer<typeof CreateManagedProjectRequestSchema>;

// PUT /api/projects/:repo — update. `repo`/`project` are immutable identity
// (renaming either = delete + recreate), so neither appears in the body. A
// bare `{}` is a valid no-op; `token` rotates, `config: null` clears back to
// file-based, `config: <obj>` sets it, omitted `config` keeps it.
export const UpdateManagedProjectRequestSchema = z.object({
  token: z.string().min(1).optional(),
  config: ProjectConfigSchema.nullable().optional(),
});
export type UpdateManagedProjectRequest = z.infer<typeof UpdateManagedProjectRequestSchema>;

// GET /api/projects — list. Reuses ManagedProjectSchema, which carries
// `credentialSet: boolean` and never the token (design §7: no tokens, ever).
export const ManagedProjectListResponseSchema = z.array(ManagedProjectSchema);
export type ManagedProjectListResponse = z.infer<typeof ManagedProjectListResponseSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- packages/contracts/src/control-projects-api.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Export from the package barrel**

```ts
// packages/contracts/src/index.ts -- add this line (file is not sorted; place it after the existing './control-api' export)
export * from './control-projects-api';
```

- [ ] **Step 6: Typecheck and test the whole package**

Run: `pnpm --filter @agentops/contracts run typecheck && pnpm test -- packages/contracts`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): add managed-project CRUD API request/response schemas"
```

---

### Task 2: `packages/activities` — `getByProject` on the store + `resolveProjectConfig` helper

This task closes two gaps the control routes and the config branch need: (a) detecting a duplicate `project` slug on POST (the table's second unique column), and (b) the design §6 config branch as a reusable, unit-tested helper.

**Files:**
- Modify: `packages/activities/src/postgres-managed-project-store.ts`
- Modify: `packages/activities/src/postgres-managed-project-store.test.ts`
- Create: `packages/activities/src/resolve-project-config.ts`
- Test: `packages/activities/src/resolve-project-config.test.ts`
- Modify: `packages/activities/src/index.ts`

- [ ] **Step 1: Add the `getByProject` failing test** (append to the existing `describe('PostgresManagedProjectStore', ...)` block)

```ts
// packages/activities/src/postgres-managed-project-store.test.ts -- add inside the existing describe block
  it('looks up a project by its project slug', async () => {
    const store = new PostgresManagedProjectStore(createFakeDb());
    const { publicKey } = generateManagedProjectKeyPair();
    await store.upsert({ project: 'acme-web', repo: 'acme/web', token: 't1' }, publicKey);

    expect((await store.getByProject('acme-web'))?.repo).toBe('acme/web');
    expect(await store.getByProject('nope')).toBeNull();
  });
```

- [ ] **Step 2: Run the store test to verify it fails**

Run: `pnpm test -- packages/activities/src/postgres-managed-project-store.test.ts`
Expected: FAIL — `store.getByProject is not a function`.

- [ ] **Step 3: Implement `getByProject`** (add this method to the `PostgresManagedProjectStore` class, e.g. directly after the existing `get` method)

```ts
// packages/activities/src/postgres-managed-project-store.ts -- inside the class, after get()
  /** Lookup by the unique `project` slug -- used by control's POST to 409 on a duplicate project name. */
  async getByProject(project: string): Promise<ManagedProject | null> {
    const { rows } = await this.db.query('SELECT * FROM managed_projects WHERE project = $1', [project]);
    const row = rows[0] as ManagedProjectRow | undefined;
    return row ? rowToManagedProject(row) : null;
  }
```

- [ ] **Step 4: Teach the test's fake DB the new query** (the existing `createFakeDb` matches SQL by prefix; add the `WHERE project` branch **before** the existing `WHERE repo` branch is fine — they are mutually exclusive on the token after `WHERE`)

```ts
// packages/activities/src/postgres-managed-project-store.test.ts -- inside createFakeDb()'s query(), add this branch alongside the existing `WHERE repo` branch
      if (normalized.startsWith('SELECT * FROM managed_projects WHERE project')) {
        const [project] = params as [string];
        const found = rows.filter((r) => r.project === project);
        return { rows: found };
      }
```

- [ ] **Step 5: Run the store test to verify it passes**

Run: `pnpm test -- packages/activities/src/postgres-managed-project-store.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 6: Write the `resolveProjectConfig` failing test**

```ts
// packages/activities/src/resolve-project-config.test.ts
import { describe, expect, it } from 'vitest';
import { MemoryScmPort } from '@agentops/ports';
import { resolveProjectConfig } from './resolve-project-config';
import type { ManagedProjectRegistryDeps } from './resolve-managed-projects';
import type { PostgresManagedProjectStore } from './postgres-managed-project-store';

function fakeStore(rows: Array<{ project: string; repo: string; config?: unknown }>) {
  return {
    async get(repo: string) {
      const row = rows.find((r) => r.repo === repo);
      return row
        ? { id: '1', project: row.project, repo: row.repo, credentialSet: true, config: row.config ?? null, createdAt: '', updatedAt: '' }
        : null;
    },
  } as unknown as PostgresManagedProjectStore;
}

describe('resolveProjectConfig', () => {
  it('uses the stored DB config directly when non-null (no repo file read)', async () => {
    const config = {
      stages: {},
      routing: {},
      brakes: { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 },
    };
    const deps = { store: fakeStore([{ project: 'acme-web', repo: 'acme/web', config }]), privateKey: 'unused' } as ManagedProjectRegistryDeps;
    const scm = new MemoryScmPort(); // deliberately NOT seeded -- proves the file was never read

    const resolved = await resolveProjectConfig(deps, scm, 'acme/web');

    expect(resolved.brakes.maxTokens).toBe(200_000);
  });

  it('falls back to loadProjectConfig when the DB config is null', async () => {
    const deps = { store: fakeStore([{ project: 'acme-web', repo: 'acme/web' }]), privateKey: 'unused' } as ManagedProjectRegistryDeps;
    const scm = new MemoryScmPort();
    scm.seedFile('acme/web', 'agentops.json', JSON.stringify({ fastVerifyCommands: ['pnpm lint'] }));

    const resolved = await resolveProjectConfig(deps, scm, 'acme/web');

    expect(resolved.fastVerifyCommands).toEqual(['pnpm lint']);
  });

  it('falls back to loadProjectConfig when the repo is not DB-managed', async () => {
    const deps = { store: fakeStore([]), privateKey: 'unused' } as ManagedProjectRegistryDeps;
    const scm = new MemoryScmPort();
    scm.seedFile('acme/legacy', 'agentops.json', JSON.stringify({ fullVerifyCommands: ['pnpm test'] }));

    const resolved = await resolveProjectConfig(deps, scm, 'acme/legacy');

    expect(resolved.fullVerifyCommands).toEqual(['pnpm test']);
  });

  it('falls back to loadProjectConfig when no managed-project deps are configured at all', async () => {
    const scm = new MemoryScmPort();
    scm.seedFile('acme/legacy', 'agentops.json', JSON.stringify({ fastVerifyCommands: ['make test'] }));

    const resolved = await resolveProjectConfig(undefined, scm, 'acme/legacy');

    expect(resolved.fastVerifyCommands).toEqual(['make test']);
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `pnpm test -- packages/activities/src/resolve-project-config.test.ts`
Expected: FAIL — `Cannot find module './resolve-project-config'`.

- [ ] **Step 8: Write the helper**

```ts
// packages/activities/src/resolve-project-config.ts
import type { ProjectConfig } from '@agentops/contracts';
import type { ScmPort } from '@agentops/ports';
import { loadProjectConfig } from './load-project-config';
import type { ManagedProjectRegistryDeps } from './resolve-managed-projects';

/**
 * Design §6 config branch: if a managed project exists for `repo` with a
 * non-null `config`, use it directly (no repo file read at all); otherwise
 * fall back to the existing in-repo `loadProjectConfig`. `deps` undefined =>
 * straight to the file-based path, same as before this branch existed.
 *
 * This is a SECOND store.get(repo) on top of resolveManagedProjectEntry's --
 * one extra indexed SELECT per webhook/start, accepted to keep
 * resolveManagedProjectEntry's signature (and its existing data-layer tests)
 * untouched. config is not encrypted, so this needs no private key.
 */
export async function resolveProjectConfig(
  deps: ManagedProjectRegistryDeps | undefined,
  scm: ScmPort,
  repo: string,
): Promise<ProjectConfig> {
  if (deps) {
    const managedProject = await deps.store.get(repo);
    if (managedProject && managedProject.config !== null) {
      return managedProject.config;
    }
  }
  return loadProjectConfig(scm, repo);
}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm test -- packages/activities/src/resolve-project-config.test.ts`
Expected: PASS, all 4 tests green.

- [ ] **Step 10: Export from the package barrel**

```ts
// packages/activities/src/index.ts -- add this line (alphabetically near the other resolve-* export)
export * from './resolve-project-config';
```

- [ ] **Step 11: Typecheck and test the whole package**

Run: `pnpm --filter @agentops/activities run typecheck && pnpm test -- packages/activities`
Expected: both PASS.

- [ ] **Step 12: Commit**

```bash
git add packages/activities
git commit -m "feat(activities): add resolveProjectConfig helper and store getByProject lookup"
```

---

### Task 3: `packages/control` — the CRUD routes + auth guard

**Files:**
- Modify: `packages/control/src/create-control-server.ts`
- Modify: `packages/control/src/create-control-server.test.ts`
- Modify: `packages/control/src/main.ts`
- Modify: `packages/control/package.json`

- [ ] **Step 1: Add the `pg` dependency to control** (it builds a `Pool` to the engine DB, same as gateway/cli)

```bash
cd packages/control
pnpm add pg@^8.22.0
pnpm add -D @types/pg@^8.20.0
cd ../..
```

- [ ] **Step 2: Write the failing handler tests**

Append this whole new `describe` block as a sibling to the existing `describe('createControlServer', ...)` in `packages/control/src/create-control-server.test.ts`. It reuses the file's existing `getJson`/`postJson` helpers and adds `putJson`/`deleteJson`. Add `generateManagedProjectKeyPair` to the file's `@agentops/activities` import (or add a new import line), and `ControlDeps` is already imported.

```ts
// packages/control/src/create-control-server.test.ts -- add the import (this file already imports from './create-control-server')
import { generateManagedProjectKeyPair } from '@agentops/activities';
import type { ManagedProject, UpsertManagedProjectRequest } from '@agentops/contracts';

// helper additions alongside the existing getJson/postJson
async function putJson(port: number, path: string, payload: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  const body: unknown = await res.json().catch(() => undefined);
  return { status: res.status, body };
}

async function deleteJson(port: number, path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'DELETE', headers });
  const body: unknown = await res.json().catch(() => undefined);
  return { status: res.status, body };
}

async function getJsonWithHeaders(port: number, path: string, headers: Record<string, string>) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  const body: unknown = await res.json().catch(() => undefined);
  return { status: res.status, body };
}

function createFakeStore() {
  // In-memory managed-project table -- same shape control relies on
  // (get/getByProject/list/upsert/remove). control never decrypts, so the
  // "encrypted token" here is just a placeholder string.
  const rows: Array<ManagedProject & { _token: string }> = [];
  let nextId = 1;
  return {
    async get(repo: string) {
      const row = rows.find((r) => r.repo === repo);
      return row ? stripToken(row) : null;
    },
    async getByProject(project: string) {
      const row = rows.find((r) => r.project === project);
      return row ? stripToken(row) : null;
    },
    async list() {
      return [...rows].sort((a, b) => a.project.localeCompare(b.project)).map(stripToken);
    },
    async upsert(input: UpsertManagedProjectRequest, _publicKey: string) {
      const existingIndex = rows.findIndex((r) => r.repo === input.repo);
      const now = new Date().toISOString();
      if (existingIndex >= 0) {
        const existing = rows[existingIndex];
        rows[existingIndex] = {
          ...existing,
          project: input.project,
          config: input.config === undefined ? existing.config : input.config,
          _token: input.token ?? existing._token,
          updatedAt: now,
        };
        return stripToken(rows[existingIndex]);
      }
      const row = {
        id: String(nextId++),
        project: input.project,
        repo: input.repo,
        credentialSet: true,
        config: input.config ?? null,
        createdAt: now,
        updatedAt: now,
        _token: input.token ?? '',
      };
      rows.push(row);
      return stripToken(row);
    },
    async remove(repo: string) {
      const i = rows.findIndex((r) => r.repo === repo);
      if (i >= 0) rows.splice(i, 1);
    },
  } as never;
}

function stripToken(row: ManagedProject & { _token: string }): ManagedProject {
  const { _token, ...rest } = row;
  return rest;
}

const CRUD_TOKEN = 'crud-secret';
const CRUD_HEADERS = { authorization: `Bearer ${CRUD_TOKEN}` };

describe('createControlServer managed-project CRUD', () => {
  let server: ReturnType<typeof createControlServer>;
  let port: number;
  let deps: ControlDeps;

  function listen() {
    server = createControlServer(deps);
    return new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  beforeEach(() => {
    const { publicKey } = generateManagedProjectKeyPair();
    deps = {
      client: { workflow: { start: vi.fn(), list: vi.fn(), getHandle: vi.fn() } } as never,
      taskQueue: 'agentops-devcycle',
      namespace: 'default',
      temporalUiBaseUrl: 'https://temporal.example',
      registry: [],
      managedProjectStore: createFakeStore(),
      projectCredentialPublicKey: publicKey,
      projectCrudAuthToken: CRUD_TOKEN,
    };
  });

  afterEach(() => {
    server?.close();
  });

  it('POST /api/projects creates a project and never echoes the token', async () => {
    await listen();
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CRUD_HEADERS },
      body: JSON.stringify({ project: 'acme-web', repo: 'acme/web', token: 'ghp_secret' }),
    });
    const created = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(201);
    expect(created.project).toBe('acme-web');
    expect(created.credentialSet).toBe(true);
    expect(created.token).toBeUndefined();
    expect(created.encryptedToken).toBeUndefined();
  });

  it('POST rejects a missing token with 400', async () => {
    await listen();
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CRUD_HEADERS },
      body: JSON.stringify({ project: 'acme-web', repo: 'acme/web' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST 409s on a duplicate repo', async () => {
    await listen();
    await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CRUD_HEADERS },
      body: JSON.stringify({ project: 'acme-web', repo: 'acme/web', token: 'ghp_a' }),
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CRUD_HEADERS },
      body: JSON.stringify({ project: 'other', repo: 'acme/web', token: 'ghp_b' }),
    });
    expect(res.status).toBe(409);
  });

  it('POST 409s on a duplicate project slug', async () => {
    await listen();
    await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CRUD_HEADERS },
      body: JSON.stringify({ project: 'acme-web', repo: 'acme/web', token: 'ghp_a' }),
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CRUD_HEADERS },
      body: JSON.stringify({ project: 'acme-web', repo: 'acme/other', token: 'ghp_b' }),
    });
    expect(res.status).toBe(409);
  });

  it('GET /api/projects lists created projects (repo URL-decoded path is tested via show)', async () => {
    await listen();
    await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CRUD_HEADERS },
      body: JSON.stringify({ project: 'acme-web', repo: 'acme/web', token: 'ghp_a' }),
    });
    const { status, body } = await getJsonWithHeaders(port, '/api/projects', CRUD_HEADERS);
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect((body as Array<{ project: string }>)[0].project).toBe('acme-web');
  });

  it('GET /api/projects/:repo returns 200 and URL-decodes the repo, or 404', async () => {
    await listen();
    await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CRUD_HEADERS },
      body: JSON.stringify({ project: 'acme-web', repo: 'acme/web', token: 'ghp_a' }),
    });
    const found = await getJsonWithHeaders(port, '/api/projects/acme%2Fweb', CRUD_HEADERS);
    expect(found.status).toBe(200);
    expect((found.body as { repo: string }).repo).toBe('acme/web');

    const missing = await getJsonWithHeaders(port, '/api/projects/acme%2Fnope', CRUD_HEADERS);
    expect(missing.status).toBe(404);
  });

  it('PUT /api/projects/:repo rotates the token and updates config; identity is immutable', async () => {
    await listen();
    await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CRUD_HEADERS },
      body: JSON.stringify({ project: 'acme-web', repo: 'acme/web', token: 'ghp_old' }),
    });
    const config = {
      stages: {},
      routing: {},
      brakes: { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 },
    };
    const { status, body } = await putJson(port, '/api/projects/acme%2Fweb', { token: 'ghp_new', config }, CRUD_HEADERS);
    expect(status).toBe(200);
    expect((body as { project: string; config: { brakes: { maxTokens: number } } }).project).toBe('acme-web'); // unchanged identity
    expect((body as { config: { brakes: { maxTokens: number } } }).config.brakes.maxTokens).toBe(200_000);
  });

  it('PUT 404s on an unknown repo', async () => {
    await listen();
    const { status } = await putJson(port, '/api/projects/acme%2Fnope', { token: 'ghp_new' }, CRUD_HEADERS);
    expect(status).toBe(404);
  });

  it('PUT clears config back to file-based with an explicit null', async () => {
    await listen();
    const config = { stages: {}, routing: {}, brakes: { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 100, maxBabysitRounds: 1 } };
    await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CRUD_HEADERS },
      body: JSON.stringify({ project: 'acme-web', repo: 'acme/web', token: 'ghp_a', config }),
    });
    const { body } = await putJson(port, '/api/projects/acme%2Fweb', { config: null }, CRUD_HEADERS);
    expect((body as { config: unknown }).config).toBeNull();
  });

  it('DELETE /api/projects/:repo removes a project (204), 404 when absent', async () => {
    await listen();
    await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CRUD_HEADERS },
      body: JSON.stringify({ project: 'acme-web', repo: 'acme/web', token: 'ghp_a' }),
    });
    expect((await deleteJson(port, '/api/projects/acme%2Fweb', CRUD_HEADERS)).status).toBe(204);
    expect((await deleteJson(port, '/api/projects/acme%2Fweb', CRUD_HEADERS)).status).toBe(404);
  });

  it('returns 401 without/with-wrong the bearer token', async () => {
    await listen();
    expect((await getJson(port, '/api/projects')).status).toBe(401);
    expect((await getJsonWithHeaders(port, '/api/projects', { authorization: 'Bearer wrong' })).status).toBe(401);
  });

  it('returns 503 when CRUD is not configured (no auth token)', async () => {
    delete deps.projectCrudAuthToken;
    await listen();
    expect((await getJsonWithHeaders(port, '/api/projects', CRUD_HEADERS)).status).toBe(503);
  });
});

```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test -- packages/control/src/create-control-server.test.ts`
Expected: FAIL — `managedProjectStore` / `projectCredentialPublicKey` / `projectCrudAuthToken` don't exist on `ControlDeps` (TypeScript error), and the routes 404.

- [ ] **Step 4: Add the imports, `ControlDeps` fields, handlers, and dispatch to `create-control-server.ts`**

Add to the existing `@agentops/contracts` import block:

```ts
// packages/control/src/create-control-server.ts -- extend the existing @agentops/contracts import
import {
  PlatformAgentResultSchema,
  RepoListResponseSchema,
  RunDetailSchema,
  RunListItemSchema,
  StartRunRequestSchema,
  StartRunResponseSchema,
  CreateManagedProjectRequestSchema,
  UpdateManagedProjectRequestSchema,
} from '@agentops/contracts';
```

Add a new import for the store type (the store encrypts internally; control never imports the crypto functions):

```ts
// packages/control/src/create-control-server.ts -- new import near the other @agentops/* imports
import type { PostgresManagedProjectStore } from '@agentops/activities';
```

Extend `ControlDeps` (add the three optional fields):

```ts
// packages/control/src/create-control-server.ts -- replace the ControlDeps interface
export interface ControlDeps {
  client: Client;
  taskQueue: string;
  namespace: string;
  temporalUiBaseUrl: string;
  registry: string[];
  uiDistPath?: string;
  // Managed-project CRUD (design §7). The store encrypts tokens internally
  // with `projectCredentialPublicKey`; control holds ONLY the public key and
  // the store, so it can write credentials it cannot read (design §5). All
  // five routes are gated behind `projectCrudAuthToken` (a bearer token);
  // with any of these three unset the routes return 503. Issue #4 (Traefik
  // basic-auth) is still required before the control ingress goes public.
  managedProjectStore?: PostgresManagedProjectStore;
  projectCredentialPublicKey?: string;
  projectCrudAuthToken?: string;
}
```

Add the handlers and guard (place these after `handleListRepos`, before `dispatch`):

```ts
// packages/control/src/create-control-server.ts -- new functions before dispatch()
function isProjectCrudEnabled(deps: ControlDeps): boolean {
  return Boolean(deps.managedProjectStore && deps.projectCredentialPublicKey && deps.projectCrudAuthToken);
}

function authorizeProjectCrud(deps: ControlDeps, req: IncomingMessage): boolean {
  return req.headers.authorization === `Bearer ${deps.projectCrudAuthToken}`;
}

async function handleListProjects(deps: ControlDeps): Promise<HandlerResponse> {
  return { status: 200, body: await deps.managedProjectStore!.list() };
}

async function handleGetProject(deps: ControlDeps, repo: string): Promise<HandlerResponse> {
  const project = await deps.managedProjectStore!.get(repo);
  if (!project) {
    return { status: 404, body: { error: `no managed project for repo "${repo}"` } };
  }
  return { status: 200, body: project };
}

async function handleCreateProject(deps: ControlDeps, req: IncomingMessage): Promise<HandlerResponse> {
  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: 'invalid JSON body' } };
  }
  const parsed = CreateManagedProjectRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues.map((issue) => issue.message).join('; ') } };
  }
  const { project, repo, token, config } = parsed.data;
  if (await deps.managedProjectStore!.get(repo)) {
    return { status: 409, body: { error: `a managed project for repo "${repo}" already exists` } };
  }
  if (await deps.managedProjectStore!.getByProject(project)) {
    return { status: 409, body: { error: `a managed project with project "${project}" already exists` } };
  }
  const created = await deps.managedProjectStore!.upsert({ project, repo, token, config }, deps.projectCredentialPublicKey!);
  return { status: 201, body: created };
}

async function handleUpdateProject(deps: ControlDeps, repo: string, req: IncomingMessage): Promise<HandlerResponse> {
  const existing = await deps.managedProjectStore!.get(repo);
  if (!existing) {
    return { status: 404, body: { error: `no managed project for repo "${repo}"` } };
  }
  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: 'invalid JSON body' } };
  }
  const parsed = UpdateManagedProjectRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues.map((issue) => issue.message).join('; ') } };
  }
  // repo/project are immutable identity -- pass the existing values through;
  // only token/config come from the body (token rotates, config set/clear/keep).
  const updated = await deps.managedProjectStore!.upsert(
    { project: existing.project, repo: existing.repo, token: parsed.data.token, config: parsed.data.config },
    deps.projectCredentialPublicKey!,
  );
  return { status: 200, body: updated };
}

async function handleDeleteProject(deps: ControlDeps, repo: string): Promise<HandlerResponse> {
  const existing = await deps.managedProjectStore!.get(repo);
  if (!existing) {
    return { status: 404, body: { error: `no managed project for repo "${repo}"` } };
  }
  await deps.managedProjectStore!.remove(repo);
  return { status: 204 };
}
```

Add the dispatch branch (place it inside `dispatch`, just before the final `return undefined;`):

```ts
// packages/control/src/create-control-server.ts -- inside dispatch(), before "return undefined;"
  if (pathname === '/api/projects' || pathname.startsWith('/api/projects/')) {
    if (!isProjectCrudEnabled(deps)) {
      return { status: 503, body: { error: 'project CRUD is disabled (requires ENGINE_DB_*, PROJECT_CREDENTIAL_PUBLIC_KEY, and CONTROL_CRUD_TOKEN)' } };
    }
    if (!authorizeProjectCrud(deps, req)) {
      return { status: 401, body: { error: 'unauthorized' } };
    }
    const projectMatch = matchPath('/api/projects/:repo', pathname);
    if (req.method === 'GET' && pathname === '/api/projects') {
      return handleListProjects(deps);
    }
    if (req.method === 'POST' && pathname === '/api/projects') {
      return handleCreateProject(deps, req);
    }
    if (projectMatch) {
      const { repo } = projectMatch.params;
      if (req.method === 'GET') {
        return handleGetProject(deps, repo);
      }
      if (req.method === 'PUT') {
        return handleUpdateProject(deps, repo, req);
      }
      if (req.method === 'DELETE') {
        return handleDeleteProject(deps, repo);
      }
    }
    return undefined;
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test -- packages/control/src/create-control-server.test.ts`
Expected: PASS, all new tests green and all pre-existing tests still green (the new branch only matches `/api/projects*`).

- [ ] **Step 6: Wire the store, public key, and crud token into `main.ts`**

```ts
// packages/control/src/main.ts -- replace the whole file
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Connection } from '@temporalio/client';
import { loadEnv, PostgresManagedProjectStore } from '@agentops/activities';
import { Pool } from 'pg';
import { createControlServer } from './create-control-server';
import { readRegistryRepos } from './read-registry-repos';

loadEnv();

function buildManagedProjectStore(): PostgresManagedProjectStore | undefined {
  const host = process.env.ENGINE_DB_HOST;
  const publicKey = process.env.PROJECT_CREDENTIAL_PUBLIC_KEY;
  if (!host || !publicKey) {
    return undefined;
  }
  return new PostgresManagedProjectStore(
    new Pool({
      host,
      port: process.env.ENGINE_DB_PORT ? Number(process.env.ENGINE_DB_PORT) : 5432,
      database: process.env.ENGINE_DB_NAME ?? 'agentops_engine',
      user: process.env.ENGINE_DB_USER ?? 'temporal',
      password: process.env.ENGINE_DB_PASSWORD,
    }),
  );
}

async function main(): Promise<void> {
  const temporalUiBaseUrl = process.env.TEMPORAL_UI_BASE_URL;
  if (!temporalUiBaseUrl) {
    throw new Error('TEMPORAL_UI_BASE_URL is required');
  }

  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  const client = new Client({ connection, namespace });

  const registry = readRegistryRepos();
  console.log(
    registry.length > 0
      ? `agentops control: ${registry.length} repo(s) registered for the hint-repos picker`
      : 'agentops control: no PROJECT_REGISTRY_JSON set — hint-repos picker will offer no suggestions',
  );

  const managedProjectStore = buildManagedProjectStore();
  const projectCrudAuthToken = process.env.CONTROL_CRUD_TOKEN;
  if (managedProjectStore) {
    await managedProjectStore.ensureSchema();
    if (projectCrudAuthToken) {
      console.log('agentops control: managed-project CRUD routes ENABLED and token-protected (CONTROL_CRUD_TOKEN set)');
    } else {
      console.warn(
        'agentops control: managed-project store is configured but CRUD routes are DISABLED — set CONTROL_CRUD_TOKEN to enable /api/projects',
      );
    }
  } else if (projectCrudAuthToken) {
    console.warn(
      'agentops control: CONTROL_CRUD_TOKEN is set but managed-project store is unavailable (need ENGINE_DB_HOST + PROJECT_CREDENTIAL_PUBLIC_KEY) — /api/projects disabled',
    );
  } else {
    console.log('agentops control: managed-project CRUD routes disabled (no ENGINE_DB_* / PROJECT_CREDENTIAL_PUBLIC_KEY / CONTROL_CRUD_TOKEN)');
  }

  // packages/ui's build output, resolved relative to this file so it works
  // regardless of process.cwd() -- same "runs via tsx src/main.ts, not a
  // compiled dist/" convention as the worker/gateway images. Serving is
  // skipped entirely (404 for non-API GETs) until `pnpm --filter @agentops/ui
  // build` has produced this directory, so local dev without a UI build
  // doesn't crash.
  const uiDistPath = join(__dirname, '../../ui/dist');

  const server = createControlServer({
    client,
    taskQueue: process.env.TASK_QUEUE ?? 'agentops-devcycle',
    namespace,
    temporalUiBaseUrl,
    registry,
    uiDistPath: existsSync(uiDistPath) ? uiDistPath : undefined,
    managedProjectStore,
    projectCredentialPublicKey: process.env.PROJECT_CREDENTIAL_PUBLIC_KEY,
    projectCrudAuthToken,
  });

  const port = Number(process.env.PORT ?? 3001);
  server.listen(port, () => {
    console.log(`agentops control listening on :${port}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 7: Verify the security boundary — control never decrypts**

```bash
# Must print NOTHING. decryptForManagedProject is the private-key operation;
# control must not import it (design §5). encryptForManagedProject is also
# absent -- control only holds the store, which encrypts internally.
grep -rn "decryptForManagedProject\|encryptForManagedProject" packages/control/src/ || true
```

Expected: no output. (If this prints anything, stop and remove the import — the security property depends on it.)

- [ ] **Step 8: Typecheck and test the whole package**

Run: `pnpm --filter @agentops/control run typecheck && pnpm test -- packages/control`
Expected: both PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/control
git commit -m "feat(control): add managed-project CRUD routes with token-only encryption"
```

---

### Task 4: `packages/gateway` — use `resolveProjectConfig` for the config branch

Closes the data-layer config gap on the webhook path (design §6): a managed project with a non-null DB config is used directly, no repo file read.

**Files:**
- Modify: `packages/gateway/src/create-gateway-server.ts`
- Modify: `packages/gateway/src/create-gateway-server.test.ts`

- [ ] **Step 1: Write the failing test** (add a new `describe` block as a sibling to the existing one; this file already imports `MemoryScmPort`, `GatewayDeps`, `encryptForManagedProject`, `generateManagedProjectKeyPair` per the data-layer plan)

```ts
// packages/gateway/src/create-gateway-server.test.ts -- new describe block
describe('createGatewayServer config branch (DB config vs file fallback)', () => {
  let server: ReturnType<typeof createGatewayServer>;
  let port: number;
  let start: ReturnType<typeof vi.fn>;

  function listen(deps: GatewayDeps) {
    server = createGatewayServer(deps);
    return new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  afterEach(() => {
    server?.close();
  });

  it('uses the DB config directly when the managed project has one (no repo file read)', async () => {
    start = vi.fn().mockResolvedValue(undefined);
    const keyPair = generateManagedProjectKeyPair();
    const dbConfig = {
      stages: {},
      routing: {},
      brakes: { maxImplementAttempts: 9, maxIterations: 9, maxTokens: 999_999, maxBabysitRounds: 9 },
    };
    // A MemoryScmPort that is NOT seeded -- if loadProjectConfig were called
    // it would return defaults (maxTokens 200_000), not 999_999.
    const scm = new MemoryScmPort();
    const managedProjectDeps = {
      store: {
        async get(repo: string) {
          return repo === 'octocat/hello-world'
            ? { id: '1', project: 'my-project', repo, credentialSet: true, config: dbConfig, createdAt: '', updatedAt: '' }
            : null;
        },
        async getEncryptedToken(repo: string) {
          return repo === 'octocat/hello-world' ? encryptForManagedProject(keyPair.publicKey, 'db-token') : null;
        },
      } as never,
      privateKey: keyPair.privateKey,
    };
    await listen({
      client: { workflow: { start } } as never,
      taskQueue: 'agentops-devcycle',
      webhookSecret: SECRET,
      triggerLabel: TRIGGER_LABEL,
      registry: [],
      buildScm: () => scm,
      managedProjectDeps,
    });

    const body = JSON.stringify(labeledPayload());
    const res = await post(port, '/webhooks/github', body, {
      'content-type': 'application/json',
      'x-github-event': 'issues',
      'x-hub-signature-256': sign(body),
    });

    expect(res.status).toBe(202);
    expect(start).toHaveBeenCalledTimes(1);
    const [, options] = start.mock.calls[0];
    expect(options.args[0].config.brakes.maxTokens).toBe(999_999);
  });

  it('falls back to loadProjectConfig when the managed project config is null', async () => {
    start = vi.fn().mockResolvedValue(undefined);
    const keyPair = generateManagedProjectKeyPair();
    const scm = new MemoryScmPort();
    scm.seedFile('octocat/hello-world', 'agentops.json', JSON.stringify({ fastVerifyCommands: ['pnpm lint'] }));
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
      privateKey: keyPair.privateKey,
    };
    await listen({
      client: { workflow: { start } } as never,
      taskQueue: 'agentops-devcycle',
      webhookSecret: SECRET,
      triggerLabel: TRIGGER_LABEL,
      registry: [],
      buildScm: () => scm,
      managedProjectDeps,
    });

    const body = JSON.stringify(labeledPayload());
    await post(port, '/webhooks/github', body, {
      'content-type': 'application/json',
      'x-github-event': 'issues',
      'x-hub-signature-256': sign(body),
    });

    const [, options] = start.mock.calls[0];
    expect(options.args[0].config.fastVerifyCommands).toEqual(['pnpm lint']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- packages/gateway/src/create-gateway-server.test.ts`
Expected: FAIL — the first test fails because the gateway still calls `loadProjectConfig`, which reads no file and returns defaults (`maxTokens` 200_000), not `999_999`.

- [ ] **Step 3: Swap `loadProjectConfig` for `resolveProjectConfig`** in the webhook handler

```ts
// packages/gateway/src/create-gateway-server.ts -- replace the @agentops/activities import line
import { resolveManagedProjectEntry, resolveProjectConfig, type ManagedProjectRegistryDeps } from '@agentops/activities';
```

```ts
// packages/gateway/src/create-gateway-server.ts -- in handleRequest, replace the line:
//   const config = await loadProjectConfig(scm, entry.repo);
// with:
    const config = await resolveProjectConfig(deps.managedProjectDeps, scm, entry.repo);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- packages/gateway/src/create-gateway-server.test.ts`
Expected: PASS, including the two new tests and every pre-existing one (the static-registry path is unchanged: `resolveProjectConfig` with `managedProjectDeps: undefined` falls straight through to `loadProjectConfig`).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @agentops/gateway run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway
git commit -m "feat(gateway): use DB project config when present, else fall back to the repo file"
```

---

### Task 5: `packages/cli` — `engine project` subcommands + the config branch in `cmdStart`

**Files:**
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/main.test.ts`

- [ ] **Step 1: Write the failing CLI HTTP-client tests** (mock `fetch`)

```ts
// packages/cli/src/main.test.ts -- add these imports near the top
import { afterEach, beforeEach, vi } from 'vitest';
import {
  buildControlRequest,
  cmdProject,
  controlBaseUrl,
  controlCrudHeaders,
} from './main';

describe('engine project (control HTTP client)', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CONTROL_BASE_URL = 'http://control.test:3001';
    process.env.CONTROL_CRUD_TOKEN = 'tok';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('controlBaseUrl/headers read env, with safe defaults', () => {
    delete process.env.CONTROL_BASE_URL;
    delete process.env.CONTROL_CRUD_TOKEN;
    expect(controlBaseUrl()).toBe('http://localhost:3001');
    expect(controlCrudHeaders(false)).toEqual({});
  });

  it('buildControlRequest composes URL, method, auth header, and JSON body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await buildControlRequest('POST', '/api/projects', { project: 'acme-web', repo: 'acme/web', token: 'ghp_x' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://control.test:3001/api/projects');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ project: 'acme-web', repo: 'acme/web', token: 'ghp_x' }));
  });

  it('add POSTs the project and prints the result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ project: 'acme-web', repo: 'acme/web' }), { status: 201 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await cmdProject(['add', '--project', 'acme-web', '--repo', 'acme/web', '--token', 'ghp_x']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://control.test:3001/api/projects');
    expect(init.method).toBe('POST');
  });

  it('list GETs /api/projects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await cmdProject(['list']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://control.test:3001/api/projects');
    expect(init.method).toBe('GET');
  });

  it('show URL-encodes the repo in the path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await cmdProject(['show', '--repo', 'acme/web']);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://control.test:3001/api/projects/acme%2Fweb');
  });

  it('update PUTs and URL-encodes the repo', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await cmdProject(['update', '--repo', 'acme/web', '--token', 'ghp_new']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://control.test:3001/api/projects/acme%2Fweb');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ token: 'ghp_new' });
  });

  it('update --config null clears config; --config <json> sets it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await cmdProject(['update', '--repo', 'acme/web', '--config', 'null']);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body)).toEqual({ config: null });
  });

  it('remove DELETEs and URL-encodes the repo', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 204 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await cmdProject(['remove', '--repo', 'acme/web']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://control.test:3001/api/projects/acme%2Fweb');
    expect(init.method).toBe('DELETE');
  });

  it('rejects an unknown project subcommand', async () => {
    await expect(cmdProject(['bogus'])).rejects.toThrow(/add\|list\|show\|update\|remove/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- packages/cli/src/main.test.ts -t "engine project"`
Expected: FAIL — `buildControlRequest`/`cmdProject`/`controlBaseUrl`/`controlCrudHeaders` are not exported.

- [ ] **Step 3: Add the config branch to `cmdStart`** (swap `loadProjectConfig` for `resolveProjectConfig`, and call the deps builder once)

```ts
// packages/cli/src/main.ts -- replace the existing @agentops/activities import. loadProjectConfig is
// dropped (cmdStart is its only caller and the swap below replaces it); resolveProjectConfig is added.
import {
  loadEnv,
  loadProjectRegistry,
  PostgresManagedProjectStore,
  resolveManagedProjectEntry,
  resolveProjectConfig,
  SpawnGitCommandRunner,
  type ManagedProjectRegistryDeps,
} from '@agentops/activities';
```

```ts
// packages/cli/src/main.ts -- replace cmdStart's body
async function cmdStart(taskId: string, goal: string, project: string, repo: string, issueRef?: string): Promise<void> {
  const client = await getClient();
  const managedProjectDeps = buildCliManagedProjectDeps();
  const scm = await buildStartScmPortWithManagedProjects(managedProjectDeps, loadProjectRegistry(), project, repo);
  const config = await resolveProjectConfig(managedProjectDeps, scm, repo);
  const input: TaskInput = { taskId, project, repo, issueRef, goal, config };
  const handle = await client.workflow.start(devCycle, { taskQueue: TASK_QUEUE, workflowId: taskId, args: [input] });
  console.log(`started ${handle.workflowId}`);
}
```

(After this swap `loadProjectConfig` has no remaining caller in `main.ts`, so it was dropped from the import above to satisfy the no-unused rule. The function itself still exists in `@agentops/activities` and is used by the new `resolve-project-config.ts`.)

- [ ] **Step 4: Add the control HTTP client + `engine project` dispatcher**

```ts
// packages/cli/src/main.ts -- add these (anywhere at module scope, e.g. after cmdState)
export function controlBaseUrl(): string {
  return process.env.CONTROL_BASE_URL ?? 'http://localhost:3001';
}

export function controlCrudHeaders(hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = process.env.CONTROL_CRUD_TOKEN;
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  if (hasBody) {
    headers['content-type'] = 'application/json';
  }
  return headers;
}

export async function buildControlRequest(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${controlBaseUrl()}${path}`, {
    method,
    headers: controlCrudHeaders(body !== undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text; // keep raw text if it isn't JSON (e.g. a 204 empty body)
    }
  }
  return { status: res.status, body: parsed };
}

function parseConfigArg(configJson: string | undefined): unknown {
  if (configJson === undefined) {
    return undefined;
  }
  return configJson === 'null' ? null : JSON.parse(configJson);
}

async function cmdProjectAdd(flags: Record<string, string>): Promise<void> {
  const { project, repo, token, config: configJson } = flags;
  if (!project || !repo || !token) {
    throw new Error('usage: engine project add --project <name> --repo <owner/repo> --token <token> [--config <json>]');
  }
  const { status, body } = await buildControlRequest('POST', '/api/projects', { project, repo, token, config: parseConfigArg(configJson) });
  console.log(`status ${status}`);
  console.log(JSON.stringify(body, null, 2));
}

async function cmdProjectList(): Promise<void> {
  const { status, body } = await buildControlRequest('GET', '/api/projects');
  console.log(`status ${status}`);
  console.log(JSON.stringify(body, null, 2));
}

async function cmdProjectShow(flags: Record<string, string>): Promise<void> {
  const { repo } = flags;
  if (!repo) {
    throw new Error('usage: engine project show --repo <owner/repo>');
  }
  const { status, body } = await buildControlRequest('GET', `/api/projects/${encodeURIComponent(repo)}`);
  console.log(`status ${status}`);
  console.log(JSON.stringify(body, null, 2));
}

async function cmdProjectUpdate(flags: Record<string, string>): Promise<void> {
  const { repo, token, config: configJson } = flags;
  if (!repo) {
    throw new Error('usage: engine project update --repo <owner/repo> [--token <token>] [--config <json>|null]');
  }
  if (token === undefined && configJson === undefined) {
    throw new Error('usage: engine project update needs at least one of --token or --config');
  }
  const payload: Record<string, unknown> = {};
  if (token !== undefined) payload.token = token;
  if (configJson !== undefined) payload.config = parseConfigArg(configJson);
  const { status, body } = await buildControlRequest('PUT', `/api/projects/${encodeURIComponent(repo)}`, payload);
  console.log(`status ${status}`);
  console.log(JSON.stringify(body, null, 2));
}

async function cmdProjectRemove(flags: Record<string, string>): Promise<void> {
  const { repo } = flags;
  if (!repo) {
    throw new Error('usage: engine project remove --repo <owner/repo>');
  }
  const { status, body } = await buildControlRequest('DELETE', `/api/projects/${encodeURIComponent(repo)}`);
  console.log(`status ${status}`);
  if (body) {
    console.log(JSON.stringify(body, null, 2));
  }
}

export async function cmdProject(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === 'add') {
    return cmdProjectAdd(parseFlags(rest));
  }
  if (subcommand === 'list') {
    return cmdProjectList();
  }
  if (subcommand === 'show') {
    return cmdProjectShow(parseFlags(rest));
  }
  if (subcommand === 'update') {
    return cmdProjectUpdate(parseFlags(rest));
  }
  if (subcommand === 'remove') {
    return cmdProjectRemove(parseFlags(rest));
  }
  throw new Error('usage: engine project <add|list|show|update|remove> ...');
}
```

- [ ] **Step 5: Wire `project` into the top-level dispatcher**

```ts
// packages/cli/src/main.ts -- in main(), add this branch alongside the existing start/signal/state branches
  } else if (command === 'project') {
    await cmdProject(rest);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test -- packages/cli/src/main.test.ts`
Expected: PASS, all tests green including the new HTTP-client ones.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @agentops/cli run typecheck`
Expected: PASS. (`loadProjectConfig` was already dropped from the import in Step 3; if typecheck still reports it as unused, double-check no other `main.ts` caller remains.)

- [ ] **Step 8: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): add engine project CRUD subcommands and use DB project config"
```

---

### Task 6: `charts/engine` — control deployment env + values

**Files:**
- Modify: `charts/engine/templates/control-deployment.yaml`
- Modify: `charts/engine/values.yaml`

The public key is **not** a secret (design §5) → plain env value. `CONTROL_CRUD_TOKEN` **is** a secret → `secretKeyRef`. All three additions are gated on empty-by-default values, so the chart's golden render is unchanged (confirmed in Step 4).

- [ ] **Step 1: Add the env block to the control Deployment** (insert after the existing `PROJECT_REGISTRY_JSON` env entry, inside the `env:` list)

```yaml
            # charts/engine/templates/control-deployment.yaml -- after PROJECT_REGISTRY_JSON, before "resources:"
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
            {{- if .Values.projectCredentialPublicKey }}
            - name: PROJECT_CREDENTIAL_PUBLIC_KEY
              value: {{ .Values.projectCredentialPublicKey | quote }}
            {{- end }}
            {{- if .Values.projectCrudTokenSecretName }}
            - name: CONTROL_CRUD_TOKEN
              valueFrom:
                secretKeyRef:
                  name: {{ .Values.projectCrudTokenSecretName }}
                  key: controlCrudToken
            {{- end }}
```

- [ ] **Step 2: Add the two new chart values** (place near `projectCredentialPrivateKeySecretName`)

```yaml
# charts/engine/values.yaml -- add after the projectCredentialPrivateKeySecretName block

# Base64 SPKI DER public key matching projectCredentialPrivateKeySecretName's
# private half (design §5). NOT a secret -- mounted as a plain env var on
# control ONLY, which can encrypt managed-project tokens it cannot decrypt.
# The private key never reaches control. Generate with
# generateManagedProjectKeyPair(); unset => control's /api/projects routes
# are disabled (503). The platform follow-up PR sets this to the live key
# (private key is already wired in agentops-platform PR #3).
projectCredentialPublicKey: ""

# Shared bearer token gating control's /api/projects CRUD routes
# (CONTROL_CRUD_TOKEN). A SECRET -- sourced from a K8s Secret with a
# controlCrudToken key. Unset => routes disabled (503). This is app-layer
# defense-in-depth + the local CLI's auth; GitHub issue #4 (Traefik
# basic-auth on the control ingress) is STILL REQUIRED before enabling the
# control ingress publicly (control.ingress.enabled stays false by default).
projectCrudTokenSecretName: ""
```

- [ ] **Step 3: Lint the chart**

Run: `helm lint charts/engine`
Expected: PASS.

- [ ] **Step 4: Run the chart golden test (confirm the default render is unchanged)**

Run: `bash charts/engine/tests/run.sh`
Expected: PASS (all new env blocks are gated on empty-by-default values, so `helm template engine .` produces identical output to `tests/render.golden.yaml`). If it fails, the diff shows an unexpected render — re-check that every new block is wrapped in an `{{- if ... }}` against an empty-by-default value.

- [ ] **Step 5: Commit**

```bash
git add charts/engine
git commit -m "feat(chart): wire managed-project CRUD env into the control deployment"
```

---

### Task 7: Full-repo gate, security-boundary verification, and a manual smoke test

**Files:** none (verification + a throwaway script).

- [ ] **Step 1: Full lint, typecheck, test, policies-coverage, e2e, chart**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e && helm lint charts/engine && bash charts/engine/tests/run.sh
```

Expected: all PASS.

- [ ] **Step 2: Security-boundary grep (definition-of-done check)**

```bash
echo "--- control must NOT decrypt (expect no matches): ---"
grep -rn "decryptForManagedProject" packages/control/src/ || echo "OK: control does not import decryptForManagedProject"
echo "--- control must NOT import the encrypt fn either (it only holds the store): ---"
grep -rn "encryptForManagedProject" packages/control/src/ || echo "OK: control does not import encryptForManagedProject directly"
echo "--- GET /api/projects must not return tokens (contract check): ---"
grep -n "token" packages/contracts/src/managed-project.ts
```

Expected: both control greps print "OK: ..."; the managed-project.ts grep shows `credentialSet: z.boolean()` and no token/encrypted-token field (proving `ManagedProject` cannot carry a token).

- [ ] **Step 3: Manual end-to-end smoke (control API + CLI)**

There's no live Postgres assumed here — use a throwaway local one to prove the whole CRUD chain (control writes encrypted, CLI reads) works, including that GET never returns a token. The smoke uses the **brief's public key** directly: it's a valid X25519 SPKI, control only needs it to *encrypt* (never decrypt), and the smoke never decrypts — it only asserts GET doesn't echo a token. No keygen one-liner needed.

```bash
docker run --rm -d --name engine-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16

# The live public key from the brief (valid X25519 SPKI DER, base64):
PROJECT_CREDENTIAL_PUBLIC_KEY='MCowBQYDK2VuAyEAAuidf7MeAA2Q0X6n8zQ/ug7mH0htTFwL8F6i8Uyxtig='

# 1. Start control with DB creds, the public key, and a crud token.
ENGINE_DB_HOST=localhost ENGINE_DB_NAME=postgres ENGINE_DB_USER=postgres ENGINE_DB_PASSWORD=postgres \
  PROJECT_CREDENTIAL_PUBLIC_KEY="$PROJECT_CREDENTIAL_PUBLIC_KEY" CONTROL_CRUD_TOKEN=smoke-tok \
  PORT=3001 pnpm --filter @agentops/control run start &
CONTROL_PID=$!
sleep 4

# 2. CLI: add, list, show, update (rotate), remove.
CONTROL_BASE_URL=http://localhost:3001 CONTROL_CRUD_TOKEN=smoke-tok \
  pnpm --filter @agentops/cli run engine -- project add --project smoke --repo octocat/hello-world --token ghp_smoke

echo "--- list (must show credentialSet:true and NO token/encryptedToken field) ---"
CONTROL_BASE_URL=http://localhost:3001 CONTROL_CRUD_TOKEN=smoke-tok \
  pnpm --filter @agentops/cli run engine -- project list

CONTROL_BASE_URL=http://localhost:3001 CONTROL_CRUD_TOKEN=smoke-tok \
  pnpm --filter @agentops/cli run engine -- project show --repo octocat/hello-world

CONTROL_BASE_URL=http://localhost:3001 CONTROL_CRUD_TOKEN=smoke-tok \
  pnpm --filter @agentops/cli run engine -- project update --repo octocat/hello-world --token ghp_rotated

CONTROL_BASE_URL=http://localhost:3001 CONTROL_CRUD_TOKEN=smoke-tok \
  pnpm --filter @agentops/cli run engine -- project remove --repo octocat/hello-world

kill $CONTROL_PID 2>/dev/null || true
```
```

Expected: `add` returns 201; `list`/`show` show the project with `credentialSet: true` and no `token`/`encryptedToken` field; `update` returns 200; `remove` returns 204; a `list` after `remove` is empty. Manually scan the `list` output once to confirm no token string appears anywhere (it won't — `ManagedProjectSchema` has no token field).

- [ ] **Step 4: Clean up**

```bash
docker stop engine-pg 2>/dev/null || true
```

- [ ] **Step 5: Confirm the public key matches the live private-key secret**

The brief supplies the live public key:

```
MCowBQYDK2VuAyEAAuidf7MeAA2Q0X6n8zQ/ug7mH0htTFwL8F6i8Uyxtig=
```

This plan cannot reach the live private-key secret (agentops-platform PR #3), so correspondence is verified in the platform follow-up PR by encrypting a known value with this public key and decrypting it with the mounted private key. Note it as a required check in that PR.

- [ ] **Step 6: Confirm the diff is scoped as described**

```bash
git diff main --stat
```

Skim: new files in `packages/contracts` (control-projects-api) and `packages/activities` (resolve-project-config); modifications in `packages/activities` (store + index), `packages/control` (routes + main + package.json), `packages/gateway` (config branch), `packages/cli` (project subcommands + config branch), and `charts/engine` (control-deployment + values). `packages/ui`, `packages/workflows`, `packages/policies`, `packages/worker` are untouched.

---

### Task 8: Open the PR, pass CI, and resolve the Bugbot review

**Files:** none (integration / review).

> Sequential and partly asynchronous — CI and Bugbot run on the remote PR.
> **HARD GATE: Do not mark this task complete until ALL Bugbot comments are
> resolved (fixed or replied to) AND CI is green. Check with
> `gh pr view --json reviews,comments` before claiming done.**
>
> **Merge prerequisite (security):** the `/api/projects` routes are gated by
> `CONTROL_CRUD_TOKEN`, but GitHub issue #4 (Traefik basic-auth on the control
> ingress) is still open. `control.ingress.enabled` stays `false` by default;
> do not flip it to `true` in this PR or the platform follow-up until issue #4
> lands. State this explicitly in the PR description.
>
> **Cross-repo follow-up (agentops-platform):** a separate PR must set
> `projectCredentialPublicKey` and a `controlCrudToken` Secret in the engine
> values, and confirm the public key corresponds to the private key already in
> PR #3. This repo's PR is mergeable without it (everything is off-by-default),
> but operators can't use CRUD until both land.
>
> Repo-specific note: per the data-layer plan, Bugbot has historically never
> responded on this repo's PRs despite retriggers — if `bugbot run` produces no
> review after a reasonable wait, note it in the PR (consistent with prior PRs)
> and proceed once CI is green and a subagent code review is clean. Also,
> merging to `main` here auto-builds/pushes images and bump-pushes to
> `agentops-platform` main (see `.github/workflows/ci.yaml`'s `bump-platform`
> job), so sequence the platform follow-up deliberately, not via auto-merge.

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
  --title "feat: managed-project registry admin surface (control CRUD + engine project CLI)"
```

PR body must call out: (a) the auth gating + issue #4 merge prerequisite; (b) the platform follow-up for the public key + crud-token secret; (c) that `GET /api/projects` never returns tokens and control never imports `decryptForManagedProject`.

- [ ] **Step 3: Subagent code review**

REQUIRED SUB-SKILL: `requesting-code-review`. Dispatch a code reviewer subagent over the diff (BASE_SHA = merge-base with `main`, HEAD_SHA = HEAD). Fix Critical and Important findings, commit, push, then proceed. Pay particular attention to anything touching `create-control-server.ts`'s auth guard, the store's `getByProject`, and `resolveProjectConfig` — the security property (control encrypt-only, never decrypt) and the 409/404 semantics live there.

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
Confirm no unresolved review threads remain, then mark this task complete. Leave the actual merge as an explicit operator decision: the `agentops-platform` follow-up (public key + crud-token secret) and issue #4 should land first for the feature to be usable + safe on a public ingress.
