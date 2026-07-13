import { cronScheduleSpec, type ScheduleCreateOpts } from '@agentops/activities';

export interface ScheduleClientLike {
  create(opts: ScheduleCreateOpts): Promise<unknown>;
  getHandle(id: string): unknown;
}

// Periodic safety reconcile (SP3 §3.2). Ensured at boot, idempotently, like
// the search-attribute registration — a fresh env self-bootstraps the ~15-min
// drift/missed-webhook net with no manual step. The spec MUST use
// `cronScheduleSpec` (cronExpressions) — a `{ cron: { cronString } }` shape is
// ignored by the Temporal client and yields a schedule that never fires.
export async function ensureReconcileSchedule(schedule: ScheduleClientLike, engineQueue: string): Promise<void> {
  try {
    await schedule.create({
      scheduleId: 'reconcile:all',
      spec: cronScheduleSpec('*/15 * * * *', 'UTC'),
      action: { type: 'startWorkflow', workflowType: 'reconcileAllProjects', args: [], taskQueue: engineQueue },
    });
  } catch (err) {
    if (!/already exist/i.test(err instanceof Error ? err.message : String(err))) throw err;
  }
}