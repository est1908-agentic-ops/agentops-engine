import { describe, expect, it } from 'vitest';
import { MemoryWorkspaceManager, WorkspaceManager } from '@agentops/activities';
import { MemoryScmPort, MemoryTrackerPort, GithubScmPort, GithubTrackerPort } from '@agentops/ports';
import { buildActivityDependencies } from './main';

describe('buildActivityDependencies', () => {
  it('uses in-memory ports and workspace manager when GITHUB_TOKEN is unset', () => {
    const deps = buildActivityDependencies(undefined);

    expect(deps.scm).toBeInstanceOf(MemoryScmPort);
    expect(deps.tracker).toBeInstanceOf(MemoryTrackerPort);
    expect(deps.workspaces).toBeInstanceOf(MemoryWorkspaceManager);
  });

  it('uses real GitHub ports and a real WorkspaceManager when GITHUB_TOKEN is set', () => {
    const deps = buildActivityDependencies('fake-token');

    expect(deps.scm).toBeInstanceOf(GithubScmPort);
    expect(deps.tracker).toBeInstanceOf(GithubTrackerPort);
    expect(deps.workspaces).toBeInstanceOf(WorkspaceManager);
  });
});
