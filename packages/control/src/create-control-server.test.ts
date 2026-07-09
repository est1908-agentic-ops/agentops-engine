import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateManagedProjectKeyPair, type PostgresManagedProjectStore } from '@agentops/activities';
import type { ManagedProject, UpsertManagedProjectRequest } from '@agentops/contracts';
import { createControlServer, type ControlDeps } from './create-control-server';

function makeExecution(overrides: Record<string, unknown> = {}) {
  return {
    workflowId: 'platform-1',
    runId: 'run-1',
    status: { code: 1, name: 'RUNNING' },
    startTime: new Date('2026-07-07T00:00:00.000Z'),
    closeTime: undefined,
    memo: {},
    ...overrides,
  };
}

async function getJson(port: number, path: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const body: unknown = await res.json();
  return { status: res.status, body };
}

async function postJson(port: number, path: string, payload: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body: unknown = await res.json();
  return { status: res.status, body };
}

describe('createControlServer', () => {
  let server: ReturnType<typeof createControlServer>;
  let port: number;
  let start: ReturnType<typeof vi.fn>;
  let list: ReturnType<typeof vi.fn>;
  let getHandle: ReturnType<typeof vi.fn>;
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
    start = vi.fn().mockResolvedValue({ workflowId: 'platform-1', firstExecutionRunId: 'run-1' });
    list = vi.fn(async function* () {
      yield makeExecution();
    });
    getHandle = vi.fn();
    deps = {
      client: { workflow: { start, list, getHandle } } as never,
      taskQueue: 'agentops-devcycle',
      namespace: 'default',
      temporalUiBaseUrl: 'https://temporal.example',
    };
  });

  afterEach(() => {
    server?.close();
  });

  it('GET /healthz responds 200 without touching Temporal', async () => {
    await listen();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(start).not.toHaveBeenCalled();
  });

  describe('POST /api/platform/runs', () => {
    it('rejects an empty prompt with 400', async () => {
      await listen();
      const { status, body } = await postJson(port, '/api/platform/runs', { prompt: '' });
      expect(status).toBe(400);
      expect((body as { error: string }).error).toBeTruthy();
      expect(start).not.toHaveBeenCalled();
    });

    it('starts the platform workflow with the correct taskQueue, args, and memo', async () => {
      await listen();
      const { status, body } = await postJson(port, '/api/platform/runs', {
        prompt: 'investigate the last failures',
        hintRepos: ['flair-hr/agentops-engine'],
      });

      expect(status).toBe(202);
      expect(body).toEqual({ workflowId: 'platform-1', runId: 'run-1' });
      expect(start).toHaveBeenCalledTimes(1);
      const [, options] = start.mock.calls[0];
      expect(options.taskQueue).toBe('agentops-devcycle');
      expect(options.args).toEqual([{ prompt: 'investigate the last failures', hintRepos: ['flair-hr/agentops-engine'] }]);
      expect(options.memo).toEqual({ prompt: 'investigate the last failures' });
      expect(typeof options.workflowId).toBe('string');
    });

    it('uses a caller-supplied workflowId when provided', async () => {
      await listen();
      await postJson(port, '/api/platform/runs', { prompt: 'x', workflowId: 'platform-my-run' });
      const [, options] = start.mock.calls[0];
      expect(options.workflowId).toBe('platform-my-run');
    });

    it('responds 409 when the workflowId is already in use', async () => {
      start.mockRejectedValueOnce(new WorkflowExecutionAlreadyStartedError('already started', 'platform-dup', 'platform'));
      await listen();
      const { status, body } = await postJson(port, '/api/platform/runs', { prompt: 'x', workflowId: 'platform-dup' });
      expect(status).toBe(409);
      expect((body as { error: string }).error).toBeTruthy();
    });
  });

  describe('GET /api/platform/runs', () => {
    it('maps visibility results into RunListItem shape, including promptSnippet from memo', async () => {
      list.mockImplementation(async function* () {
        yield makeExecution({ memo: { prompt: 'a'.repeat(150) } });
      });
      await listen();
      const { status, body } = await getJson(port, '/api/platform/runs');
      expect(status).toBe(200);
      expect(body).toHaveLength(1);
      const items = body as Array<{ workflowId: string; promptSnippet: string }>;
      expect(items[0].workflowId).toBe('platform-1');
      expect(items[0].promptSnippet.length).toBeLessThan(150);
    });

    it('respects the limit query param', async () => {
      list.mockImplementation(async function* () {
        yield makeExecution({ workflowId: 'platform-1' });
        yield makeExecution({ workflowId: 'platform-2' });
        yield makeExecution({ workflowId: 'platform-3' });
      });
      await listen();
      const { body } = await getJson(port, '/api/platform/runs?limit=2');
      expect(body).toHaveLength(2);
    });
  });

  describe('GET /api/platform/runs/:workflowId', () => {
    it('returns a parsed result for a completed run', async () => {
      getHandle.mockReturnValue({
        describe: vi.fn().mockResolvedValue({
          runId: 'run-1',
          status: { code: 2, name: 'COMPLETED' },
          memo: { prompt: 'investigate' },
        } as never),
        result: vi.fn().mockResolvedValue({ summary: 'all quiet', actionsTaken: [], childWorkflows: [] }),
      });
      await listen();
      const { status, body } = await getJson(port, '/api/platform/runs/platform-1');
      const detail = body as {
        status: string;
        prompt: string;
        result: { summary: string };
        error?: string;
      };
      expect(status).toBe(200);
      expect(detail.status).toBe('COMPLETED');
      expect(detail.prompt).toBe('investigate');
      expect(detail.result.summary).toBe('all quiet');
      expect(detail.error).toBeUndefined();
    });

    it('returns no result field for a running run', async () => {
      getHandle.mockReturnValue({
        describe: vi.fn().mockResolvedValue({ runId: 'run-1', status: { code: 1, name: 'RUNNING' }, memo: {} } as never),
        result: vi.fn(),
      });
      await listen();
      const { body } = await getJson(port, '/api/platform/runs/platform-1');
      const detail = body as { status: string; result?: unknown; error?: string };
      expect(detail.status).toBe('RUNNING');
      expect(detail.result).toBeUndefined();
      expect(detail.error).toBeUndefined();
    });

    it('responds 404 when describe() throws (unknown workflowId)', async () => {
      getHandle.mockReturnValue({ describe: vi.fn().mockRejectedValue(new Error('not found')), result: vi.fn() });
      await listen();
      const { status } = await getJson(port, '/api/platform/runs/does-not-exist');
      expect(status).toBe(404);
    });

    it('sets error (not a 500) when a completed run\'s output fails PlatformAgentResultSchema', async () => {
      getHandle.mockReturnValue({
        describe: vi.fn().mockResolvedValue({ runId: 'run-1', status: { code: 2, name: 'COMPLETED' }, memo: {} } as never),
        result: vi.fn().mockResolvedValue({ nope: true }),
      });
      await listen();
      const { status, body } = await getJson(port, '/api/platform/runs/platform-1');
      const detail = body as { result?: unknown; error?: string };
      expect(status).toBe(200);
      expect(detail.result).toBeUndefined();
      expect(detail.error).toBeTruthy();
    });

    it('sets a status-based error for a terminal non-completed run', async () => {
      getHandle.mockReturnValue({
        describe: vi.fn().mockResolvedValue({ runId: 'run-1', status: { code: 3, name: 'FAILED' }, memo: {} } as never),
        result: vi.fn(),
      });
      await listen();
      const { body } = await getJson(port, '/api/platform/runs/platform-1');
      const detail = body as { status: string; error: string };
      expect(detail.status).toBe('FAILED');
      expect(detail.error).toContain('FAILED');
    });
  });

  it('GET /api/registry/repos returns repos from the managed-project store', async () => {
    const store = createFakeStore();
    const { publicKey } = generateManagedProjectKeyPair();
    await store.upsert({ project: 'engine', repo: 'flair-hr/agentops-engine', token: 't1' }, publicKey);
    await store.upsert({ project: 'platform', repo: 'flair-hr/agentops-platform', token: 't2' }, publicKey);
    deps.managedProjectStore = store;
    await listen();

    const { status, body } = await getJson(port, '/api/registry/repos');
    expect(status).toBe(200);
    expect(body).toEqual({ repos: ['flair-hr/agentops-engine', 'flair-hr/agentops-platform'] });
  });

  it('GET /api/registry/repos returns no hints when no managed-project store is configured', async () => {
    await listen();
    const { status, body } = await getJson(port, '/api/registry/repos');
    expect(status).toBe(200);
    expect(body).toEqual({ repos: [] });
  });

  it('404s an unknown route with no uiDistPath configured', async () => {
    await listen();
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });

  describe('static file fallback', () => {
    let uiDistPath: string;

    beforeEach(async () => {
      uiDistPath = await mkdtemp(join(tmpdir(), 'control-ui-dist-'));
      await writeFile(join(uiDistPath, 'index.html'), '<html>console</html>');
    });

    afterEach(async () => {
      await rm(uiDistPath, { recursive: true, force: true });
    });

    it('serves the built SPA shell when uiDistPath is configured', async () => {
      deps.uiDistPath = uiDistPath;
      await listen();
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toBe('<html>console</html>');
    });
  });
});

