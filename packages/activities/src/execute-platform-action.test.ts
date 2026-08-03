import { describe, expect, it, vi } from 'vitest';
import { createActivities, type ActivityDependencies } from './create-activities';

// Minimal deps: only workflowClient matters for this activity. The other fields
// are never touched by executePlatformAction, so cast a partial through unknown.
function makeActivities(workflowClient: ActivityDependencies['workflowClient']) {
  return createActivities({ workflowClient } as unknown as ActivityDependencies);
}

describe('executePlatformAction', () => {
  it('terminates a workflow and reports ok', async () => {
    const terminate = vi.fn().mockResolvedValue(undefined);
    const activities = makeActivities({ getHandle: () => ({ terminate }) });
    const res = await activities.executePlatformAction({
      type: 'terminate',
      workflowId: 'wf-1',
      reason: 'stuck',
    });
    expect(terminate).toHaveBeenCalledWith('stuck');
    expect(res.ok).toBe(true);
    expect(res.detail).toContain('wf-1');
  });

  it('signals a workflow by name and reports ok', async () => {
    const signal = vi.fn().mockResolvedValue(undefined);
    const activities = makeActivities({ getHandle: () => ({ signal }) });
    const res = await activities.executePlatformAction({
      type: 'signal',
      workflowId: 'wf-2',
      signalName: 'resume',
      reason: 'unblock',
    });
    expect(signal).toHaveBeenCalledWith('resume');
    expect(res.ok).toBe(true);
  });

  it('fails cleanly when a signal action omits signalName', async () => {
    const signal = vi.fn();
    const activities = makeActivities({ getHandle: () => ({ signal }) });
    const res = await activities.executePlatformAction({
      type: 'signal',
      workflowId: 'wf-2',
      reason: 'x',
    });
    expect(res.ok).toBe(false);
    expect(signal).not.toHaveBeenCalled();
  });

  it('fails cleanly when no workflow client is configured', async () => {
    const activities = makeActivities(undefined);
    const res = await activities.executePlatformAction({
      type: 'terminate',
      workflowId: 'wf-1',
      reason: 'x',
    });
    expect(res.ok).toBe(false);
  });

  it('reports the error detail when terminate throws', async () => {
    const terminate = vi.fn().mockRejectedValue(new Error('not found'));
    const activities = makeActivities({ getHandle: () => ({ terminate }) });
    const res = await activities.executePlatformAction({
      type: 'terminate',
      workflowId: 'wf-x',
      reason: 'x',
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toBe('not found');
  });
});
