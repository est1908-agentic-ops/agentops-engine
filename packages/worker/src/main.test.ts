import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryWorkspaceManager, WorkspaceManager } from '@agentops/activities';
import { MemoryScmPort, MemoryTrackerPort } from '@agentops/ports';
import { buildActivityDependencies, resolveWorkspacesDir } from './main';

const registry = [
  { product: 'demo', repo: 'octocat/demo', trackerType: 'github' as const, tokenEnvVar: 'GITHUB_TOKEN__DEMO', token: 'fake-token' },
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
