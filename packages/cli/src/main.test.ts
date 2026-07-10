import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptForManagedProject, generateManagedProjectKeyPair, loadProjectConfig, type PostgresManagedProjectStore } from '@agentops/activities';
import { GithubScmPort, MemoryScmPort } from '@agentops/ports';
import { buildControlRequest, buildStartScmPort, cmdProject, controlBaseUrl, controlCrudHeaders, parseFlags, seedDemoAgentopsConfig } from './main';

describe('seedDemoAgentopsConfig', () => {
  it('produces a config that keeps every stage on the stub backend', async () => {
    const scm = new MemoryScmPort();
    seedDemoAgentopsConfig(scm, 'demo/repo');

    const config = await loadProjectConfig(scm, 'demo/repo');

    expect(config.fastVerifyCommands).toEqual(['pnpm lint']);
    expect(config.fullVerifyCommands).toEqual(['pnpm test']);
    for (const stage of ['context', 'assess', 'design', 'plan', 'implement', 'full_verify', 'review'] as const) {
      expect(config.routing[stage]).toEqual({ backend: 'stub', model: 'stub-v1' });
    }
  });
});

describe('parseFlags', () => {
  it('parses --flag value pairs into an object', () => {
    expect(parseFlags(['--goal', 'do it', '--repo', 'o/r'])).toEqual({ goal: 'do it', repo: 'o/r' });
  });

  it('throws a clear error when a flag has no value', () => {
    expect(() => parseFlags(['--goal'])).toThrow(/missing value for --goal/);
  });

  it('throws when a flag value looks like another flag', () => {
    expect(() => parseFlags(['--goal', '--repo', 'o/r'])).toThrow(/missing value for --goal/);
  });
});

describe('buildStartScmPort', () => {
  it('returns a seeded MemoryScmPort when no managed-project DB is configured', async () => {
    const scm = await buildStartScmPort(undefined, 'demo', 'demo/repo');

    expect(scm).toBeInstanceOf(MemoryScmPort);
    const config = await loadProjectConfig(scm, 'demo/repo');
    expect(config.routing.implement).toEqual({ backend: 'stub', model: 'stub-v1' });
  });

  it('returns a GithubScmPort for a repo registered under the given project', async () => {
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const store = {
      async get(repo: string) {
        return repo === 'octocat/demo' ? { id: '1', project: 'my-project', repo, credentialSet: true, config: null, createdAt: '', updatedAt: '' } : null;
      },
      async getEncryptedToken(repo: string) {
        return repo === 'octocat/demo' ? encryptForManagedProject(publicKey, 'fake-token') : null;
      },
    } as unknown as PostgresManagedProjectStore;

    const scm = await buildStartScmPort({ store, privateKey }, 'my-project', 'octocat/demo');

    expect(scm).toBeInstanceOf(GithubScmPort);
  });

  it('throws when the repo is not registered', async () => {
    const store = {
      async get() {
        return null;
      },
      async getEncryptedToken() {
        return null;
      },
    } as unknown as PostgresManagedProjectStore;

    await expect(buildStartScmPort({ store, privateKey: 'unused' }, 'my-project', 'octocat/other')).rejects.toThrow(
      /no project registered/,
    );
  });

  it('throws when the repo is registered under a different project', async () => {
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const store = {
      async get(repo: string) {
        return repo === 'octocat/demo' ? { id: '1', project: 'my-project', repo, credentialSet: true, config: null, createdAt: '', updatedAt: '' } : null;
      },
      async getEncryptedToken(repo: string) {
        return repo === 'octocat/demo' ? encryptForManagedProject(publicKey, 'fake-token') : null;
      },
    } as unknown as PostgresManagedProjectStore;

    await expect(buildStartScmPort({ store, privateKey }, 'wrong-project', 'octocat/demo')).rejects.toThrow(
      /registered under project "my-project"/,
    );
  });
});

describe('engine project (control HTTP client)', () => {
  const originalFetch = globalThis.fetch;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.CONTROL_BASE_URL = 'http://control.test:3001';
    process.env.CONTROL_CRUD_TOKEN = 'tok';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
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
    expect((init.headers as Record<string, string>)['x-control-crud-token']).toBe('tok');
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

  it('add passes tracker-type/linear-* flags through to the request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await cmdProject([
      'add',
      '--project',
      'acme-linear',
      '--repo',
      'acme/linear-tracked',
      '--token',
      'ghp_x',
      '--tracker-type',
      'linear',
      '--linear-team-key',
      'ENG',
      '--linear-trigger-label-id',
      'label-uuid',
      '--linear-token',
      'lin_x',
    ]);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string)).toMatchObject({
      trackerType: 'linear',
      linearTeamKey: 'ENG',
      linearTriggerLabelId: 'label-uuid',
      linearToken: 'lin_x',
    });
  });

  it('update passes linear-* flags through to the request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await cmdProject(['update', '--repo', 'acme/linear-tracked', '--linear-token', 'lin_new']);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({ linearToken: 'lin_new' });
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
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ config: null });
  });

  it('remove DELETEs and URL-encodes the repo', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
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