// --- managed-project CRUD test helpers + suite ---

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
  // "encrypted token"s here are just placeholder strings. Not a re-test of
  // PostgresManagedProjectStore's own business rules (see
  // postgres-managed-project-store.test.ts) -- just enough fidelity for
  // control's HTTP-routing/auth/error-shape tests.
  interface FakeRow {
    id: string;
    project: string;
    repo: string;
    trackerType: 'github' | 'linear';
    config: unknown;
    createdAt: string;
    updatedAt: string;
    _token: string;
    linearTeamKey?: string;
    linearTriggerLabelId?: string;
    _linearToken?: string;
  }
  const rows: FakeRow[] = [];
  let nextId = 1;
  function toManagedProject(row: FakeRow): ManagedProject {
    const base = {
      id: row.id,
      project: row.project,
      repo: row.repo,
      credentialSet: true,
      config: (row.config ?? null) as ManagedProject['config'],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    if (row.trackerType === 'linear') {
      return {
        ...base,
        trackerType: 'linear',
        linearTeamKey: row.linearTeamKey!,
        linearTriggerLabelId: row.linearTriggerLabelId!,
        linearCredentialSet: Boolean(row._linearToken),
      };
    }
    return { ...base, trackerType: 'github' };
  }
  return {
    async get(repo: string) {
      const row = rows.find((r) => r.repo === repo);
      return row ? toManagedProject(row) : null;
    },
    async getByProject(project: string) {
      const row = rows.find((r) => r.project === project);
      return row ? toManagedProject(row) : null;
    },
    async list() {
      return [...rows].sort((a, b) => a.project.localeCompare(b.project)).map(toManagedProject);
    },
    async upsert(input: UpsertManagedProjectRequest, _publicKey: string) {
      const existingIndex = rows.findIndex((r) => r.repo === input.repo);
      const now = new Date().toISOString();
      const trackerType = existingIndex >= 0 ? rows[existingIndex].trackerType : input.trackerType ?? 'github';
      if (existingIndex >= 0 && trackerType !== 'linear' && (input.linearTeamKey || input.linearTriggerLabelId || input.linearToken)) {
        throw new Error(`project "${input.repo}" is not linear-tracked -- cannot set linear fields on it`);
      }
      if (existingIndex >= 0) {
        const existing = rows[existingIndex];
        rows[existingIndex] = {
          ...existing,
          project: input.project,
          config: input.config === undefined ? existing.config : input.config,
          _token: input.token ?? existing._token,
          linearTeamKey: input.linearTeamKey ?? existing.linearTeamKey,
          linearTriggerLabelId: input.linearTriggerLabelId ?? existing.linearTriggerLabelId,
          _linearToken: input.linearToken ?? existing._linearToken,
          updatedAt: now,
        };
        return toManagedProject(rows[existingIndex]);
      }
      const row: FakeRow = {
        id: String(nextId++),
        project: input.project,
        repo: input.repo,
        trackerType,
        config: input.config ?? null,
        createdAt: now,
        updatedAt: now,
        _token: input.token ?? '',
        linearTeamKey: input.linearTeamKey,
        linearTriggerLabelId: input.linearTriggerLabelId,
        _linearToken: input.linearToken,
      };
      rows.push(row);
      return toManagedProject(row);
    },
    async remove(repo: string) {
      const i = rows.findIndex((r) => r.repo === repo);
      if (i >= 0) rows.splice(i, 1);
    },
  } as unknown as PostgresManagedProjectStore;
}

