import { describe, expect, it } from 'vitest';
import { MemoryWorkspaceManager, WorkspaceManager } from '@agentops/activities';
import { MemoryScmPort, MemoryTrackerPort } from '@agentops/ports';
import { buildActivityDependencies } from './main';

describe('buildActivityDependencies', () => {
  it('uses in-memory ports and workspace manager when the registry is empty', () => {
    const deps = buildActivityDependencies([]);

    expect(deps.scm).toBeInstanceOf(MemoryScmPort);
    expect(deps.tracker).toBeInstanceOf(MemoryTrackerPort);
    expect(deps.workspaces).toBeInstanceOf(MemoryWorkspaceManager);
  });

  it('uses project-scoped ports and a real WorkspaceManager when the registry is non-empty', () => {
    const deps = buildActivityDependencies([
      { product: 'demo', repo: 'octocat/demo', trackerType: 'github', tokenEnvVar: 'GITHUB_TOKEN__DEMO', token: 'fake-token' },
    ]);

    expect(deps.scm).not.toBeInstanceOf(MemoryScmPort);
    expect(deps.tracker).not.toBeInstanceOf(MemoryTrackerPort);
    expect(deps.workspaces).toBeInstanceOf(WorkspaceManager);
  });
});
