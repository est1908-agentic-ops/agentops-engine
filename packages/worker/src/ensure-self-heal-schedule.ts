import { cronScheduleSpec } from '@agentops/activities';
import { ScheduleOverlapPolicy } from '@temporalio/client';

export interface SelfHealScheduleClient {
  create(opts: unknown): Promise<unknown>;
  getHandle(id: string): { delete(): Promise<void> };
}

const SELF_HEAL_SCHEDULE_ID = 'self-heal';

// M6 self-heal schedule (design §3). Ensured at boot idempotently like
// reconcile:all, but gated by an enable flag so it is a true on/off switch:
// enabled -> create; disabled -> best-effort delete.
export async function ensureSelfHealSchedule(
  schedule: SelfHealScheduleClient,
  engineQueue: string,
  opts: { enabled: boolean; cron: string },
): Promise<void> {
  if (!opts.enabled) {
    try {
      await schedule.getHandle(SELF_HEAL_SCHEDULE_ID).delete();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/not found|does not exist|no schedule/i.test(msg)) throw err;
    }
    return;
  }
  try {
    await schedule.create({
      scheduleId: SELF_HEAL_SCHEDULE_ID,
      spec: cronScheduleSpec(opts.cron, 'UTC'),
      action: {
        type: 'startWorkflow',
        workflowType: 'selfHeal',
        args: [],
        taskQueue: engineQueue,
        workflowId: SELF_HEAL_SCHEDULE_ID,
      },
      policies: { overlap: ScheduleOverlapPolicy.SKIP },
    });
  } catch (err) {
    if (!/already exist/i.test(err instanceof Error ? err.message : String(err))) throw err;
  }
}