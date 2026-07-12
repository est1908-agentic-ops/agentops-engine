import { describe, it, expect, vi } from 'vitest';
import { PROJECT_HEADER_KEY } from '@agentops/contracts';

// The interceptor reads workflowInfo().memo; mock the workflow module.
vi.mock('@temporalio/workflow', () => ({
  workflowInfo: () => ({ memo: { project: 'acme' } }),
}));
import { defaultPayloadConverter } from '@temporalio/common';
import { interceptors } from './project-interceptor';

describe('project-interceptor (outbound)', () => {
  it('stamps the project header on an activity call', async () => {
    const out = interceptors().outbound![0];
    const next = vi.fn(async (input) => ({ result: undefined, ...input }));
    const input = { headers: {}, args: [], activityType: 'createIssue', options: {}, seq: 1 } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    await out.scheduleActivity!(input, next as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    const payload = next.mock.calls[0][0].headers[PROJECT_HEADER_KEY];
    expect(defaultPayloadConverter.fromPayload(payload)).toBe('acme');
  });

  it('stamps project memo + search attribute + header on a child workflow', async () => {
    const out = interceptors().outbound![0];
    const next = vi.fn(async (input) => ({ workflowExecution: { workflowId: 'x', runId: 'y' }, ...input }));
    const input = { headers: {}, args: [], workflowType: 'devCycle', options: {}, seq: 1 } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    await out.startChildWorkflowExecution!(input, next as any); // eslint-disable-line @typescript-eslint/no-explicit-any
    const passed = next.mock.calls[0][0];
    expect(defaultPayloadConverter.fromPayload(passed.headers[PROJECT_HEADER_KEY])).toBe('acme');
    expect(passed.options.memo.project).toBe('acme');
    expect(passed.options.searchAttributes.project).toEqual(['acme']);
  });
});
