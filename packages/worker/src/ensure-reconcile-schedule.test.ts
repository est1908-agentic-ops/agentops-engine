import { describe, expect, it, vi } from 'vitest';
import { ensureReconcileSchedule } from './ensure-reconcile-schedule';

describe('ensureReconcileSchedule', () => {
  it('creates the reconcile:all schedule if absent', async () => {
    const create = vi.fn().mockResolvedValue({});
    await ensureReconcileSchedule({ create, getHandle: () => ({}) } as never, 'agentops-engine');
    const opts = create.mock.calls[0][0] as {
      scheduleId: string;
      action: { workflowType: string; taskQueue: string };
    };
    expect(opts.scheduleId).toBe('reconcile:all');
    expect(opts.action.workflowType).toBe('reconcileAllProjects');
    expect(opts.action.taskQueue).toBe('agentops-engine');
  });

  it('is idempotent when the schedule already exists', async () => {
    const create = vi.fn().mockRejectedValue(new Error('schedule already exists'));
    await expect(ensureReconcileSchedule({ create, getHandle: () => ({}) } as never, 'agentops-engine')).resolves.toBeUndefined();
  });
});