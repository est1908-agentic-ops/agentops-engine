import { afterEach, describe, expect, it } from 'vitest';
import type { TaskInput } from '@agentops/contracts';
import { devCycle } from '@agentops/workflows';
import { buildTestEnv, teardownTestEnv, waitForStatus, type TestEnv } from './helpers';

describe('DevCycle e2e: happy path with one repair round', () => {
  let testEnv: TestEnv | undefined;

  afterEach(async () => {
    await teardownTestEnv(testEnv);
  });

  it('reaches done after one full_verify failure and one babysit fix round', async () => {
    testEnv = await buildTestEnv();
    const { env, worker, stub, tracker, scm, stats, taskQueue } = testEnv;

    tracker.seedIssue({
      ref: 'issue-1',
      title: 'Add widget',
      body: 'Please add a widget',
      labels: [],
    });

    stub.scriptResponse('implement', 1, {
      output: 'diff --git a/widget.ts b/widget.ts (attempt 1)',
    });
    stub.scriptResponse('full_verify', 1, { output: 'FULL: FAIL 1 test failing' });
    stub.scriptResponse('implement', 2, {
      output: 'diff --git a/widget.ts b/widget.ts (attempt 2)',
    });
    stub.scriptResponse('full_verify', 2, { output: 'FULL: PASS' });
    stub.scriptResponse('review', 1, { output: 'VERDICT: PASS' });
    stub.scriptResponse('implement', 3, {
      output: 'diff --git a/widget.ts b/widget.ts (babysit fix)',
    });

    scm.scriptFeedback('pr-1', [
      {
        ciStatus: 'failed',
        unresolvedThreads: 0,
        comments: [{ id: 'c1', body: 'CI failed', resolved: false }],
      },
      { ciStatus: 'green', unresolvedThreads: 0, comments: [] },
    ]);

    const input: TaskInput = {
      taskId: 'happy-path-task',
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
    expect(finalState.stage).toBe('done');
    expect(finalState.landingOutcome).toBe('merge-ready-manual');
    expect(finalState.implementAttempts).toBe(2);
    expect(scm.getOpenedPrs()).toHaveLength(1);
    const allStats = await stats.all();
    expect(allStats.filter((s) => s.stage === 'implement').length).toBeGreaterThanOrEqual(2);
    expect(allStats.filter((s) => s.stage === 'full_verify').length).toBeGreaterThanOrEqual(2);
    expect(allStats.filter((s) => s.stage === 'review').length).toBeGreaterThanOrEqual(1);
    expect(testEnv.workspaces.isPrepared(finalState.workspaceRef)).toBe(true);
    expect(testEnv.workspaces.isCleanedUp(finalState.workspaceRef)).toBe(true);
  });
});
