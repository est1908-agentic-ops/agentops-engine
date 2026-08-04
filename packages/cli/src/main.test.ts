import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadProjectConfig } from '@agentops/activities';
import type { ManagedProjectStore } from '@agentops/contracts';
import { GithubScmPort, MemoryScmPort } from '@agentops/ports';
import { buildCliManagedProjectDeps, buildControlRequest, buildStartScmPort, cmdProject, controlBaseUrl, controlCrudHeaders, parseFlags, seedDemoAgentopsConfig } from './main';

describe('seedDemoAgentopsConfig', () => {
  it('produces a config that keeps every stage on the stub backend', async () => {
    const scm = new MemoryScmPort();
    seedDemoAgentopsConfig(scm, 'demo/repo');

    const config = await loadProjectConfig(scm, 'demo/repo');

    expect(config.fastVerifyCommands).toEqual(['pnpm lint']);
    expect(config.fullVerifyCommands).toEqual(['pnpm test']);
    for (const stage of ['context', 'assess', 'design', 'plan', 'implement', 'full_verify', 'review'] as const) {
      expect(config.routing[stage]).toEqual({ tier: 'stub' });
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

describe('buildCliManagedProjectDeps', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads the requested provider token from the local environment', async () => {
    vi.stubEnv('KUBERNETES_SERVICE_HOST', '');
    vi.stubEnv('MANAGED_PROJECTS_DIR', '/tmp/unused-managed-projects');
    vi.stubEnv('GITHUB_TOKEN', 'ghp_local');
    vi.stubEnv('LINEAR_API_TOKEN', 'lin_local');
    const deps = buildCliManagedProjectDeps();

    await expect(deps.resolveToken('project-token', 'GITHUB_TOKEN')).resolves.toBe('ghp_local');
    await expect(deps.resolveToken('project-token', 'LINEAR_API_TOKEN')).resolves.toBe('lin_local');
  });
});

describe('buildStartScmPort', () => {
  it('returns a seeded MemoryScmPort when no managed-project DB is configured', async () => {
    const scm = await buildStartScmPort(undefined, 'demo', 'demo/repo');

    expect(scm).toBeInstanceOf(MemoryScmPort);
    const config = await loadProjectConfig(scm, 'demo/repo');
    expect(config.routing.implement).toEqual({ tier: 'stub' });
  });

  it('returns a GithubScmPort for a repo registered under the given project', async () => {
    const store = {
      async get(repo: string) {
        return repo === 'octocat/demo'
          ? {
              id: '1',
              project: 'my-project',
              repo,
              credentialSet: true,
              config: null,
              createdAt: '',
              updatedAt: '',
              trackerType: 'github' as const,
              tokenSecret: 'github-token-my-project',
            }
          : null;
      },
    } as unknown as ManagedProjectStore;
    const resolveToken = async (tokenSecret: string) =>
      tokenSecret === 'github-token-my-project' ? 'fake-token' : '';

    const scm = await buildStartScmPort({ store, resolveToken }, 'my-project', 'octocat/demo');

    expect(scm).toBeInstanceOf(GithubScmPort);
  });

  it('throws when the repo is not registered', async () => {
    const store = {
      async get() {
        return null;
      },
    } as unknown as ManagedProjectStore;

    await expect(
      buildStartScmPort({ store, resolveToken: async () => 'unused' }, 'my-project', 'octocat/other'),
    ).rejects.toThrow(/no project registered/);
  });

  it('throws when the repo is registered under a different project', async () => {
    const store = {
      async get(repo: string) {
        return repo === 'octocat/demo'
          ? {
              id: '1',
              project: 'my-project',
              repo,
              credentialSet: true,
              config: null,
              createdAt: '',
              updatedAt: '',
              trackerType: 'github' as const,
              tokenSecret: 'github-token-my-project',
            }
          : null;
      },
    } as unknown as ManagedProjectStore;

    await expect(
      buildStartScmPort(
        { store, resolveToken: async () => 'fake-token' },
        'wrong-project',
        'octocat/demo',
      ),
    ).rejects.toThrow(/registered under project "my-project"/);
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
    await buildControlRequest('PUT', '/api/tiers', { tiers: [] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://control.test:3001/api/tiers');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['x-control-crud-token']).toBe('tok');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ tiers: [] }));
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

  it('rejects an unknown project subcommand', async () => {
    await expect(cmdProject(['bogus'])).rejects.toThrow(/list\|show/);
  });
});
