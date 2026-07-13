import { describe, expect, it, vi } from 'vitest';
import { ensureReconcileSchedule } from './ensure-reconcile-schedule';

describe('ensureReconcileSchedule', () => {
  it('creates the reconcile:all schedule if absent', async () => {
    const create = vi.fn().mockResolvedValue({});
    await ensureReconcileSchedule({ create, getHandle: () => ({}) } as never, 'agentops-engine');
    const opts = create.mock.calls[0][0] as {
      scheduleId: string;
      spec: { cronExpressions?: string[]; timezone?: string; cron?: unknown };
      action: { workflowType: string; taskQueue: string };
    };
    expect(opts.scheduleId).toBe('reconcile:all');
    expect(opts.action.workflowType).toBe('reconcileAllProjects');
    expect(opts.action.taskQueue).toBe('agentops-engine');
    // The Temporal SDK ScheduleSpec expresses cron as `cronExpressions: string[]`
    // (+ top-level `timezone`); a `spec.cron.cronString` shape is silently ignored
    // -> no recurrence -> the schedule never fires. Assert the real SDK shape.
    expect(opts.spec.cronExpressions).toEqual(['*/15 * * * *']);
    expect(opts.spec.timezone).toBe('UTC');
    expect(opts.spec.cron).toBeUndefined();
  });

  it('is idempotent when the schedule already exists', async () => {
    const create = vi.fn().mockRejectedValue(new Error('schedule already exists'));
    await expect(ensureReconcileSchedule({ create, getHandle: () => ({}) } as never, 'agentops-engine')).resolves.toBeUndefined();
  });
});