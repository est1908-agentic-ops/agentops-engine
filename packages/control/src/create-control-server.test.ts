import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      registry: ['flair-hr/agentops-engine', 'flair-hr/agentops-platform'],
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

  it('GET /api/registry/repos returns the configured registry', async () => {
    await listen();
    const { status, body } = await getJson(port, '/api/registry/repos');
    expect(status).toBe(200);
    expect(body).toEqual({ repos: ['flair-hr/agentops-engine', 'flair-hr/agentops-platform'] });
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
