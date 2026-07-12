/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
vi.mock('@temporalio/workflow', () => ({
  proxyActivities: (opts: any) => ({ __opts: opts }),
  executeChild: vi.fn(),
  workflowInfo: () => ({ memo: { project: 'acme' } }),
}));
import { engineActivities, engineAgent, ENGINE_QUEUE } from './workflow';

describe('engine-sdk/workflow', () => {
  it('proxies engine activities to ENGINE_QUEUE', () => {
    expect(ENGINE_QUEUE).toBe('agentops-engine');
    expect((engineActivities() as any).__opts.taskQueue).toBe(ENGINE_QUEUE);
    expect((engineAgent() as any).__opts.taskQueue).toBe(ENGINE_QUEUE);
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
