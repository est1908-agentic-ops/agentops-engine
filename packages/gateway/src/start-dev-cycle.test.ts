import { describe, expect, it, vi } from 'vitest';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import type { ProductConfig } from '@agentops/contracts';
import type { IssueLabeledEvent } from './parse-issue-labeled';
import { startDevCycleForIssue } from './start-dev-cycle';

const event: IssueLabeledEvent = {
  repo: 'octocat/hello-world',
  issueRef: 'octocat/hello-world#42',
  issueNumber: 42,
  title: 'Add a widget',
};

const config: ProductConfig = {
  stages: {},
  routing: {},
  brakes: { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 },
};

function fakeClient(start: (...args: unknown[]) => Promise<unknown>) {
  return { workflow: { start } } as never;
}

describe('startDevCycleForIssue', () => {
  it('starts devCycle with a deterministic workflow id derived from the issue', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient(start);

    const result = await startDevCycleForIssue(client, 'agentops-devcycle', 'my-product', event, config);

    expect(result).toEqual({ taskId: 'issue-octocat-hello-world-42', started: true });
    expect(start).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        taskQueue: 'agentops-devcycle',
        workflowId: 'issue-octocat-hello-world-42',
        args: [
          {
            taskId: 'issue-octocat-hello-world-42',
            product: 'my-product',
            repo: 'octocat/hello-world',
            issueRef: 'octocat/hello-world#42',
            goal: 'Add a widget',
            config,
          },
        ],
      }),
    );
  });

  it('treats an already-started workflow as an idempotent no-op, not an error', async () => {
    const start = vi.fn().mockRejectedValue(new WorkflowExecutionAlreadyStartedError('already started', 'wf-1', 'devCycle'));
    const client = fakeClient(start);

    const result = await startDevCycleForIssue(client, 'agentops-devcycle', 'my-product', event, config);

    expect(result).toEqual({ taskId: 'issue-octocat-hello-world-42', started: false });
  });

  it('rethrows any other error', async () => {
    const start = vi.fn().mockRejectedValue(new Error('temporal unreachable'));
    const client = fakeClient(start);

    await expect(startDevCycleForIssue(client, 'agentops-devcycle', 'my-product', event, config)).rejects.toThrow(
      'temporal unreachable',
    );
  });
});
