import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateManagedProjectKeyPair, type PostgresManagedProjectStore } from '@agentops/activities';
import type { ManagedProject, UpsertManagedProjectRequest } from '@agentops/contracts';
import { createControlServer, type ControlDeps } from './create-control-server';

const CRUD_TOKEN = 'crud-secret';
const CRUD_HEADERS = { 'x-control-crud-token': CRUD_TOKEN };

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

async function postJsonWithHeaders(
  port: number,
  path: string,
  payload: unknown,
  headers: Record<string, string>,
) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
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
      projectCrudAuthToken: CRUD_TOKEN,
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
      const { status, body } = await postJsonWithHeaders(port, '/api/platform/runs', { prompt: '' }, CRUD_HEADERS);
      expect(status).toBe(400);
      expect((body as { error: string }).error).toBeTruthy();
      expect(start).not.toHaveBeenCalled();
    });

    it('starts the platform workflow with the correct taskQueue, args, and memo', async () => {
      await listen();
      const { status, body } = await postJsonWithHeaders(port, '/api/platform/runs', {
        prompt: 'investigate the last failures',
        hintRepos: ['est1908/agentops-engine'],
      }, CRUD_HEADERS);

      expect(status).toBe(202);
      expect(body).toEqual({ workflowId: 'platform-1', runId: 'run-1' });
      expect(start).toHaveBeenCalledTimes(1);
      const [, options] = start.mock.calls[0];
      expect(options.taskQueue).toBe('agentops-devcycle');
      expect(options.args).toEqual([{ prompt: 'investigate the last failures', hintRepos: ['est1908/agentops-engine'] }]);
      expect(options.memo).toEqual({ prompt: 'investigate the last failures' });
      expect(typeof options.workflowId).toBe('string');
    });

    it('uses a caller-supplied workflowId when provided', async () => {
      await listen();
      await postJsonWithHeaders(port, '/api/platform/runs', { prompt: 'x', workflowId: 'platform-my-run' }, CRUD_HEADERS);
      const [, options] = start.mock.calls[0];
      expect(options.workflowId).toBe('platform-my-run');
    });

    it('responds 409 when the workflowId is already in use', async () => {
      start.mockRejectedValueOnce(new WorkflowExecutionAlreadyStartedError('already started', 'platform-dup', 'platform'));
      await listen();
      const { status, body } = await postJsonWithHeaders(port, '/api/platform/runs', { prompt: 'x', workflowId: 'platform-dup' }, CRUD_HEADERS);
      expect(status).toBe(409);
      expect((body as { error: string }).error).toBeTruthy();
    });

    it('rejects requests with no token with 401', async () => {
      await listen();
      const res = await fetch(`http://127.0.0.1:${port}/api/platform/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'x' }),
      });
      expect(res.status).toBe(401);
      expect(start).not.toHaveBeenCalled();
    });

    it('rejects requests with a wrong token with 401', async () => {
      await listen();
      const { status } = await postJsonWithHeaders(port, '/api/platform/runs', { prompt: 'x' }, { 'x-control-crud-token': 'wrong' });
      expect(status).toBe(401);
      expect(start).not.toHaveBeenCalled();
    });

    it('returns 401 with the correct token but when CRUD token is unconfigured (fail-closed regression)', async () => {
      delete deps.projectCrudAuthToken;
      await listen();
      const { status } = await postJsonWithHeaders(port, '/api/platform/runs', { prompt: 'x' }, CRUD_HEADERS);
      expect(status).toBe(401);
      expect(start).not.toHaveBeenCalled();
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
    await store.upsert({ project: 'engine', repo: 'est1908/agentops-engine', token: 't1' }, publicKey);
    await store.upsert({ project: 'platform', repo: 'est1908/agentops-platform', token: 't2' }, publicKey);
    deps.managedProjectStore = store;
    await listen();

    const { status, body } = await getJson(port, '/api/registry/repos');
    expect(status).toBe(200);
    expect(body).toEqual({ repos: ['est1908/agentops-engine', 'est1908/agentops-platform'] });
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

  describe('devCycle routes', () => {
    function fakeStore(rows: Array<{ repo: string; project: string }>) {
      return {
        get: vi.fn(async (repo: string) => rows.find((row) => row.repo === repo) ?? null),
        list: vi.fn(async () => rows),
      } as never;
    }

    describe('POST /api/devcycle/runs', () => {
      it('rejects an empty prompt with 400', async () => {
        await listen();
        const { status } = await postJsonWithHeaders(port, '/api/devcycle/runs', { repo: 'est1908/agentops-engine', prompt: '' }, CRUD_HEADERS);
        expect(status).toBe(400);
        expect(start).not.toHaveBeenCalled();
      });

      it('rejects an unknown repo with 422 without starting a workflow', async () => {
        await listen();
        const { status, body } = await postJsonWithHeaders(port, '/api/devcycle/runs', { repo: 'nobody/unknown', prompt: 'x' }, CRUD_HEADERS);
        expect(status).toBe(422);
        expect((body as { error: string }).error).toContain('nobody/unknown');
        expect(start).not.toHaveBeenCalled();
      });

      it('starts devCycle with goal=prompt, no config, a prompt-<project>- workflowId, and the prompt memo', async () => {
        deps.managedProjectStore = fakeStore([{ repo: 'est1908/agentops-engine', project: 'engine' }]);
        start.mockResolvedValue({ workflowId: 'prompt-engine-t1', firstExecutionRunId: 'run-1' });
        await listen();
        const { status, body } = await postJsonWithHeaders(port, '/api/devcycle/runs', {
          repo: 'est1908/agentops-engine',
          prompt: 'add a widget',
          taskId: 't1',
        }, CRUD_HEADERS);

        expect(status).toBe(202);
        expect(body).toEqual({ workflowId: 'prompt-engine-t1', runId: 'run-1', taskId: 't1' });
        const [, options] = start.mock.calls[0];
        expect(options.workflowId).toBe('prompt-engine-t1');
        expect(options.args).toEqual([{ taskId: 't1', project: 'engine', repo: 'est1908/agentops-engine', goal: 'add a widget' }]);
        expect(options.memo).toEqual({ prompt: 'add a widget' });
      });

      it('resolves the project slug from the managed store', async () => {
        deps.managedProjectStore = fakeStore([{ repo: 'acme/app', project: 'acme-app' }]);
        start.mockResolvedValue({ workflowId: 'prompt-acme-app-t2', firstExecutionRunId: 'run-2' });
        await listen();
        const { status } = await postJsonWithHeaders(port, '/api/devcycle/runs', { repo: 'acme/app', prompt: 'x', taskId: 't2' }, CRUD_HEADERS);
        expect(status).toBe(202);
        const [, options] = start.mock.calls[0];
        expect(options.args[0].project).toBe('acme-app');
      });

      it('responds 409 when the workflowId is already in use', async () => {
        deps.managedProjectStore = fakeStore([{ repo: 'est1908/agentops-engine', project: 'engine' }]);
        start.mockRejectedValueOnce(new WorkflowExecutionAlreadyStartedError('already started', 'prompt-engine-dup', 'devCycle'));
        await listen();
        const { status } = await postJsonWithHeaders(port, '/api/devcycle/runs', {
          repo: 'est1908/agentops-engine',
          prompt: 'x',
          taskId: 'dup',
        }, CRUD_HEADERS);
        expect(status).toBe(409);
      });

      it('rejects requests with no token with 401', async () => {
        deps.managedProjectStore = fakeStore([{ repo: 'est1908/agentops-engine', project: 'engine' }]);
        await listen();
        const res = await fetch(`http://127.0.0.1:${port}/api/devcycle/runs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repo: 'est1908/agentops-engine', prompt: 'x' }),
        });
        expect(res.status).toBe(401);
        expect(start).not.toHaveBeenCalled();
      });

      it('rejects requests with a wrong token with 401', async () => {
        deps.managedProjectStore = fakeStore([{ repo: 'est1908/agentops-engine', project: 'engine' }]);
        await listen();
        const { status } = await postJsonWithHeaders(port, '/api/devcycle/runs', { repo: 'est1908/agentops-engine', prompt: 'x' }, { 'x-control-crud-token': 'wrong' });
        expect(status).toBe(401);
        expect(start).not.toHaveBeenCalled();
      });

      it('returns 401 with the correct token but when CRUD token is unconfigured (fail-closed regression)', async () => {
        delete deps.projectCrudAuthToken;
        deps.managedProjectStore = fakeStore([{ repo: 'est1908/agentops-engine', project: 'engine' }]);
        await listen();
        const { status } = await postJsonWithHeaders(port, '/api/devcycle/runs', { repo: 'est1908/agentops-engine', prompt: 'x' }, CRUD_HEADERS);
        expect(status).toBe(401);
        expect(start).not.toHaveBeenCalled();
      });
    });

    describe('GET /api/devcycle/runs', () => {
      it('lists devCycle executions with promptSnippet from memo', async () => {
        list.mockImplementation(async function* () {
          yield makeExecution({ workflowId: 'prompt-engine-t1', memo: { prompt: 'add a widget' } });
        });
        await listen();
        const { status, body } = await getJson(port, '/api/devcycle/runs');
        expect(status).toBe(200);
        const items = body as Array<{ workflowId: string; promptSnippet?: string }>;
        expect(items[0].workflowId).toBe('prompt-engine-t1');
        expect(items[0].promptSnippet).toBe('add a widget');
        expect(list).toHaveBeenCalledWith({ query: 'WorkflowType="devCycle"' });
      });
    });

    describe('GET /api/devcycle/runs/:workflowId', () => {
      const RUNNING_STATE = {
        taskId: 't1',
        stage: 'implement',
        status: 'running',
        blockReason: null,
        implementAttempts: 1,
        iterations: 1,
        cumulativeTokens: 1000,
        babysitRounds: 0,
        prRef: null,
        workspaceRef: 'ws-1',
        branch: 'task/t1',
        landingOutcome: null,
      };

      it('returns live state from the state query while RUNNING', async () => {
        getHandle.mockReturnValue({
          describe: vi.fn().mockResolvedValue({ runId: 'run-1', status: { code: 1, name: 'RUNNING' }, memo: { prompt: 'add a widget' } } as never),
          query: vi.fn().mockResolvedValue(RUNNING_STATE),
          result: vi.fn(),
        });
        await listen();
        const { status, body } = await getJson(port, '/api/devcycle/runs/prompt-engine-t1');
        const detail = body as { status: string; prompt: string; state?: { stage: string } };
        expect(status).toBe(200);
        expect(detail.status).toBe('RUNNING');
        expect(detail.prompt).toBe('add a widget');
        expect(detail.state?.stage).toBe('implement');
      });

      it('falls back to a bare detail when the state query fails (run closed mid-request)', async () => {
        getHandle.mockReturnValue({
          describe: vi.fn().mockResolvedValue({ runId: 'run-1', status: { code: 1, name: 'RUNNING' }, memo: {} } as never),
          query: vi.fn().mockRejectedValue(new Error('workflow completed')),
          result: vi.fn(),
        });
        await listen();
        const { status, body } = await getJson(port, '/api/devcycle/runs/prompt-engine-t1');
        const detail = body as { state?: unknown; error?: string };
        expect(status).toBe(200);
        expect(detail.state).toBeUndefined();
        expect(detail.error).toBeUndefined();
      });

      it('returns the final state as `state` for a COMPLETED run', async () => {
        getHandle.mockReturnValue({
          describe: vi.fn().mockResolvedValue({ runId: 'run-1', status: { code: 2, name: 'COMPLETED' }, memo: {} } as never),
          query: vi.fn(),
          result: vi.fn().mockResolvedValue({ ...RUNNING_STATE, stage: 'done', status: 'done', prRef: 'pr-1' }),
        });
        await listen();
        const { body } = await getJson(port, '/api/devcycle/runs/prompt-engine-t1');
        const detail = body as { state?: { prRef: string | null }; error?: string };
        expect(detail.state?.prRef).toBe('pr-1');
        expect(detail.error).toBeUndefined();
      });

      it('sets error (not a 500) when a completed result fails DevCycleStateSchema', async () => {
        getHandle.mockReturnValue({
          describe: vi.fn().mockResolvedValue({ runId: 'run-1', status: { code: 2, name: 'COMPLETED' }, memo: {} } as never),
          query: vi.fn(),
          result: vi.fn().mockResolvedValue({ nope: true }),
        });
        await listen();
        const { status, body } = await getJson(port, '/api/devcycle/runs/prompt-engine-t1');
        const detail = body as { state?: unknown; error?: string };
        expect(status).toBe(200);
        expect(detail.state).toBeUndefined();
        expect(detail.error).toBeTruthy();
      });

      it('responds 404 when describe() throws', async () => {
        getHandle.mockReturnValue({ describe: vi.fn().mockRejectedValue(new Error('not found')), query: vi.fn(), result: vi.fn() });
        await listen();
        const { status } = await getJson(port, '/api/devcycle/runs/nope');
        expect(status).toBe(404);
      });
    });

    describe('GET /api/devcycle/targets', () => {
      it('returns an empty target list when no managed-project store is configured', async () => {
        await listen();
        const { status, body } = await getJson(port, '/api/devcycle/targets');
        expect(status).toBe(200);
        expect(body).toEqual({ targets: [] });
      });

      it('returns managed projects only (the DB is the single source of truth), sorted by project', async () => {
        deps.managedProjectStore = fakeStore([
          { repo: 'est1908/agentops-engine', project: 'engine-managed' },
          { repo: 'acme/app', project: 'acme-app' },
        ]);
        await listen();
        const { body } = await getJson(port, '/api/devcycle/targets');
        const { targets } = body as { targets: Array<{ repo: string; project: string }> };
        // sorted by project slug: 'acme-app' before 'engine-managed'; no static entries
        expect(targets).toEqual([
          { repo: 'acme/app', project: 'acme-app' },
          { repo: 'est1908/agentops-engine', project: 'engine-managed' },
        ]);
      });
    });
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
    async getByLinearTeamKey(teamKey: string) {
      const row = rows.find((r) => r.linearTeamKey === teamKey);
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

  it('POST 409s on a duplicate linearTeamKey across two different projects', async () => {
    await listen();
    await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CRUD_HEADERS },
      body: JSON.stringify({
        project: 'acme-linear-a',
        repo: 'acme/linear-a',
        token: 'ghp_a',
        trackerType: 'linear',
        linearTeamKey: 'ENG',
        linearTriggerLabelId: '11111111-1111-1111-1111-111111111111',
        linearToken: 'lin_a',
      }),
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CRUD_HEADERS },
      body: JSON.stringify({
        project: 'acme-linear-b',
        repo: 'acme/linear-b',
        token: 'ghp_b',
        trackerType: 'linear',
        linearTeamKey: 'ENG',
        linearTriggerLabelId: '22222222-2222-2222-2222-222222222222',
        linearToken: 'lin_b',
      }),
    });
    expect(res.status).toBe(409);
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

  it('returns 401 with a wrong token of the same length as the configured token', async () => {
    await listen();
    const wrongSameLength = 'crud-secXet'; // same length as 'crud-secret'
    expect((await getJsonWithHeaders(port, '/api/projects', { 'x-control-crud-token': wrongSameLength })).status).toBe(401);
  });

  it('returns 401 with a wrong token of a different length than the configured token', async () => {
    await listen();
    const wrongDiffLength = 'short'; // different length from 'crud-secret'
    expect((await getJsonWithHeaders(port, '/api/projects', { 'x-control-crud-token': wrongDiffLength })).status).toBe(401);
  });

  it('returns 503 when CRUD is not configured (no auth token)', async () => {
    delete deps.projectCrudAuthToken;
    await listen();
    expect((await getJsonWithHeaders(port, '/api/projects', CRUD_HEADERS)).status).toBe(503);
  });
});

