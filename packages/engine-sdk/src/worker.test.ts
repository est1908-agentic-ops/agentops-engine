import { describe, it, expect, vi } from 'vitest';
vi.mock('@temporalio/worker', () => ({ Worker: { create: vi.fn().mockResolvedValue({ run: vi.fn() }) } }));
import { createEngineWorker } from './worker';

describe('createEngineWorker', () => {
  it('registers the project header inbound interceptor + the outbound workflow module', async () => {
    const { Worker } = await import('@temporalio/worker');
    await createEngineWorker({ taskQueue: 'proj-acme', workflowsPath: '/x', activities: {} });
    const opts = (Worker as any).create.mock.calls[0][0];
    expect(opts.taskQueue).toBe('proj-acme');
    expect(opts.interceptors.activity).toHaveLength(1);
    expect(opts.interceptors.workflowModules).toHaveLength(1);
  });
});
