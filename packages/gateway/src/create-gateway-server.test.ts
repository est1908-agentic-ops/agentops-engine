import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryScmPort } from '@agentops/ports';
import { createGatewayServer, type GatewayDeps } from './create-gateway-server';

const SECRET = 'shared-secret';
const LINEAR_SECRET = 'linear-secret';
const TRIGGER_LABEL = 'agentops';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

function signLinear(body: string): string {
  return createHmac('sha256', LINEAR_SECRET).update(body).digest('hex');
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
  token: string;
  config?: unknown;
  trackerType?: 'github' | 'linear';
  linearTeamKey?: string;
  linearTriggerLabelId?: string;
  linearToken?: string;
}

// The same fake-store shape resolve-managed-projects.test.ts uses -- this
// file exercises resolveManagedProjectEntry through the real gateway HTTP
// handlers rather than calling it directly. resolveToken is the identity
// function here (tokenSecret IS the token for this fake) -- the real
// per-project-token resolution (KubeTokenResolver reading a K8s Secret by
// name) has its own dedicated tests.
function fakeManagedProjectDeps(rows: FakeManagedRow[]): GatewayDeps['managedProjectDeps'] {
  function toManagedProject(row: FakeManagedRow) {
    if (row.trackerType === 'linear') {
      return {
        id: '1',
        project: row.project,
        repo: row.repo,
        credentialSet: true,
        config: row.config ?? null,
        createdAt: '',
        updatedAt: '',
        trackerType: 'linear' as const,
        tokenSecret: row.token,
        linearTeamKey: row.linearTeamKey!,
        ...(row.linearTriggerLabelId
          ? { linearTriggerLabelId: row.linearTriggerLabelId }
          : {}),
        linearCredentialSet: true,
        linearTokenSecret: row.linearToken ?? 'linear-token',
      };
    }
    return {
      id: '1',
      project: row.project,
      repo: row.repo,
      credentialSet: true,
      config: row.config ?? null,
      createdAt: '',
      updatedAt: '',
      trackerType: 'github' as const,
      tokenSecret: row.token,
    };
  }
  return {
    store: {
      async get(repo: string) {
        const row = rows.find((r) => r.repo === repo);
        return row ? toManagedProject(row) : null;
      },
      async getByLinearTeamKey(teamKey: string) {
        const row = rows.find(
          (candidate) =>
            candidate.trackerType === 'linear' && candidate.linearTeamKey === teamKey,
        );
        return row ? toManagedProject(row) : null;
      },
    } as never,
    resolveToken: async (tokenSecret: string) => tokenSecret,
  };
}