describe('createControlServer agents API', () => {
  let server: ReturnType<typeof createControlServer>;
  let port: number;
  let trigger: ReturnType<typeof vi.fn>;
  let deps: ControlDeps;

  beforeEach(() => {
    trigger = vi.fn().mockResolvedValue(undefined);
    const list = async function* () {
      yield {
        scheduleId: 'agent:acme:nb',
        memo: { project: 'acme', agentName: 'nb', workflowType: 'whiteboxBugHunt' },
        schedule: { spec: { cronExpressions: ['0 2 * * *'] } },
        info: { paused: false },
      };
      yield { scheduleId: 'reconcile:all' };
    };
    deps = {
      client: {
        workflow: { start: vi.fn(), list: async function* () {}, getHandle: vi.fn() },
        schedule: { list, getHandle: () => ({ trigger }) },
      } as never,
      taskQueue: 'agentops-engine',
      namespace: 'default',
      temporalUiBaseUrl: 'https://temporal.example',
      projectCrudAuthToken: CRUD_TOKEN,
    };
    server = createControlServer(deps);
    return new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterEach(() => {
    server?.close();
  });

  it('GET /api/agents lists agent:* schedules (ungated)', async () => {
    const { status, body } = await getJson(port, '/api/agents');
    expect(status).toBe(200);
    expect((body as { agents: Array<{ project: string }> }).agents).toHaveLength(1);
    expect((body as { agents: Array<{ project: string }> }).agents[0].project).toBe('acme');
  });

  it('POST /api/agents/:id/run triggers the schedule (gated: 401 without token)', async () => {
    const unauth = await fetch(`http://127.0.0.1:${port}/api/agents/${encodeURIComponent('agent:acme:nb')}/run`, {
      method: 'POST',
    });
    expect(unauth.status).toBe(401);

    const ok = await fetch(`http://127.0.0.1:${port}/api/agents/${encodeURIComponent('agent:acme:nb')}/run`, {
      method: 'POST',
      headers: CRUD_HEADERS,
    });
    expect(ok.status).toBe(202);
    expect(trigger).toHaveBeenCalled();
  });

  it('POST /api/agents/:id/run returns 401 with no token when CRUD token is unconfigured (fail-closed regression)', async () => {
    delete deps.projectCrudAuthToken;
    const server2 = createControlServer(deps);
    const port2 = await new Promise<number>((resolve) => {
      server2.listen(0, () => {
        resolve(((server2.address() as AddressInfo).port));
      });
    });

    try {
      const res = await fetch(`http://127.0.0.1:${port2}/api/agents/${encodeURIComponent('agent:acme:nb')}/run`, {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    } finally {
      server2.close();
    }
  });
});

describe('createControlServer self-heal settings API', () => {
  let server: ReturnType<typeof createControlServer>;
  let port: number;
  let create: ReturnType<typeof vi.fn>;
  let del: ReturnType<typeof vi.fn>;
  let deps: ControlDeps;

  beforeEach(() => {
    create = vi.fn().mockResolvedValue({});
    del = vi.fn().mockResolvedValue(undefined);
    const engineSettingsStore = {
      ensureSchema: vi.fn().mockResolvedValue(undefined),
      seedIfEmpty: vi.fn().mockResolvedValue(false),
      getSelfHeal: vi.fn().mockResolvedValue({ enabled: true, cron: '*/30 * * * *' }),
      setSelfHeal: vi.fn().mockImplementation(async (patch: { enabled?: boolean }) => ({
        enabled: patch.enabled ?? true,
        cron: '*/30 * * * *',
      })),
    };
    deps = {
      client: {
        workflow: { start: vi.fn(), list: async function* () {}, getHandle: vi.fn() },
        schedule: {
          list: async function* () {},
          create,
          getHandle: (id: string) => ({
            delete: del,
            describe: id === 'self-heal' ? vi.fn().mockResolvedValue({}) : vi.fn().mockRejectedValue(new Error('not found')),
          }),
        },
      } as never,
      taskQueue: 'agentops-engine',
      namespace: 'default',
      temporalUiBaseUrl: 'https://temporal.example',
      projectCrudAuthToken: CRUD_TOKEN,
      engineSettingsStore: engineSettingsStore as never,
    };
    server = createControlServer(deps);
    return new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterEach(() => {
    server?.close();
  });

  it('GET /api/settings/self-heal returns stored settings (ungated)', async () => {
    const { status, body } = await getJson(port, '/api/settings/self-heal');
    expect(status).toBe(200);
    expect(body).toMatchObject({ enabled: true, cron: '*/30 * * * *', scheduleActive: true });
  });

  it('PUT /api/settings/self-heal updates enabled and applies the schedule (gated)', async () => {
    const unauth = await fetch(`http://127.0.0.1:${port}/api/settings/self-heal`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(unauth.status).toBe(401);

    const ok = await fetch(`http://127.0.0.1:${port}/api/settings/self-heal`, {
      method: 'PUT',
      headers: { ...CRUD_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(ok.status).toBe(200);
    expect(del).toHaveBeenCalled();
    expect(((await ok.json()) as { enabled: boolean }).enabled).toBe(false);
  });
});
