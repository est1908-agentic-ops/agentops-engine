import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  encryptForManagedProject,
  generateManagedProjectKeyPair,
  type ManagedProjectRegistryDeps,
} from '@agentops/activities';
import type { ResolvedProjectEntry } from '@agentops/contracts';
import type { ScmPort } from '@agentops/ports';
import {
  createProjectWorkerParamsProvider,
  type ProjectWorkerParamsProvider,
} from './argocd-project-workers';
import { createGatewayServer, type GatewayDeps } from './create-gateway-server';

// A fake managed-project store exposing just what loadManagedProjectRegistry
// touches: list/get/getEncryptedToken. Tokens are real-encrypted so the
// provider exercises the actual decrypt path.
function fakeRegistryDeps(
  privateKey: string,
  rows: { project: string; repo: string; encryptedToken: string }[],
): ManagedProjectRegistryDeps {
  const toMP = (r: { project: string; repo: string }) => ({
    id: '1',
    project: r.project,
    repo: r.repo,
    credentialSet: true,
    config: null,
    createdAt: '',
    updatedAt: '',
    trackerType: 'github' as const,
  });
  return {
    store: {
      async list() {
        return rows.map(toMP);
      },
      async get(repo: string) {
        const r = rows.find((x) => x.repo === repo);
        return r ? toMP(r) : null;
      },
      async getEncryptedToken(repo: string) {
        return rows.find((x) => x.repo === repo)?.encryptedToken ?? null;
      },
    } as never,
    privateKey,
  };
}

// An ScmPort whose readFile returns whatever `read` yields for the entry's repo.
// `read` can throw to simulate a transient failure.
function scmFactory(
  read: (repo: string) => string | null,
): (entry: ResolvedProjectEntry) => ScmPort {
  return (entry) => ({ readFile: async () => read(entry.repo) }) as unknown as ScmPort;
}

const workerManifest = (image: string) =>
  JSON.stringify({
    agents: [{ name: 'mon', workflow: 'rollbarMonitor', schedule: 'continuous' }],
    worker: { image, externalSecrets: ['rollbar-token'] },
  });

