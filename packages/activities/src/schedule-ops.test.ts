import { describe, it, expect, vi } from 'vitest';
import type { ScheduleClientLike } from './schedule-ops';
import { applyScheduleChanges, listAgentSchedules } from './schedule-ops';
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
  return { create, getHandle, list: async function* () {} } as unknown as ScheduleClientLike & {
    create: any;
    getHandle: any;
  };
}

describe('applyScheduleChanges (mocked ScheduleClient)', () => {
  it('creates schedules for toCreate entries (skips continuous)', async () => {
    const client = makeMockClient();
    const plan: ReconcilePlan = {
      toCreate: [
        {
          name: 'nightly',
          workflow: 'whiteboxBugHunt',
          schedule: '0 2 * * *',
          input: {},
          enabled: true,
          timezone: 'UTC',
          overlap: 'skip',
        } as any,
      ],
      toUpdate: [],
      toDelete: [],
      toPause: [],
      toResume: [],
    };
    await applyScheduleChanges('acme', 'acme/web', plan, {
      scheduleClient: client,
      taskQueue: 'q',
    });
    expect(client.create).toHaveBeenCalled();
    const arg = client.create.mock.calls[0][0];
    expect(arg.scheduleId).toMatch(/agent:acme:nightly/);
    // SDK ScheduleSpec shape (cronExpressions), not the ignored spec.cron.cronString.
    expect(arg.spec.cronExpressions).toEqual(['0 2 * * *']);
    expect(arg.spec.cron).toBeUndefined();
  });

  it('deletes for toDelete', async () => {
    const client = makeMockClient();
    const plan: ReconcilePlan = {
      toCreate: [],
      toUpdate: [],
      toDelete: ['agent:p:x'],
      toPause: [],
      toResume: [],
    };
    await applyScheduleChanges('p', 'p/r', plan, { scheduleClient: client });
    expect(client.getHandle).toHaveBeenCalledWith('agent:p:x');
  });

  it('updates via an updater function, matching the real ScheduleHandle.update contract', async () => {
    const client = makeMockClient();
    const plan: ReconcilePlan = {
      toCreate: [],
      toDelete: [],
      toPause: [],
      toResume: [],
      toUpdate: [
        {
          name: 'nightly',
          workflow: 'whiteboxBugHunt',
          schedule: '0 2 * * *',
          input: {},
          enabled: true,
          timezone: 'UTC',
          overlap: 'skip',
        } as any,
      ],
    };
    await applyScheduleChanges('acme', 'acme/web', plan, {
      scheduleClient: client,
      taskQueue: 'q',
    });
    const handle = client.getHandle.mock.results[0].value;
    expect(typeof handle.update.mock.calls[0][0]).toBe('function');
    const result = await handle.update.mock.calls[0][0]({});
    expect(result.action.taskQueue).toBe('q');
  });
});

describe('listAgentSchedules (reference implementation)', () => {
  const LEGACY_ENGINE_QUEUE = 'agentops-devcycle';

  it('surfaces the real task queue from describe() for matched schedules', async () => {
    const describe = vi.fn().mockResolvedValue({
      action: {
        taskQueue: LEGACY_ENGINE_QUEUE,
        workflowType: 'whiteboxBugHunt',
      },
    } as any);
    const getHandle = vi.fn((_id: string) => ({ describe }));
    const client = {
      getHandle,
      list: async function* () {
        yield {
          scheduleId: 'agent:acme:nightly',
          action: { type: 'startWorkflow' },
          schedule: { spec: { cronExpressions: ['0 2 * * *'], timezone: 'UTC' } },
        } as any;
      },
    } as unknown as ScheduleClientLike;

    const schedules = await listAgentSchedules('acme', client);

    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({
      id: 'agent:acme:nightly',
      taskQueue: LEGACY_ENGINE_QUEUE,
      workflow: 'whiteboxBugHunt',
    });
    expect(getHandle).toHaveBeenCalledWith('agent:acme:nightly');
    expect(describe).toHaveBeenCalled();
  });

  it('degrades to undefined taskQueue when describe() throws', async () => {
    const describe = vi.fn().mockRejectedValue(new Error('describe failed'));
    const getHandle = vi.fn((_id: string) => ({ describe }));
    const client = {
      getHandle,
      list: async function* () {
        yield {
          scheduleId: 'agent:acme:nightly',
          action: { type: 'startWorkflow' },
          schedule: { spec: { cronExpressions: ['0 2 * * *'], timezone: 'UTC' } },
        } as any;
      },
    } as unknown as ScheduleClientLike;

    const schedules = await listAgentSchedules('acme', client);

    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({
      id: 'agent:acme:nightly',
      taskQueue: undefined,
      workflow: 'startWorkflow', // from summary since describe failed
    });
  });

  it('skips describe() for non-matching ids', async () => {
    const describe = vi.fn();
    const getHandle = vi.fn((_id: string) => ({ describe }));
    const client = {
      getHandle,
      list: async function* () {
        yield {
          scheduleId: 'agent:other:nightly',
          action: { type: 'startWorkflow' },
          schedule: { spec: { cronExpressions: ['0 2 * * *'], timezone: 'UTC' } },
        } as any;
      },
    } as unknown as ScheduleClientLike;

    await listAgentSchedules('acme', client);

    expect(getHandle).not.toHaveBeenCalled();
    expect(describe).not.toHaveBeenCalled();
  });
});
