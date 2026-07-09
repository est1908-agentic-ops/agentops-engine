import { afterEach, describe, expect, it } from 'vitest';
import type { TaskInput } from '@agentops/contracts';
import { LiteLlmBackend } from '@agentops/backends';
import { devCycle, resumeSignal } from '@agentops/workflows';
import { buildTestEnv, teardownTestEnv, waitForStatus, type TestEnv } from './helpers';

function baseConfig(routingOverrides: TaskInput['config']['routing']): TaskInput['config'] {
  return {
    fastVerifyCommands: [],
    fullVerifyCommands: [],
    stages: {},
    routing: routingOverrides,
    brakes: { maxImplementAttempts: 3, maxIterations: 10, maxTokens: 1_000_000, maxBabysitRounds: 5 },
  };
}

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const SUCCESS_BODY = {
  choices: [{ message: { content: 'ok' } }],
  usage: { prompt_tokens: 5, completion_tokens: 5 },
};

const BUDGET_EXCEEDED_BODY = {
  error: { message: 'Budget has been exceeded! Current cost: 1.20, Max budget: 1.00', error_class: 'BudgetExceededError' },
};

describe('DevCycle e2e: LiteLLM routing and budget enforcement (M5 gate)', () => {
  let testEnv: TestEnv | undefined;

  afterEach(async () => {
    await teardownTestEnv(testEnv);
  });

  it('routes two tasks to different backends per their ProjectConfig', async () => {
    const litellm = new LiteLlmBackend({
      baseUrl: 'http://litellm.platform.svc.cluster.local:4000',
      apiKey: 'sk-virtual-key',
      fetchFn: (async () => fakeResponse(200, SUCCESS_BODY)) as unknown as typeof fetch,
    });
    testEnv = await buildTestEnv({ extraBackends: { litellm } });
    const { env, worker, stub, scm, taskQueue } = testEnv;

    stub.scriptResponse('implement', 1, { output: 'diff', tokensIn: 10, tokensOut: 10 });
    stub.scriptResponse('full_verify', 1, { output: 'FULL: PASS', tokensIn: 0, tokensOut: 0 });
    stub.scriptResponse('review', 1, { output: 'VERDICT: PASS', tokensIn: 0, tokensOut: 0 });
    // Both tasks run concurrently, so which one's openPr call lands on
    // MemoryScmPort's shared pr-1/pr-2 counter first isn't deterministic --
    // script both refs identically rather than assuming an order.
    scm.scriptFeedback('pr-1', [{ ciStatus: 'green', unresolvedThreads: 0, comments: [] }]);
    scm.scriptFeedback('pr-2', [{ ciStatus: 'green', unresolvedThreads: 0, comments: [] }]);

    const claudeInput: TaskInput = {
      taskId: 'claude-task',
      project: 'project-a',
      repo: 'org/project-a',
      goal: 'Route through the CLI-style backend',
      config: baseConfig({ context: { backend: 'stub', model: 'stub' } }),
    };
    const litellmInput: TaskInput = {
      taskId: 'litellm-task',
      project: 'project-b',
      repo: 'org/project-b',
      goal: 'Route through the LiteLLM-fronted backend',
      config: baseConfig({ context: { backend: 'litellm', model: 'zai-glm-4.6' } }),
    };

    const [claudeFinal, litellmFinal] = await worker.runUntil(async () => {
      const claudeHandle = await env.client.workflow.start(devCycle, {
        taskQueue,
        workflowId: claudeInput.taskId,
        args: [claudeInput],
      });
      const litellmHandle = await env.client.workflow.start(devCycle, {
        taskQueue,
        workflowId: litellmInput.taskId,
        args: [litellmInput],
      });
      await waitForStatus(claudeHandle, ['done', 'failed'], 15_000);
      await waitForStatus(litellmHandle, ['done', 'failed'], 15_000);
      return Promise.all([claudeHandle.result(), litellmHandle.result()]);
    });

    expect(claudeFinal.status).toBe('done');
    expect(litellmFinal.status).toBe('done');
    expect(scm.getOpenedPrs()).toHaveLength(2);
  });

  it('blocks on budget-exceeded then completes after a resume signal', async () => {
    let calls = 0;
    const litellm = new LiteLlmBackend({
      baseUrl: 'http://litellm.platform.svc.cluster.local:4000',
      apiKey: 'sk-virtual-key',
      fetchFn: (async () => {
        calls += 1;
        return calls === 1 ? fakeResponse(429, BUDGET_EXCEEDED_BODY) : fakeResponse(200, SUCCESS_BODY);
      }) as unknown as typeof fetch,
    });
    testEnv = await buildTestEnv({ extraBackends: { litellm } });
    const { env, worker, stub, scm, taskQueue } = testEnv;

    stub.scriptResponse('implement', 1, { output: 'diff', tokensIn: 10, tokensOut: 10 });
    stub.scriptResponse('full_verify', 1, { output: 'FULL: PASS', tokensIn: 0, tokensOut: 0 });
    stub.scriptResponse('review', 1, { output: 'VERDICT: PASS', tokensIn: 0, tokensOut: 0 });
    scm.scriptFeedback('pr-1', [{ ciStatus: 'green', unresolvedThreads: 0, comments: [] }]);

    const input: TaskInput = {
      taskId: 'budget-brake-task',
      project: 'demo',
      repo: 'demo/repo',
      goal: 'Trip a deliberately low LiteLLM virtual-key budget',
      config: baseConfig({ context: { backend: 'litellm', model: 'zai-glm-4.6' } }),
    };

    const finalState = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(devCycle, {
        taskQueue,
        workflowId: input.taskId,
        args: [input],
      });

      const blocked = await waitForStatus(handle, ['blocked', 'done', 'failed'], 10_000);
      expect(blocked.status).toBe('blocked');
      expect(blocked.blockReason).toBe('budget-exceeded');

      await handle.signal(resumeSignal);
      await waitForStatus(handle, ['done', 'failed'], 10_000);
      return handle.result();
    });

    expect(finalState.status).toBe('done');
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(scm.getOpenedPrs()).toHaveLength(1);
  });
});
