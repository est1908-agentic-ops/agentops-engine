import { afterEach, describe, expect, it } from 'vitest';
import type { TaskInput } from '@agentops/contracts';
import { devCycle } from '@agentops/workflows';
import { buildTestEnv, waitForStatus, type TestEnv } from './helpers';

describe('DevCycle e2e: garbage verdict never blocks', () => {
  let testEnv: TestEnv | undefined;

  afterEach(async () => {
    await testEnv?.env.teardown();
  });

  it('treats a twice-garbled review verdict as a retryable FAIL and proceeds to a fixer round', async () => {
    testEnv = await buildTestEnv();
    const { env, worker, stub, scm, taskQueue } = testEnv;

    stub.scriptResponse('implement', 1, { output: 'diff attempt 1' });
    stub.scriptResponse('full_verify', 1, { output: 'FULL: PASS' });
    stub.scriptResponse('review', 1, { output: 'not a verdict at all' }, 1);
    stub.scriptResponse('review', 1, { output: 'still garbage' }, 2);

    stub.scriptResponse('implement', 2, { output: 'diff attempt 2' });
    stub.scriptResponse('full_verify', 2, { output: 'FULL: PASS' });
    stub.scriptResponse('review', 2, { output: 'VERDICT: PASS' }, 1);

    scm.scriptFeedback('pr-1', [{ ciStatus: 'green', unresolvedThreads: 0, comments: [] }]);

    const input: TaskInput = {
      taskId: 'garbage-verdict-task',
      project: 'demo',
      repo: 'demo/repo',
      goal: 'Survive a garbled reviewer',
      config: {
        fastVerifyCommands: [],
        fullVerifyCommands: [],
        stages: {},
        routing: {},
        brakes: { maxImplementAttempts: 3, maxIterations: 10, maxTokens: 1_000_000, maxBabysitRounds: 5 },
      },
    };

    let sawBlocked = false;
    const finalState = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(devCycle, {
        taskQueue,
        workflowId: input.taskId,
        args: [input],
      });

      for (let i = 0; i < 5; i += 1) {
        const state = await handle.query('state');
        if (state.status === 'blocked') {
          sawBlocked = true;
        }
        if (state.status === 'done' || state.status === 'failed') {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await waitForStatus(handle, ['done', 'failed'], 10_000);
      return handle.result();
    });

    expect(sawBlocked).toBe(false);
    expect(finalState.status).toBe('done');
    expect(finalState.implementAttempts).toBe(2);
    expect(scm.getOpenedPrs()).toHaveLength(1);
  });
});
