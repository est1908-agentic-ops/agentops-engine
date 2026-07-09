import { afterEach, describe, expect, it } from 'vitest';
import type { TaskInput } from '@agentops/contracts';
import { devCycle, resumeSignal } from '@agentops/workflows';
import { buildTestEnv, teardownTestEnv, waitForStatus, type TestEnv } from './helpers';

describe('DevCycle e2e: brake + rescue', () => {
  let testEnv: TestEnv | undefined;

  afterEach(async () => {
    await teardownTestEnv(testEnv);
  });

  it('blocks on token-brake then completes after a resume signal', async () => {
    testEnv = await buildTestEnv();
    const { env, worker, stub, scm, taskQueue } = testEnv;

    stub.scriptResponse('implement', 1, { output: 'diff', tokensIn: 60_000, tokensOut: 0 });
    stub.scriptResponse('full_verify', 1, { output: 'FULL: PASS', tokensIn: 0, tokensOut: 0 });
    stub.scriptResponse('review', 1, { output: 'VERDICT: PASS', tokensIn: 0, tokensOut: 0 });

    scm.scriptFeedback('pr-1', [{ ciStatus: 'green', unresolvedThreads: 0, comments: [] }]);

    const input: TaskInput = {
      taskId: 'brake-rescue-task',
      project: 'demo',
      repo: 'demo/repo',
      goal: 'Trigger a token brake',
      config: {
        fastVerifyCommands: [],
        fullVerifyCommands: [],
        stages: {},
        routing: {},
        brakes: { maxImplementAttempts: 3, maxIterations: 10, maxTokens: 50_000, maxBabysitRounds: 5 },
      },
    };

    const finalState = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(devCycle, {
        taskQueue,
        workflowId: input.taskId,
        args: [input],
      });

      const blocked = await waitForStatus(handle, ['blocked', 'done', 'failed'], 10_000);
      expect(blocked.status).toBe('blocked');
      expect(blocked.blockReason).toBe('token-brake');

      await handle.signal(resumeSignal);
      await waitForStatus(handle, ['done', 'failed'], 10_000);
      return handle.result();
    });

    expect(finalState.status).toBe('done');
    expect(scm.getOpenedPrs()).toHaveLength(1);
  });
});
