import { describe, expect, it, vi } from 'vitest';
import { ensureSelfHealSchedule } from './ensure-self-heal-schedule';

describe('ensureSelfHealSchedule', () => {
  it('creates the self-heal schedule when enabled', async () => {
    const create = vi.fn().mockResolvedValue({});
    await ensureSelfHealSchedule(
      { create, getHandle: () => ({ delete: vi.fn() }) } as never,
      'agentops-engine',
      {
        enabled: true,
        cron: '*/30 * * * *',
      },
    );
    const opts = create.mock.calls[0][0] as {
      scheduleId: string;
      spec: { cronExpressions?: string[]; timezone?: string; cron?: unknown };
      action: { workflowType: string; taskQueue: string; workflowId: string };
      policies: { overlap: unknown };
    };
    expect(opts.scheduleId).toBe('self-heal');
    expect(opts.action.workflowType).toBe('selfHeal');
    expect(opts.action.taskQueue).toBe('agentops-engine');
    expect(opts.action.workflowId).toBe('self-heal');
    expect(opts.spec.cronExpressions).toEqual(['*/30 * * * *']);
    expect(opts.spec.timezone).toBe('UTC');
    expect(opts.spec.cron).toBeUndefined();
    expect(opts.policies.overlap).toBeDefined();
  });

  it('is idempotent when the schedule already exists', async () => {
    const create = vi.fn().mockRejectedValue(new Error('schedule already exists'));
    await expect(
      ensureSelfHealSchedule(
        { create, getHandle: () => ({ delete: vi.fn() }) } as never,
        'agentops-engine',
        {
          enabled: true,
          cron: '*/30 * * * *',
        },
      ),
    ).resolves.toBeUndefined();
  });

  it('deletes the schedule when disabled', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn();
    await ensureSelfHealSchedule(
      { create, getHandle: () => ({ delete: del }) } as never,
      'agentops-engine',
      {
        enabled: false,
        cron: '*/30 * * * *',
      },
    );
    expect(del).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('swallows a not-found error when disabling an absent schedule', async () => {
    const del = vi.fn().mockRejectedValue(new Error('schedule not found'));
    await expect(
      ensureSelfHealSchedule(
        { create: vi.fn(), getHandle: () => ({ delete: del }) } as never,
        'agentops-engine',
        {
          enabled: false,
          cron: '*/30 * * * *',
        },
      ),
    ).resolves.toBeUndefined();
  });
});
