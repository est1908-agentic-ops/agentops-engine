import { afterEach, describe, expect, it } from 'vitest';
import type { TaskInput } from '@agentops/contracts';
import { devCycle } from '@agentops/workflows';
import { buildTestEnv, waitForStatus, type TestEnv } from './helpers';

describe('DevCycle e2e: pushes the branch before opening the first PR', () => {
  let testEnv: TestEnv | undefined;

  afterEach(async () => {
    await testEnv?.env.teardown();
  });

  it('pushes before calling openPr, so the PR head ref exists on the remote', async () => {
    testEnv = await buildTestEnv();
    const { env, worker, stub, tracker, scm, taskQueue } = testEnv;

    tracker.seedIssue({
      ref: 'issue-1',
      title: 'Add widget',
      body: 'Please add a widget',
      labels: [],
    });

    stub.scriptResponse('implement', 1, { output: 'diff --git a/widget.ts b/widget.ts' });
    stub.scriptResponse('full_verify', 1, { output: 'FULL: PASS' });
    stub.scriptResponse('review', 1, { output: 'VERDICT: PASS' });

    scm.scriptFeedback('pr-1', [{ ciStatus: 'green', unresolvedThreads: 0, comments: [] }]);

    const input: TaskInput = {
      taskId: 'push-before-pr-task',
      project: 'demo',
      repo: 'demo/repo',
      issueRef: 'issue-1',
      goal: 'Add a widget',
      config: {
        fastVerifyCommands: [],
        fullVerifyCommands: [],
        stages: {},
        routing: {},
        brakes: {
          maxImplementAttempts: 3,
          maxIterations: 10,
          maxTokens: 1_000_000,
          maxBabysitRounds: 5,
        },
      },
    };

    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(devCycle, {
        taskQueue,
        workflowId: input.taskId,
        args: [input],
      });
      await waitForStatus(handle, ['done', 'blocked', 'failed'], 30_000);
    });

    const branch = 'agentops/push-before-pr-task';
    const ops = scm.getOperations();
    const pushIndex = ops.findIndex((op) => op.type === 'push' && op.branch === branch);
    const openPrIndex = ops.findIndex((op) => op.type === 'openPr' && op.branch === branch);

    expect(pushIndex).toBeGreaterThanOrEqual(0);
    expect(openPrIndex).toBeGreaterThan(pushIndex);
  });
});
