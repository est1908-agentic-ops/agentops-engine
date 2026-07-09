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

const LINEAR_SECRET = 'linear-shared-secret';
const LINEAR_TRIGGER_LABEL_ID = 'label-uuid-1';

function signLinear(body: string): string {
  return createHmac('sha256', LINEAR_SECRET).update(body).digest('hex');
}

function linearIssuePayload(overrides: Record<string, unknown> = {}) {
  return {
    type: 'Issue',
    action: 'update',
    data: { identifier: 'ENG-123', title: 'Add a widget', labelIds: [LINEAR_TRIGGER_LABEL_ID] },
    updatedFrom: { labelIds: [] },
    webhookTimestamp: Date.now(),
    ...overrides,
  };
}

describe('createGatewayServer Linear route', () => {
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
        {
          project: 'my-linear-project',
          repo: 'octocat/hello-world',
          trackerType: 'linear',
          tokenEnvVar: 'X',
          linearTeamKey: 'ENG',
          linearTokenEnvVar: 'Y',
          linearTriggerLabelId: LINEAR_TRIGGER_LABEL_ID,
          token: 't',
          linearToken: 'lt',
        },
      ],
      buildScm: () => registeredScm,
      linearWebhookSecret: LINEAR_SECRET,
    };
    server = createGatewayServer(deps);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(() => {
    server.close();
  });

  it('404s when linearWebhookSecret is not configured', async () => {
    start = vi.fn().mockResolvedValue(undefined);
    const deps: GatewayDeps = {
      client: { workflow: { start } } as never,
      taskQueue: 'agentops-devcycle',
      webhookSecret: SECRET,
      triggerLabel: TRIGGER_LABEL,
      registry: [],
      buildScm: () => new MemoryScmPort(),
    };
    const noLinearServer = createGatewayServer(deps);
    await new Promise<void>((resolve) => noLinearServer.listen(0, resolve));
    const noLinearPort = (noLinearServer.address() as AddressInfo).port;

    const body = JSON.stringify(linearIssuePayload());
    const res = await post(noLinearPort, '/webhooks/linear', body, {
      'content-type': 'application/json',
      'linear-signature': signLinear(body),
    });
    expect(res.status).toBe(404);
    noLinearServer.close();
  });

  it('rejects a webhook with an invalid signature', async () => {
    const body = JSON.stringify(linearIssuePayload());
    const res = await post(port, '/webhooks/linear', body, { 'content-type': 'application/json', 'linear-signature': 'deadbeef' });
    expect(res.status).toBe(401);
    expect(start).not.toHaveBeenCalled();
  });

  it('starts devCycle for a correctly signed labeled event on a registered Linear team', async () => {
    const body = JSON.stringify(linearIssuePayload());
    const res = await post(port, '/webhooks/linear', body, {
      'content-type': 'application/json',
      'linear-signature': signLinear(body),
    });
    expect(res.status).toBe(202);
    expect(start).toHaveBeenCalledTimes(1);
    const [, options] = start.mock.calls[0];
    expect(options.args[0]).toMatchObject({
      project: 'my-linear-project',
      repo: 'octocat/hello-world',
      issueRef: 'linear:ENG-123',
      goal: 'Add a widget',
    });
  });

  it('ignores (204) an issue event whose labelIds do not include the trigger label', async () => {
    const body = JSON.stringify(linearIssuePayload({ data: { identifier: 'ENG-123', title: 't', labelIds: ['other'] } }));
    const res = await post(port, '/webhooks/linear', body, {
      'content-type': 'application/json',
      'linear-signature': signLinear(body),
    });
    expect(res.status).toBe(204);
    expect(start).not.toHaveBeenCalled();
  });

  it('acknowledges (202) but does not start a task for a team with no registered project', async () => {
    const body = JSON.stringify(linearIssuePayload({ data: { identifier: 'OTHER-1', title: 't', labelIds: [LINEAR_TRIGGER_LABEL_ID] } }));
    const res = await post(port, '/webhooks/linear', body, {
      'content-type': 'application/json',
      'linear-signature': signLinear(body),
    });
    expect(res.status).toBe(202);
    expect(start).not.toHaveBeenCalled();
  });

  it('ignores (204) a stale webhook past the freshness window', async () => {
    const body = JSON.stringify(linearIssuePayload({ webhookTimestamp: Date.now() - 10 * 60_000 }));
    const res = await post(port, '/webhooks/linear', body, {
      'content-type': 'application/json',
      'linear-signature': signLinear(body),
    });
    expect(res.status).toBe(204);
    expect(start).not.toHaveBeenCalled();
  });

  it('does not crash the process when a handler throws synchronously (500, not an unhandled rejection)', async () => {
    // registry is intentionally the wrong shape here, so findLinearProjectEntry's
    // .find call throws outside handleLinearWebhook's own try/catch -- this
    // exercises createGatewayServer's outer defensive catch, not any one
    // handler's inner error handling.
    const brokenDeps: GatewayDeps = {
      client: { workflow: { start: vi.fn() } } as never,
      taskQueue: 'agentops-devcycle',
      webhookSecret: SECRET,
      triggerLabel: TRIGGER_LABEL,
      registry: null as never,
      buildScm: () => new MemoryScmPort(),
      linearWebhookSecret: LINEAR_SECRET,
    };
    const brokenServer = createGatewayServer(brokenDeps);
    await new Promise<void>((resolve) => brokenServer.listen(0, resolve));
    const brokenPort = (brokenServer.address() as AddressInfo).port;

    const body = JSON.stringify(linearIssuePayload());
    const res = await post(brokenPort, '/webhooks/linear', body, {
      'content-type': 'application/json',
      'linear-signature': signLinear(body),
    });

    expect(res.status).toBe(500);
    // The server is still alive and answering other requests -- proves the
    // process didn't crash.
    const healthRes = await fetch(`http://127.0.0.1:${brokenPort}/healthz`);
    expect(healthRes.status).toBe(200);
    brokenServer.close();
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
