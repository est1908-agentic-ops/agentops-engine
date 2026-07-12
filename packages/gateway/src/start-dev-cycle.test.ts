import { describe, expect, it, vi } from 'vitest';
import { WorkflowExecutionAlreadyStartedError, WorkflowIdReusePolicy } from '@temporalio/client';
import type { ProjectConfig } from '@agentops/contracts';
import type { IssueLabeledEvent } from './parse-issue-labeled';
import { startDevCycleForIssue } from './start-dev-cycle';

const event: IssueLabeledEvent = {
  repo: 'octocat/hello-world',
  issueRef: 'octocat/hello-world#42',
  issueNumber: 42,
  title: 'Add a widget',
};

const config: ProjectConfig = {
  stages: {},
  routing: {},
  brakes: { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 },
};

function fakeClient(start: (...args: unknown[]) => Promise<unknown>) {
  return { workflow: { start } } as never;
}

describe('startDevCycleForIssue', () => {
  it('starts devCycle with a deterministic workflow id derived from the project and issue', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient(start);

    const result = await startDevCycleForIssue(client, 'agentops-devcycle', 'my-project', event, config);

    expect(result).toEqual({ taskId: 'issue-my-project-42', started: true });
    expect(start).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        taskQueue: 'agentops-devcycle',
        workflowId: 'devcycle:my-project:42',
        workflowIdReusePolicy: expect.anything(),
        args: [
          {
            taskId: 'issue-my-project-42',
            project: 'my-project',
            repo: 'octocat/hello-world',
            issueRef: 'octocat/hello-world#42',
            goal: 'Add a widget',
            config,
          },
        ],
      }),
    );
  });

  it('slugifies a project name with spaces so the taskId is a valid git branch, keeping the raw name in the workflow id', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient(start);

    const result = await startDevCycleForIssue(client, 'agentops-devcycle', 'Artem private agents', event, config);

    // taskId becomes `agentops/<taskId>` and a workspace dir -> must be slug-safe.
    expect(result.taskId).toBe('issue-artem-private-agents-42');
    expect(start).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        // workflow id keeps the human-readable raw project name (Temporal allows it).
        workflowId: 'devcycle:Artem private agents:42',
        args: [expect.objectContaining({ taskId: 'issue-artem-private-agents-42', project: 'Artem private agents' })],
      }),
    );
  });

  it('does not collide across two projects whose repos would collapse to the same slug', async () => {
    // "foo-bar/baz" and "foo/bar-baz" both naively collapse to "foo-bar-baz"
    // if you replace "/" with "-" — keying by the (registry-unique) project
    // name instead of a lossy transform of event.repo avoids that collision.
    const start = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient(start);

    const eventA: IssueLabeledEvent = { ...event, repo: 'foo-bar/baz', issueRef: 'foo-bar/baz#42' };
    const eventB: IssueLabeledEvent = { ...event, repo: 'foo/bar-baz', issueRef: 'foo/bar-baz#42' };

    const resultA = await startDevCycleForIssue(client, 'agentops-devcycle', 'project-a', eventA, config);
    const resultB = await startDevCycleForIssue(client, 'agentops-devcycle', 'project-b', eventB, config);

    expect(resultA.taskId).not.toEqual(resultB.taskId);
  });

  it('uses devcycle:<project>:<issueNumber> and AllowDuplicateFailedOnly', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient(start);
    await startDevCycleForIssue(client, 'agentops-engine', 'acme', event, config);
    const opts = start.mock.calls[0][1];
    expect(opts.workflowId).toBe('devcycle:acme:42');
    expect(opts.workflowIdReusePolicy).toBe(WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY);
  });

  it('treats an already-started workflow as an idempotent no-op, not an error', async () => {
    const start = vi.fn().mockRejectedValue(new WorkflowExecutionAlreadyStartedError('already started', 'wf-1', 'devCycle'));
    const client = fakeClient(start);

    const result = await startDevCycleForIssue(client, 'agentops-devcycle', 'my-project', event, config);

    expect(result).toEqual({ taskId: 'issue-my-project-42', started: false });
  });

  it('rethrows any other error', async () => {
    const start = vi.fn().mockRejectedValue(new Error('temporal unreachable'));
    const client = fakeClient(start);

    await expect(startDevCycleForIssue(client, 'agentops-devcycle', 'my-project', event, config)).rejects.toThrow(
      'temporal unreachable',
    );
  });
});