describe('createProjectWorkerParamsProvider', () => {
  it('returns one param per project with a worker block, defaulting queue + replicas', async () => {
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const deps = fakeRegistryDeps(privateKey, [
      {
        project: 'acme',
        repo: 'acme/web',
        encryptedToken: encryptForManagedProject(publicKey, 't'),
      },
    ]);
    const provider = createProjectWorkerParamsProvider({
      managedProjectDeps: deps,
      buildScm: scmFactory(() => workerManifest('reg/acme/agentops-worker:abc')),
    });
    expect(await provider.getParams()).toEqual([
      {
        project: 'acme',
        image: 'reg/acme/agentops-worker:abc',
        taskQueue: 'proj-acme',
        replicas: '1',
        externalSecretRefs: '["rollbar-token"]',
      },
    ]);
  });

  it('slugifies an operator-chosen project name so params are k8s/Temporal-safe', async () => {
    // Pre-fix this emitted { project: 'Artem private agents', taskQueue: 'proj-Artem private agents' }
    // -- the Helm chart uses `project` verbatim as a k8s Deployment/ServiceAccount
    // name, so ArgoCD could never sync a worker for it and its schedules fired
    // onto a queue nothing polled.
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const deps = fakeRegistryDeps(privateKey, [
      {
        project: 'Artem private agents',
        repo: 'artem/agents',
        encryptedToken: encryptForManagedProject(publicKey, 't'),
      },
    ]);
    const provider = createProjectWorkerParamsProvider({
      managedProjectDeps: deps,
      buildScm: scmFactory(() => workerManifest('reg/agents-worker:abc')),
    });
    expect(await provider.getParams()).toEqual([
      {
        project: 'artem-private-agents',
        image: 'reg/agents-worker:abc',
        taskQueue: 'proj-artem-private-agents',
        replicas: '1',
        externalSecretRefs: '["rollbar-token"]',
      },
    ]);
  });

  it('emits externalSecretRefs "[]" when the worker block declares no externalSecrets', async () => {
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const deps = fakeRegistryDeps(privateKey, [
      {
        project: 'acme',
        repo: 'acme/web',
        encryptedToken: encryptForManagedProject(publicKey, 't'),
      },
    ]);
    const provider = createProjectWorkerParamsProvider({
      managedProjectDeps: deps,
      buildScm: scmFactory(() => JSON.stringify({ agents: [], worker: { image: 'reg/w:abc' } })),
    });
    expect(await provider.getParams()).toEqual([
      {
        project: 'acme',
        image: 'reg/w:abc',
        taskQueue: 'proj-acme',
        replicas: '1',
        externalSecretRefs: '[]',
      },
    ]);
  });

  it('excludes a project whose manifest has no worker block', async () => {
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const deps = fakeRegistryDeps(privateKey, [
      {
        project: 'cfg-only',
        repo: 'acme/web',
        encryptedToken: encryptForManagedProject(publicKey, 't'),
      },
    ]);
    const provider = createProjectWorkerParamsProvider({
      managedProjectDeps: deps,
      buildScm: scmFactory(() =>
        JSON.stringify({
          agents: [{ name: 'nb', workflow: 'whiteboxBugHunt', schedule: '0 2 * * *' }],
        }),
      ),
    });
    expect(await provider.getParams()).toEqual([]);
  });

  it('returns [] when no managed-project DB is configured', async () => {
    const provider = createProjectWorkerParamsProvider({
      managedProjectDeps: undefined,
      buildScm: scmFactory(() => null),
    });
    expect(await provider.getParams()).toEqual([]);
  });

  it('serves last-good on a transient read failure (never prunes a live worker)', async () => {
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const deps = fakeRegistryDeps(privateKey, [
      {
        project: 'acme',
        repo: 'acme/web',
        encryptedToken: encryptForManagedProject(publicKey, 't'),
      },
    ]);
    let fail = false;
    const provider = createProjectWorkerParamsProvider({
      managedProjectDeps: deps,
      buildScm: scmFactory(() => {
        if (fail) throw new Error('GitHub 503');
        return workerManifest('reg/acme/agentops-worker:abc');
      }),
    });
    const first = await provider.getParams();
    expect(first).toHaveLength(1);
    fail = true;
    // read throws -> the prior value is served, not dropped
    expect(await provider.getParams()).toEqual(first);
  });

  it('drops a worker when its manifest removes the block (a real, successful read)', async () => {
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const deps = fakeRegistryDeps(privateKey, [
      {
        project: 'acme',
        repo: 'acme/web',
        encryptedToken: encryptForManagedProject(publicKey, 't'),
      },
    ]);
    let removed = false;
    const provider = createProjectWorkerParamsProvider({
      managedProjectDeps: deps,
      buildScm: scmFactory(() =>
        removed ? JSON.stringify({ agents: [] }) : workerManifest('reg/acme/agentops-worker:abc'),
      ),
    });
    expect(await provider.getParams()).toHaveLength(1);
    removed = true;
    expect(await provider.getParams()).toEqual([]);
  });
});

describe('createGatewayServer ArgoCD getparams route', () => {
  let server: ReturnType<typeof createGatewayServer>;
  let port: number;

  const param = { project: 'acme', image: 'reg/w:abc', taskQueue: 'proj-acme', replicas: '1' };
  const stubProvider: ProjectWorkerParamsProvider = {
    getParams: vi.fn().mockResolvedValue([param]),
  };

  function boot(over: Partial<GatewayDeps>): Promise<void> {
    server = createGatewayServer({
      client: {} as never,
      taskQueue: 'agentops-devcycle',
      webhookSecret: 's',
      triggerLabel: 'agentops',
      buildScm: () => ({}) as never,
      ...over,
    });
    return new Promise<void>((resolve) =>
      server.listen(0, () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      }),
    );
  }

  afterEach(() => server?.close());

  async function post(headers: Record<string, string> = {}) {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/getparams.execute`, {
      method: 'POST',
      body: JSON.stringify({ applicationSetName: 'project-workers', input: { parameters: {} } }),
      headers: { 'content-type': 'application/json', ...headers },
    });
    return { status: res.status, body: await res.text() };
  }

  it('404s when the generator is not configured (no token/provider)', async () => {
    await boot({});
    expect((await post()).status).toBe(404);
  });

  it('401s on a missing or wrong bearer token', async () => {
    await boot({ argocdParams: stubProvider, argocdPluginToken: 'secret' });
    expect((await post()).status).toBe(401);
    expect((await post({ authorization: 'Bearer nope' })).status).toBe(401);
  });

  it('returns the ArgoCD plugin-generator shape with a valid token', async () => {
    await boot({ argocdParams: stubProvider, argocdPluginToken: 'secret' });
    const res = await post({ authorization: 'Bearer secret' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ output: { parameters: [param] } });
  });
});
