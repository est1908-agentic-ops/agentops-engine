import { describe, it, expect, vi } from 'vitest';
import type { ScheduleClientLike } from './schedule-ops';
import { applyScheduleChanges } from './schedule-ops';
import type { ReconcilePlan } from '@agentops/policies';

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeMockClient() {
  const create = vi.fn().mockResolvedValue({} as any);
  const getHandle = vi.fn((_id: string) => ({
    update: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    unpause: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  }));
  return { create, getHandle, list: async function* () {} } as unknown as ScheduleClientLike & { create: any; getHandle: any };
}

describe('applyScheduleChanges (mocked ScheduleClient)', () => {
  it('creates schedules for toCreate entries (skips continuous)', async () => {
    const client = makeMockClient();
    const plan: ReconcilePlan = {
      toCreate: [{ name: 'nightly', workflow: 'whiteboxBugHunt', schedule: '0 2 * * *', input: {}, enabled: true, timezone: 'UTC', overlap: 'skip' } as any],
      toUpdate: [], toDelete: [], toPause: [], toResume: [],
    };
    await applyScheduleChanges('acme', 'acme/web', plan, { scheduleClient: client, taskQueue: 'q' });
    expect(client.create).toHaveBeenCalled();
    const arg = client.create.mock.calls[0][0];
    expect(arg.scheduleId).toMatch(/agent:acme:nightly/);
  });

  it('deletes for toDelete', async () => {
    const client = makeMockClient();
    const plan: ReconcilePlan = { toCreate: [], toUpdate: [], toDelete: ['agent:p:x'], toPause: [], toResume: [] };
    await applyScheduleChanges('p', 'p/r', plan, { scheduleClient: client });
    expect(client.getHandle).toHaveBeenCalledWith('agent:p:x');
  });
});
