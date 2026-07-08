import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryWorkspaceManager, WorkspaceManager } from '@agentops/activities';
import { MemoryScmPort, MemoryTrackerPort } from '@agentops/ports';
import { assertLiveBackendConfig, buildActivityDependencies, resolveWorkspacesDir } from './main';

const validLiveEnv: NodeJS.ProcessEnv = {
  AGENT_RUNNER_IMAGE: 'gitactions.est1908.top/agentic-ops/agent-runner:abc123',
  LITELLM_API_KEY: 'sk-real-key',
  CLAUDE_AUTH_SECRET_NAME: 'claude-credentials',
  PI_AUTH_SECRET_NAME: 'pi-credentials',
};

describe('assertLiveBackendConfig', () => {
  it('passes silently when every in-cluster backend setting is real', () => {
    expect(() => assertLiveBackendConfig(validLiveEnv)).not.toThrow();
  });

  it('throws when AGENT_RUNNER_IMAGE is unset', () => {
    const { AGENT_RUNNER_IMAGE: _drop, ...rest } = validLiveEnv;
    expect(() => assertLiveBackendConfig(rest)).toThrow(/AGENT_RUNNER_IMAGE/);
  });

  it('throws when AGENT_RUNNER_IMAGE is still the placeholder', () => {
    expect(() =>
      assertLiveBackendConfig({ ...validLiveEnv, AGENT_RUNNER_IMAGE: 'ghcr.io/CHANGEME/agentops-engine/agent-runner:CHANGEME' }),
    ).toThrow(/AGENT_RUNNER_IMAGE/);
  });

  it('throws when LITELLM_API_KEY is unset', () => {
    const { LITELLM_API_KEY: _drop, ...rest } = validLiveEnv;
    expect(() => assertLiveBackendConfig(rest)).toThrow(/LITELLM_API_KEY/);
  });

  it('throws when CLAUDE_AUTH_SECRET_NAME is unset', () => {
    const { CLAUDE_AUTH_SECRET_NAME: _drop, ...rest } = validLiveEnv;
    expect(() => assertLiveBackendConfig(rest)).toThrow(/CLAUDE_AUTH_SECRET_NAME/);
  });

  it('throws when PI_AUTH_SECRET_NAME is unset', () => {
    const { PI_AUTH_SECRET_NAME: _drop, ...rest } = validLiveEnv;
    expect(() => assertLiveBackendConfig(rest)).toThrow(/PI_AUTH_SECRET_NAME/);
  });

  it('lists every missing setting at once, not just the first', () => {
    expect(() => assertLiveBackendConfig({})).toThrow(
      /AGENT_RUNNER_IMAGE.*LITELLM_API_KEY.*CLAUDE_AUTH_SECRET_NAME.*PI_AUTH_SECRET_NAME/s,
    );
  });
});

const registry = [
  { project: 'demo', repo: 'octocat/demo', trackerType: 'github' as const, tokenEnvVar: 'GITHUB_TOKEN__DEMO', token: 'fake-token' },
];

describe('buildActivityDependencies', () => {
  it('uses in-memory ports and workspace manager when the registry is empty', () => {
    const deps = buildActivityDependencies([]);

    expect(deps.scm).toBeInstanceOf(MemoryScmPort);
    expect(deps.tracker).toBeInstanceOf(MemoryTrackerPort);
    expect(deps.workspaces).toBeInstanceOf(MemoryWorkspaceManager);
  });

  it('uses project-scoped ports and a real WorkspaceManager when the registry is non-empty', () => {
    const deps = buildActivityDependencies(registry);

    expect(deps.scm).not.toBeInstanceOf(MemoryScmPort);
    expect(deps.tracker).not.toBeInstanceOf(MemoryTrackerPort);
    expect(deps.workspaces).toBeInstanceOf(WorkspaceManager);
  });

  describe('workspacesDir wiring', () => {
    let root: string;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'agentops-main-test-'));
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('roots the WorkspaceManager at the provided workspacesDir, so it lines up with the K8s Job mount', async () => {
      const workspacesDir = join(root, 'workspace-tasks');
      const deps = buildActivityDependencies(registry, workspacesDir);

      const { workspaceRef } = await deps.workspaces.prepareScratch('task-1');

      expect(workspaceRef.startsWith(workspacesDir)).toBe(true);
    });

    it('falls back to the WorkspaceManager default when no workspacesDir is given', async () => {
      const deps = buildActivityDependencies(registry);
      const defaultScratchDir = join(homedir(), '.agentops', 'workspaces', 'scratch', 'task-1');

      try {
        const { workspaceRef } = await deps.workspaces.prepareScratch('task-1');
        expect(workspaceRef).toBe(defaultScratchDir);
      } finally {
        rmSync(defaultScratchDir, { recursive: true, force: true });
      }
    });
  });
});

describe('resolveWorkspacesDir', () => {
  it('resolves to the shared PVC mount path in-cluster, so it lines up with K8sJobRunner', () => {
    expect(resolveWorkspacesDir(true)).toBe(process.env.WORKSPACE_MOUNT_PATH ?? '/workspace/tasks');
  });

  it('resolves to undefined outside the cluster, so WorkspaceManager keeps its home-dir default', () => {
    expect(resolveWorkspacesDir(false)).toBeUndefined();
  });
});
