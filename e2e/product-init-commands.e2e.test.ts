import { afterEach, describe, expect, it } from 'vitest';
import type { TaskInput } from '@agentops/contracts';
import { devCycle } from '@agentops/workflows';
import { buildTestEnv, teardownTestEnv, waitForStatus, type TestEnv } from './helpers';

describe('DevCycle e2e: project initCommands reach workspace preparation', () => {
  let testEnv: TestEnv | undefined;

  afterEach(async () => {
    await teardownTestEnv(testEnv);
  });

  it('threads config.initCommands from TaskInput into prepareWorkspace before any stage runs', async () => {
    testEnv = await buildTestEnv();
    const { env, worker, stub, tracker, scm, workspaces, taskQueue } = testEnv;

    tracker.seedIssue({ ref: 'issue-1', title: 'Add widget', body: 'Please add a widget', labels: [] });
    stub.scriptResponse('full_verify', 1, { output: 'FULL: PASS' });
    stub.scriptResponse('review', 1, { output: 'VERDICT: PASS' });
    scm.scriptFeedback('pr-1', [{ ciStatus: 'green', unresolvedThreads: 0, comments: [] }]);

    const input: TaskInput = {
      taskId: 'init-commands-task',
      project: 'demo',
      repo: 'demo/repo',
      issueRef: 'issue-1',
      goal: 'Add a widget',
      config: {
        initCommands: ['pnpm install', 'pnpm worktree-setup'],
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
      await waitForStatus(handle, ['done', 'blocked', 'failed'], 30_000);
      return handle.result();
    });

    expect(finalState.status).toBe('done');
    expect(workspaces.initCommandsFor(finalState.workspaceRef)).toEqual(['pnpm install', 'pnpm worktree-setup']);
  });
});