const CRUD_TOKEN = 'crud-secret';
const CRUD_HEADERS = { 'x-control-crud-token': CRUD_TOKEN };

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

  it('POST creates a linear-tracked project with all linear fields', async () => {
    await listen();
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CRUD_HEADERS },
      body: JSON.stringify({
        project: 'acme-linear',
        repo: 'acme/linear-tracked',
        token: 'ghp_secret',
        trackerType: 'linear',
        linearTeamKey: 'ENG',
        linearTriggerLabelId: 'label-uuid',
        linearToken: 'lin_secret',
      }),
    });
    const created = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(201);
    expect(created).toMatchObject({ trackerType: 'linear', linearTeamKey: 'ENG', linearCredentialSet: true });
    expect(created.linearToken).toBeUndefined();
  });

  it('POST 400s a linear-tracked create missing a linear field', async () => {
    await listen();
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CRUD_HEADERS },
      body: JSON.stringify({ project: 'acme-linear', repo: 'acme/linear-tracked', token: 'ghp_secret', trackerType: 'linear' }),
    });
    expect(res.status).toBe(400);
  });

  it('PUT rotates a linear-tracked project token independently of the github token', async () => {
    await listen();
    await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CRUD_HEADERS },
      body: JSON.stringify({
        project: 'acme-linear',
        repo: 'acme/linear-tracked',
        token: 'ghp_secret',
        trackerType: 'linear',
        linearTeamKey: 'ENG',
        linearTriggerLabelId: 'label-uuid',
        linearToken: 'lin_old',
      }),
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent('acme/linear-tracked')}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...CRUD_HEADERS },
      body: JSON.stringify({ linearToken: 'lin_new' }),
    });
    const updated = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(updated.trackerType).toBe('linear');
  });

  it('PUT 400s when setting linear fields on a github-tracked project', async () => {
    await listen();
    await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CRUD_HEADERS },
      body: JSON.stringify({ project: 'acme-web', repo: 'acme/web', token: 'ghp_a' }),
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent('acme/web')}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...CRUD_HEADERS },
      body: JSON.stringify({ linearTeamKey: 'ENG' }),
    });
    expect(res.status).toBe(400);
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
    expect((body as { project: string }).project).toBe('acme-web'); // unchanged identity
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
    expect((await getJsonWithHeaders(port, '/api/projects', { 'x-control-crud-token': 'wrong' })).status).toBe(401);
  });

  it('returns 503 when CRUD is not configured (no auth token)', async () => {
    delete deps.projectCrudAuthToken;
    await listen();
    expect((await getJsonWithHeaders(port, '/api/projects', CRUD_HEADERS)).status).toBe(503);
  });
});
