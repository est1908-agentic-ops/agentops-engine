import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryScmPort } from '@agentops/ports';
import { createGatewayServer, type GatewayDeps } from './create-gateway-server';

const SECRET = 'shared-secret';
const TRIGGER_LABEL = 'agentops';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

function labeledPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'labeled',
    label: { name: TRIGGER_LABEL },
    issue: { number: 42, title: 'Add a widget' },
    repository: { full_name: 'octocat/hello-world' },
    ...overrides,
  };
}

async function post(port: number, path: string, body: string, headers: Record<string, string>) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body, headers });
  return { status: res.status, body: await res.text() };
}

describe('createGatewayServer', () => {
  let server: ReturnType<typeof createGatewayServer>;
  let port: number;
  let start: ReturnType<typeof vi.fn>;
  let registeredScm: MemoryScmPort;

  beforeEach(async () => {
    start = vi.fn().mockResolvedValue(undefined);
    registeredScm = new MemoryScmPort();
    const deps: GatewayDeps = {
      client: { workflow: { start } } as never,
      taskQueue: 'agentops-devcycle',
      webhookSecret: SECRET,
      triggerLabel: TRIGGER_LABEL,
      registry: [
        { project: 'my-project', repo: 'octocat/hello-world', trackerType: 'github', tokenEnvVar: 'X', token: 't' },
      ],
      buildScm: () => registeredScm,
    };
    server = createGatewayServer(deps);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(() => {
    server.close();
  });

  it('GET /healthz responds 200 without touching any dependency', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(start).not.toHaveBeenCalled();
  });

  it('404s an unknown route', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });

  it('rejects a webhook with an invalid signature', async () => {
    const body = JSON.stringify(labeledPayload());
    const res = await post(port, '/webhooks/github', body, {
      'content-type': 'application/json',
      'x-github-event': 'issues',
      'x-hub-signature-256': 'sha256=deadbeef',
    });
    expect(res.status).toBe(401);
    expect(start).not.toHaveBeenCalled();
  });

  it('starts devCycle for a correctly signed labeled event on a registered repo', async () => {
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

  it('finds a project config stored at .agentops/agentops.json, not just repo-root agentops.json', async () => {
    registeredScm.seedFile('octocat/hello-world', '.agentops/agentops.json', JSON.stringify({ fastVerifyCommands: ['pnpm test'] }));
    const body = JSON.stringify(labeledPayload());
    const res = await post(port, '/webhooks/github', body, {
      'content-type': 'application/json',
      'x-github-event': 'issues',
      'x-hub-signature-256': sign(body),
    });
    expect(res.status).toBe(202);
    const [, options] = start.mock.calls[0];
    expect(options.args[0].config.fastVerifyCommands).toEqual(['pnpm test']);
  });

  it('ignores (204) a labeled event for a label other than the trigger label', async () => {
    const body = JSON.stringify(labeledPayload({ label: { name: 'bug' } }));
    const res = await post(port, '/webhooks/github', body, {
      'content-type': 'application/json',
      'x-github-event': 'issues',
      'x-hub-signature-256': sign(body),
    });
    expect(res.status).toBe(204);
    expect(start).not.toHaveBeenCalled();
  });

  it('acknowledges (202) but does not start a task for a repo with no registered project', async () => {
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
