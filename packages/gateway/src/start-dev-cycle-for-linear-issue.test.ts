import { describe, expect, it, vi } from 'vitest';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import type { ProjectConfig } from '@agentops/contracts';
import type { LinearIssueEvent } from './parse-linear-issue-event';
import { startDevCycleForLinearIssue } from './start-dev-cycle-for-linear-issue';

const event: LinearIssueEvent = {
  teamKey: 'ENG',
  identifier: 'ENG-123',
  title: 'Add a widget',
  labelIds: ['label-uuid'],
  previousLabelIds: [],
  webhookTimestamp: 1_700_000_000_000,
};

const config: ProjectConfig = {
  stages: {},
  routing: {},
  brakes: { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 },
};

function fakeClient(start: (...args: unknown[]) => Promise<unknown>) {
  return { workflow: { start } } as never;
}

describe('startDevCycleForLinearIssue', () => {
  it('starts devCycle with a deterministic workflow id derived from the project and identifier', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient(start);

    const result = await startDevCycleForLinearIssue(
      client,
      'agentops-devcycle',
      'my-project',
      event,
      'octocat/hello-world',
      config,
    );

    expect(result).toEqual({ taskId: 'linear-my-project-ENG-123', started: true });
    expect(start).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        taskQueue: 'agentops-devcycle',
        workflowId: 'linear-my-project-ENG-123',
        args: [
          {
            taskId: 'linear-my-project-ENG-123',
            project: 'my-project',
            repo: 'octocat/hello-world',
            issueRef: 'linear:ENG-123',
            goal: 'Add a widget',
            config,
          },
        ],
      }),
    );
  });

  it('never collides with the GitHub path\'s workflow id space, even for the same project', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient(start);

    const result = await startDevCycleForLinearIssue(
      client,
      'agentops-devcycle',
      'my-project',
      { ...event, identifier: '42' },
      'octocat/hello-world',
      config,
    );

    // The GitHub path's id for the same project + "42" would be "issue-my-project-42" --
    // distinct prefix means no collision even in this contrived same-string case.
    expect(result.taskId).toBe('linear-my-project-42');
    expect(result.taskId).not.toBe('issue-my-project-42');
  });

  it('treats an already-started workflow as an idempotent no-op, not an error', async () => {
    const start = vi.fn().mockRejectedValue(new WorkflowExecutionAlreadyStartedError('already started', 'wf-1', 'devCycle'));
    const client = fakeClient(start);

    const result = await startDevCycleForLinearIssue(
      client,
      'agentops-devcycle',
      'my-project',
      event,
      'octocat/hello-world',
      config,
    );

    expect(result).toEqual({ taskId: 'linear-my-project-ENG-123', started: false });
  });

  it('rethrows any other error', async () => {
    const start = vi.fn().mockRejectedValue(new Error('temporal unreachable'));
    const client = fakeClient(start);

    await expect(
      startDevCycleForLinearIssue(client, 'agentops-devcycle', 'my-project', event, 'octocat/hello-world', config),
    ).rejects.toThrow('temporal unreachable');
  });
});
