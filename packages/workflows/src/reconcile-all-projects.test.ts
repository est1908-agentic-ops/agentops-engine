import { describe, it, expect, vi } from 'vitest';

const { executeChild, listManagedProjects, pruneOrphanAgentSchedules } = vi.hoisted(() => ({
  executeChild: vi.fn().mockResolvedValue({}),
  listManagedProjects: vi.fn().mockResolvedValue([
    { project: 'a', repo: 'o/a' },
    { project: 'b', repo: 'o/b' },
  ]),
  pruneOrphanAgentSchedules: vi.fn().mockResolvedValue({ deleted: [] }),
}));

vi.mock('@temporalio/workflow', () => ({
  proxyActivities: () => ({ listManagedProjects, pruneOrphanAgentSchedules }),
  executeChild,
}));

import { reconcileAllProjects } from './reconcile-all-projects';

describe('reconcileAllProjects', () => {
  it('reconciles each managed project via child configSync', async () => {
    await reconcileAllProjects();
    expect(listManagedProjects).toHaveBeenCalled();
    expect(executeChild).toHaveBeenCalledTimes(2);
    expect(executeChild).toHaveBeenCalledWith('configSync', expect.objectContaining({ args: [{ project: 'a', repo: 'o/a' }] }));
  });

  it('sweeps orphaned agent schedules for projects no longer managed', async () => {
    pruneOrphanAgentSchedules.mockResolvedValueOnce({ deleted: ['agent:gone:x'] });
    const result = await reconcileAllProjects();
    // sweep is scoped to the still-managed projects
    expect(pruneOrphanAgentSchedules).toHaveBeenCalledWith(['a', 'b']);
    expect(result).toEqual({ reconciled: 2, orphansDeleted: 1 });
  });
});