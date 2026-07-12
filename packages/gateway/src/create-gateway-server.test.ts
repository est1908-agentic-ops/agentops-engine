import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptForManagedProject, generateManagedProjectKeyPair } from '@agentops/activities';
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

interface FakeManagedRow {
  project: string;
  repo: string;
  encryptedToken: string;
  config?: unknown;
  trackerType?: 'github' | 'linear';
  linearTeamKey?: string;
  linearTriggerLabelId?: string;
  encryptedLinearToken?: string;
}

// The same fake-store shape resolve-managed-projects.test.ts uses -- this
// file exercises resolveManagedProjectEntry/resolveManagedProjectEntryByLinearTeamKey
// through the real gateway HTTP handlers rather than calling them directly.
function fakeManagedProjectDeps(privateKey: string, rows: FakeManagedRow[]) {
  function toManagedProject(row: FakeManagedRow) {
    const base = { id: '1', project: row.project, repo: row.repo, credentialSet: true, config: row.config ?? null, createdAt: '', updatedAt: '' };
    if (row.trackerType === 'linear') {
      return {
        ...base,
        trackerType: 'linear' as const,
        linearTeamKey: row.linearTeamKey,
        linearTriggerLabelId: row.linearTriggerLabelId,
        linearCredentialSet: Boolean(row.encryptedLinearToken),
      };
    }
    return { ...base, trackerType: 'github' as const };
  }
  return {
    store: {
      async get(repo: string) {
        const row = rows.find((r) => r.repo === repo);
        return row ? toManagedProject(row) : null;
      },
      async getByLinearTeamKey(teamKey: string) {
        const row = rows.find((r) => r.linearTeamKey === teamKey);
        return row ? toManagedProject(row) : null;
      },
      async getEncryptedToken(repo: string) {
        return rows.find((r) => r.repo === repo)?.encryptedToken ?? null;
      },
      async getEncryptedLinearToken(repo: string) {
        return rows.find((r) => r.repo === repo)?.encryptedLinearToken ?? null;
      },
    } as never,
    privateKey,
  };
}

describe('createGatewayServer GitHub route', () => {
  let server: ReturnType<typeof createGatewayServer>;
  let port: number;
  let start: ReturnType<typeof vi.fn>;
  let registeredScm: MemoryScmPort;

  beforeEach(async () => {
    start = vi.fn().mockResolvedValue(undefined);
    registeredScm = new MemoryScmPort();
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const managedProjectDeps = fakeManagedProjectDeps(privateKey, [
      { project: 'my-project', repo: 'octocat/hello-world', encryptedToken: encryptForManagedProject(publicKey, 't') },
    ]);
    const deps: GatewayDeps = {
      client: { workflow: { start } } as never,
      taskQueue: 'agentops-devcycle',
      webhookSecret: SECRET,
      triggerLabel: TRIGGER_LABEL,
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

  it('starts configSync for a push event on a registered repo', async () => {
    const body = JSON.stringify({ repository: { full_name: 'octocat/hello-world' } });
    const res = await post(port, '/webhooks/github', body, {
      'content-type': 'application/json',
      'x-github-event': 'push',
      'x-hub-signature-256': sign(body),
    });
    expect(res.status).toBe(202);
    expect(start).toHaveBeenCalledTimes(1);
    const [, options] = start.mock.calls[0];
    expect(options.workflowId).toBe('configsync:my-project');
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

  it('acknowledges (202) but does not start a task when no managed-project DB is configured at all', async () => {
    start = vi.fn().mockResolvedValue(undefined);
    const noDbServer = createGatewayServer({
      client: { workflow: { start } } as never,
      taskQueue: 'agentops-devcycle',
      webhookSecret: SECRET,
      triggerLabel: TRIGGER_LABEL,
      buildScm: () => new MemoryScmPort(),
    });
    await new Promise<void>((resolve) => noDbServer.listen(0, resolve));
    const noDbPort = (noDbServer.address() as AddressInfo).port;

    const body = JSON.stringify(labeledPayload());
    const res = await post(noDbPort, '/webhooks/github', body, {
      'content-type': 'application/json',
      'x-github-event': 'issues',
      'x-hub-signature-256': sign(body),
    });
    expect(res.status).toBe(202);
    expect(start).not.toHaveBeenCalled();
    noDbServer.close();
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
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const managedProjectDeps = fakeManagedProjectDeps(privateKey, [
      {
        project: 'my-linear-project',
        repo: 'octocat/hello-world',
        trackerType: 'linear',
        linearTeamKey: 'ENG',
        linearTriggerLabelId: LINEAR_TRIGGER_LABEL_ID,
        encryptedToken: encryptForManagedProject(publicKey, 't'),
        encryptedLinearToken: encryptForManagedProject(publicKey, 'lt'),
      },
    ]);
    const deps: GatewayDeps = {
      client: { workflow: { start } } as never,
      taskQueue: 'agentops-devcycle',
      webhookSecret: SECRET,
      triggerLabel: TRIGGER_LABEL,
      buildScm: () => registeredScm,
      managedProjectDeps,
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
    // managedProjectDeps.store is intentionally broken here, so
    // resolveManagedProjectEntryByLinearTeamKey's DB call throws outside
    // handleLinearWebhook's own try/catch -- this exercises
    // createGatewayServer's outer defensive catch, not any one handler's
    // inner error handling.
    const brokenDeps: GatewayDeps = {
      client: { workflow: { start: vi.fn() } } as never,
      taskQueue: 'agentops-devcycle',
      webhookSecret: SECRET,
      triggerLabel: TRIGGER_LABEL,
      buildScm: () => new MemoryScmPort(),
      managedProjectDeps: { store: { getByLinearTeamKey: () => Promise.reject(new Error('db down')) } as never, privateKey: 'unused' },
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
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const dbConfig = {
      stages: {},
      routing: {},
      brakes: { maxImplementAttempts: 9, maxIterations: 9, maxTokens: 999_999, maxBabysitRounds: 9 },
    };
    // A MemoryScmPort that is NOT seeded -- if loadProjectConfig were called
    // it would return defaults (maxTokens 200_000), not 999_999.
    const scm = new MemoryScmPort();
    const managedProjectDeps = fakeManagedProjectDeps(privateKey, [
      { project: 'my-project', repo: 'octocat/hello-world', config: dbConfig, encryptedToken: encryptForManagedProject(publicKey, 'db-token') },
    ]);
    await listen({
      client: { workflow: { start } } as never,
      taskQueue: 'agentops-devcycle',
      webhookSecret: SECRET,
      triggerLabel: TRIGGER_LABEL,
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
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const scm = new MemoryScmPort();
    scm.seedFile('octocat/hello-world', 'agentops.json', JSON.stringify({ fastVerifyCommands: ['pnpm lint'] }));
    const managedProjectDeps = fakeManagedProjectDeps(privateKey, [
      { project: 'my-project', repo: 'octocat/hello-world', encryptedToken: encryptForManagedProject(publicKey, 'db-token') },
    ]);
    await listen({
      client: { workflow: { start } } as never,
      taskQueue: 'agentops-devcycle',
      webhookSecret: SECRET,
      triggerLabel: TRIGGER_LABEL,
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
