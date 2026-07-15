import { describe, it, expect, vi } from 'vitest';

const { executeChild, listManagedProjects, pruneOrphanAgentSchedules, pruneOrphanWorkspaces } =
  vi.hoisted(() => ({
    executeChild: vi.fn().mockResolvedValue({}),
    listManagedProjects: vi.fn().mockResolvedValue([
      { project: 'a', repo: 'o/a' },
      { project: 'b', repo: 'o/b' },
    ]),
    pruneOrphanAgentSchedules: vi.fn().mockResolvedValue({ deleted: [] }),
    pruneOrphanWorkspaces: vi.fn().mockResolvedValue({ removed: [] }),
  }));

vi.mock('@temporalio/workflow', () => ({
  proxyActivities: () => ({
    listManagedProjects,
    pruneOrphanAgentSchedules,
    pruneOrphanWorkspaces,
  }),
  executeChild,
}));

import { reconcileAllProjects } from './reconcile-all-projects';

describe('reconcileAllProjects', () => {
  it('reconciles each managed project via child configSync', async () => {
    await reconcileAllProjects();
    expect(listManagedProjects).toHaveBeenCalled();
    expect(executeChild).toHaveBeenCalledTimes(2);
    expect(executeChild).toHaveBeenCalledWith(
      'configSync',
      expect.objectContaining({ args: [{ project: 'a', repo: 'o/a' }] }),
    );
  });

  it('sweeps orphaned agent schedules (by project) and orphaned workspaces (by repo) for removed projects', async () => {
    pruneOrphanAgentSchedules.mockResolvedValueOnce({ deleted: ['agent:gone:x'] });
    pruneOrphanWorkspaces.mockResolvedValueOnce({ removed: ['cache/gone-repo', 'tasks/gone-1'] });
    const result = await reconcileAllProjects();
    expect(pruneOrphanAgentSchedules).toHaveBeenCalledWith(['a', 'b']); // schedules keyed by project
    expect(pruneOrphanWorkspaces).toHaveBeenCalledWith(['o/a', 'o/b']); // clones keyed by repo
    expect(result).toEqual({ reconciled: 2, orphansDeleted: 1, orphanWorkspacesRemoved: 2 });
  });
});
