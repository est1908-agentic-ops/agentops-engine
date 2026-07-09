import { afterEach, describe, expect, it } from 'vitest';
import type { TaskInput } from '@agentops/contracts';
import { devCycle } from '@agentops/workflows';
import { buildTestEnv, teardownTestEnv, waitForStatus, type TestEnv } from './helpers';

describe('DevCycle e2e: exhausted repair rounds open the PR anyway', () => {
  let testEnv: TestEnv | undefined;

  afterEach(async () => {
    await teardownTestEnv(testEnv);
  });

  it('opens a PR with findings and comments on the issue after 3 failed review rounds', async () => {
    testEnv = await buildTestEnv();
    const { env, worker, stub, tracker, scm, taskQueue } = testEnv;

    tracker.seedIssue({ ref: 'issue-9', title: 'Hard bug', body: 'Never quite passes review', labels: [] });

    for (const attempt of [1, 2, 3]) {
      stub.scriptResponse('implement', attempt, { output: `diff attempt ${attempt}` });
      stub.scriptResponse('full_verify', attempt, { output: 'FULL: PASS' });
    }
    stub.scriptResponse('review', 1, { output: 'VERDICT: FAIL needs more tests' });
    stub.scriptResponse('review', 2, { output: 'VERDICT: FAIL still missing coverage' });
    stub.scriptResponse('review', 3, { output: 'VERDICT: FAIL not there yet' });

    scm.scriptFeedback('pr-1', [{ ciStatus: 'green', unresolvedThreads: 0, comments: [] }]);

    const input: TaskInput = {
      taskId: 'exhausted-rounds-task',
      project: 'demo',
      repo: 'demo/repo',
      issueRef: 'issue-9',
      goal: 'Fix the hard bug',
      config: {
        fastVerifyCommands: [],
        fullVerifyCommands: [],
        stages: {},
        routing: {},
        brakes: { maxImplementAttempts: 3, maxIterations: 10, maxTokens: 1_000_000, maxBabysitRounds: 5 },
      },
    };

    const finalState = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(devCycle, {
        taskQueue,
        workflowId: input.taskId,
        args: [input],
      });
      await waitForStatus(handle, ['done', 'blocked', 'failed'], 10_000);
      return handle.result();
    });

    expect(finalState.status).toBe('done');
    expect(finalState.implementAttempts).toBe(3);
    expect(scm.getOpenedPrs()).toHaveLength(1);
    const comments = tracker.getComments('issue-9');
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatch(/exhausted/i);
    expect(comments[0]).toMatch(/review: fail/i);
  });
});
