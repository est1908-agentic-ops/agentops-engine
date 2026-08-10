import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedProject, ManagedProjectStore } from '@agentops/contracts';
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

function makeManagedProject(overrides: Partial<ManagedProject> & { repo: string; project: string }): ManagedProject {
  return {
    id: overrides.repo,
    trackerType: 'github',
    credentialSet: true,
    config: null,
    createdAt: '2026-07-08T12:00:00.000Z',
    updatedAt: '2026-07-08T12:00:00.000Z',
    ...overrides,
  } as ManagedProject;
}

// A fake FileManagedProjectStore -- control never writes to this registry
// anymore (the CRUD was retired), so the fake only needs the read-only
// ManagedProjectStore surface (get/getByProject/getByLinearTeamKey/list).
function fakeManagedProjectStore(projects: ManagedProject[]): ManagedProjectStore {
  return {
    async get(repo: string) {
      return projects.find((p) => p.repo === repo) ?? null;
    },
    async getByProject(project: string) {
      return projects.find((p) => p.project === project) ?? null;
    },
    async getByLinearTeamKey(teamKey: string) {
      return projects.find((p) => p.trackerType === 'linear' && p.linearTeamKey === teamKey) ?? null;
    },
    async list() {
      return [...projects].sort((a, b) => a.project.localeCompare(b.project));
    },
  };
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

    it('rejects a request body that exceeds maxBodyBytes with 413', async () => {
      deps.maxBodyBytes = 16;
      await listen();
      const { status, body } = await postJsonWithHeaders(port, '/api/platform/runs', { prompt: 'add a really long prompt' }, CRUD_HEADERS);
      expect(status).toBe(413);
      expect((body as { error: string }).error).toBeTruthy();
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
    deps.managedProjectStore = fakeManagedProjectStore([
      makeManagedProject({ project: 'engine', repo: 'est1908/agentops-engine' }),
      makeManagedProject({ project: 'platform', repo: 'est1908/agentops-platform' }),
    ]);
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

// --- managed-project routes (read-only) ---

describe('createControlServer managed-project routes (read-only)', () => {
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
    deps = {
      client: { workflow: { start: vi.fn(), list: vi.fn(), getHandle: vi.fn() } } as never,
      taskQueue: 'agentops-devcycle',
      namespace: 'default',
      temporalUiBaseUrl: 'https://temporal.example',
      managedProjectStore: fakeManagedProjectStore([
        makeManagedProject({ project: 'acme-web', repo: 'acme/web' }),
        makeManagedProject({
          project: 'acme-linear',
          repo: 'acme/linear-tracked',
          trackerType: 'linear',
          linearTeamKey: 'ENG',
          linearTriggerLabelId: 'label-uuid',
          linearCredentialSet: true,
        }),
      ]),
      // No projectCrudAuthToken set at all -- these routes must not require one.
    };
  });

  afterEach(() => {
    server?.close();
  });

  it('GET /api/projects lists projects with no auth token, and never echoes a token', async () => {
    await listen();
    const { status, body } = await getJson(port, '/api/projects');
    expect(status).toBe(200);
    const projects = body as Array<Record<string, unknown>>;
    expect(projects).toHaveLength(2);
    expect(projects.map((p) => p.project).sort()).toEqual(['acme-linear', 'acme-web']);
    expect(projects[0].token).toBeUndefined();
    expect(projects[0].encryptedToken).toBeUndefined();
  });

  it('GET /api/projects/:repo returns 200 and URL-decodes the repo, or 404', async () => {
    await listen();
    const found = await getJson(port, `/api/projects/${encodeURIComponent('acme/web')}`);
    expect(found.status).toBe(200);
    expect((found.body as { repo: string }).repo).toBe('acme/web');

    const missing = await getJson(port, `/api/projects/${encodeURIComponent('acme/nope')}`);
    expect(missing.status).toBe(404);
  });

  it('GET /api/projects/:repo returns the linear-tracked project shape', async () => {
    await listen();
    const { status, body } = await getJson(port, `/api/projects/${encodeURIComponent('acme/linear-tracked')}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ trackerType: 'linear', linearTeamKey: 'ENG', linearCredentialSet: true });
  });

  it('GET /api/projects returns an empty list when no store is configured (no crash)', async () => {
    delete deps.managedProjectStore;
    await listen();
    const { status, body } = await getJson(port, '/api/projects');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('there is no write path -- POST/PUT/DELETE all 404', async () => {
    await listen();
    const post = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'new-one', repo: 'acme/new', token: 'ghp_x' }),
    });
    expect(post.status).toBe(404);

    const put = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent('acme/web')}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'ghp_new' }),
    });
    expect(put.status).toBe(404);

    const del = await fetch(`http://127.0.0.1:${port}/api/projects/${encodeURIComponent('acme/web')}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(404);
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