describe('createGatewayServer Linear route', () => {
  it('acknowledges but does not start a task when the project has no trigger label', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const server = createGatewayServer({
      client: { workflow: { start } } as never,
      taskQueue: 'agentops-devcycle',
      webhookSecret: SECRET,
      linearWebhookSecret: LINEAR_SECRET,
      triggerLabel: TRIGGER_LABEL,
      buildScm: () => new MemoryScmPort(),
      managedProjectDeps: fakeManagedProjectDeps([
        {
          project: 'linear-project',
          repo: 'octocat/hello-world',
          token: 'github-token',
          trackerType: 'linear',
          linearTeamKey: 'ENG',
          linearToken: 'linear-token',
        },
      ]),
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const body = JSON.stringify({
        action: 'update',
        type: 'Issue',
        data: { identifier: 'ENG-123', title: 'Fix the widget', labelIds: ['label-uuid'] },
        updatedFrom: { labelIds: [] },
        webhookTimestamp: Date.now(),
      });
      const res = await post(port, '/webhooks/linear', body, {
        'content-type': 'application/json',
        'linear-signature': signLinear(body),
      });

      expect(res.status).toBe(202);
      expect(start).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});

describe('createGatewayServer GitHub route', () => {
  let server: ReturnType<typeof createGatewayServer>;
  let port: number;
  let start: ReturnType<typeof vi.fn>;
  let registeredScm: MemoryScmPort;

  beforeEach(async () => {
    start = vi.fn().mockResolvedValue(undefined);
    registeredScm = new MemoryScmPort();
    const managedProjectDeps = fakeManagedProjectDeps([
      { project: 'my-project', repo: 'octocat/hello-world', token: 't' },
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
    expect(options.args[0]).toMatchObject({
      project: 'my-project',
      repo: 'octocat/hello-world',
      goal: 'Add a widget',
    });
  });

  it('finds a project config stored at .agentops/agentops.json, not just repo-root agentops.json', async () => {
    registeredScm.seedFile(
      'octocat/hello-world',
      '.agentops/agentops.json',
      JSON.stringify({ fastVerifyCommands: ['pnpm test'] }),
    );
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
    const body = JSON.stringify(
      labeledPayload({ repository: { full_name: 'octocat/unregistered' } }),
    );
    const res = await post(port, '/webhooks/github', body, {
      'content-type': 'application/json',
      'x-github-event': 'issues',
      'x-hub-signature-256': sign(body),
    });
    expect(res.status).toBe(202);
    expect(start).not.toHaveBeenCalled();
  });

  it('acknowledges (202) but does not start a task when no managed-project registry is configured at all', async () => {
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

describe('createGatewayServer config branch (managed config vs file fallback)', () => {
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

  it('uses the managed config directly when the managed project has one (no repo file read)', async () => {
    start = vi.fn().mockResolvedValue(undefined);
    const managedConfig = {
      stages: {},
      routing: {},
      brakes: {
        maxImplementAttempts: 9,
        maxIterations: 9,
        maxTokens: 999_999,
        maxBabysitRounds: 9,
      },
    };
    // A MemoryScmPort that is NOT seeded -- if loadProjectConfig were called
    // it would return defaults (maxTokens 200_000), not 999_999.
    const scm = new MemoryScmPort();
    const managedProjectDeps = fakeManagedProjectDeps([
      { project: 'my-project', repo: 'octocat/hello-world', config: managedConfig, token: 'db-token' },
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
    const scm = new MemoryScmPort();
    scm.seedFile(
      'octocat/hello-world',
      'agentops.json',
      JSON.stringify({ fastVerifyCommands: ['pnpm lint'] }),
    );
    const managedProjectDeps = fakeManagedProjectDeps([
      { project: 'my-project', repo: 'octocat/hello-world', token: 'db-token' },
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

  it('starts prLanding on external automerge enrollment when autoMerge is enabled', async () => {
    start = vi.fn().mockResolvedValue(undefined);
    const managedProjectDeps = fakeManagedProjectDeps([
      {
        project: 'my-project',
        repo: 'octocat/hello-world',
        config: {
          stages: {},
          routing: {},
          brakes: { maxImplementAttempts: 1, maxIterations: 1, maxTokens: 1, maxBabysitRounds: 1 },
          autoMerge: 'label',
        },
        token: 't',
      },
    ]);
    await listen({
      client: { workflow: { start } } as never,
      taskQueue: 'agentops-devcycle',
      webhookSecret: SECRET,
      triggerLabel: TRIGGER_LABEL,
      buildScm: () => new MemoryScmPort(),
      managedProjectDeps,
    });

    const body = JSON.stringify({
      action: 'labeled',
      label: { name: 'automerge' },
      pull_request: { number: 7, head: { ref: 'feature/x' }, labels: [{ name: 'automerge' }] },
      repository: { full_name: 'octocat/hello-world' },
    });
    const res = await post(port, '/webhooks/github', body, {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-hub-signature-256': sign(body),
    });
    expect(res.status).toBe(202);
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0][1].args[0]).toMatchObject({
      agentCreated: false,
      prRef: 'octocat/hello-world#7',
    });
  });

  it('returns 204 for external automerge enrollment when autoMerge is disabled', async () => {
    start = vi.fn().mockResolvedValue(undefined);
    const managedProjectDeps = fakeManagedProjectDeps([
      { project: 'my-project', repo: 'octocat/hello-world', token: 't' },
    ]);
    await listen({
      client: { workflow: { start } } as never,
      taskQueue: 'agentops-devcycle',
      webhookSecret: SECRET,
      triggerLabel: TRIGGER_LABEL,
      buildScm: () => new MemoryScmPort(),
      managedProjectDeps,
    });
    const body = JSON.stringify({
      action: 'labeled',
      label: { name: 'automerge' },
      pull_request: { number: 7, head: { ref: 'feature/x' }, labels: [{ name: 'automerge' }] },
      repository: { full_name: 'octocat/hello-world' },
    });
    const res = await post(port, '/webhooks/github', body, {
      'content-type': 'application/json',
      'x-github-event': 'pull_request',
      'x-hub-signature-256': sign(body),
    });
    expect(res.status).toBe(204);
    expect(start).not.toHaveBeenCalled();
  });
});
