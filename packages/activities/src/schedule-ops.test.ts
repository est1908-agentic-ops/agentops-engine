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

describe('listAgentSchedules (mocked ScheduleClient)', () => {
  it('reads the correct workflow type and spec from ScheduleSummary', async () => {
    const client: ScheduleClientLike = {
      getHandle: vi.fn(),
      list: async function* () {
        // Real Temporal SDK ScheduleSummary: spec contains decoded calendars/intervals,
        // not the original cronExpressions. Schedule cron is recovered from memo.
        yield {
          scheduleId: 'agent:acme:nightly',
          spec: {
            calendars: [
              {
                second: [{ start: 0, end: 0 }],
                minute: [{ start: 2, end: 2 }],
                dayOfMonth: [{ start: 0, end: 30 }],
                month: [{ start: 0, end: 11 }],
                dayOfWeek: [{ start: 0, end: 6 }],
              },
            ],
            timezone: 'UTC',
          },
          action: {
            type: 'startWorkflow',
            workflowType: 'whiteboxBugHunt',
            taskQueue: 'q',
          },
          memo: {
            project: 'acme',
            agentName: 'nightly',
            workflowType: 'whiteboxBugHunt',
            schedule: '0 2 * * *',
          },
          state: {
            paused: false,
          },
        };
        yield {
          scheduleId: 'agent:other:thing',
          spec: {
            calendars: [
              {
                second: [{ start: 0, end: 0 }],
                minute: [{ start: 1, end: 1 }],
                dayOfMonth: [{ start: 0, end: 30 }],
                month: [{ start: 0, end: 11 }],
                dayOfWeek: [{ start: 0, end: 6 }],
              },
            ],
            timezone: 'UTC',
          },
          action: {
            type: 'startWorkflow',
            workflowType: 'someOtherWorkflow',
            taskQueue: 'other-q',
          },
          memo: {
            project: 'other',
            agentName: 'thing',
            workflowType: 'someOtherWorkflow',
            schedule: '0 1 * * *',
          },
          state: {
            paused: false,
          },
        };
      },
    };

    const result = await listAgentSchedules('acme', client);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('agent:acme:nightly');
    expect(result[0].workflow).toBe('whiteboxBugHunt');
    expect(result[0].scheduleSpec).toBe('0 2 * * *');
    expect(result[0].taskQueue).toBe('q');
  });
});
