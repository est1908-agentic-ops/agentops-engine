import { describe, it, expect, vi } from 'vitest';

const { executeChild, listManagedProjects } = vi.hoisted(() => ({
  executeChild: vi.fn().mockResolvedValue({}),
  listManagedProjects: vi.fn().mockResolvedValue([
    { project: 'a', repo: 'o/a' },
    { project: 'b', repo: 'o/b' },
  ]),
}));

vi.mock('@temporalio/workflow', () => ({
  proxyActivities: () => ({ listManagedProjects }),
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
});