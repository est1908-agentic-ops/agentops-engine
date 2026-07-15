import { afterEach, describe, expect, it } from 'vitest';
import type { PrLandingInput, TaskInput } from '@agentops/contracts';
import { devCycle, prLanding } from '@agentops/workflows';
import {
  buildTestEnv,
  teardownTestEnv,
  waitForLandingOutcome,
  waitForStatus,
  type TestEnv,
} from './helpers';

const baseConfig = {
  fastVerifyCommands: [] as string[],
  fullVerifyCommands: [] as string[],
  stages: {},
  routing: {},
  brakes: { maxImplementAttempts: 3, maxIterations: 10, maxTokens: 1_000_000, maxBabysitRounds: 5 },
};

describe('PR landing e2e', () => {
  let testEnv: TestEnv | undefined;

  afterEach(async () => {
    await teardownTestEnv(testEnv);
  });

  it('devCycle with autoMerge all hands off and lands merged', async () => {
    testEnv = await buildTestEnv();
    const { env, worker, stub, tracker, scm, taskQueue } = testEnv;

    tracker.seedIssue({ ref: 'issue-1', title: 'Add widget', body: 'body', labels: [] });
    stub.scriptResponse('implement', 1, { output: 'diff' });
    stub.scriptResponse('full_verify', 1, { output: 'FULL: PASS' });
    stub.scriptResponse('review', 1, { output: 'VERDICT: PASS' });

    scm.scriptSnapshots('pr-1', [
      {
        prRef: 'pr-1',
        headSha: 'synthetic-pr-1',
        headRepo: 'demo/repo',
        headBranch: 'agentops/landing-handoff-task',
        checkoutRef: 'refs/pull/1/head',
        labels: ['agentops:managed'],
        state: 'open',
        draft: false,
        mergeable: true,
        mergedHeadSha: null,
        ciStatus: 'green',
        unresolvedThreads: 0,
        comments: [],
      },
    ]);

    const input: TaskInput = {
      taskId: 'landing-handoff-task',
      project: 'demo',
      repo: 'demo/repo',
      issueRef: 'issue-1',
      goal: 'Add a widget',
      config: { ...baseConfig, autoMerge: 'all' },
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

    expect(finalState.landingOutcome).toBe('merged');
    expect(scm.getOperations().some((op) => op.type === 'mergePr')).toBe(true);
  });

  it('standalone prLanding with label mode merges after verify and review', async () => {
    testEnv = await buildTestEnv();
    const { env, worker, stub, scm, taskQueue } = testEnv;

    stub.scriptResponse('full_verify', 1, { output: 'FULL: PASS' });
    stub.scriptResponse('review', 1, { output: 'VERDICT: PASS' });

    scm.scriptSnapshots('demo/repo#8', [
      {
        prRef: 'demo/repo#8',
        headSha: 'abc',
        headRepo: 'demo/repo',
        headBranch: 'feature/x',
        checkoutRef: 'refs/pull/8/head',
        labels: ['automerge'],
        state: 'open',
        draft: false,
        mergeable: true,
        mergedHeadSha: null,
        ciStatus: 'green',
        unresolvedThreads: 0,
        comments: [],
      },
    ]);

    const input: PrLandingInput = {
      taskId: 'landing-standalone',
      project: 'demo',
      repo: 'demo/repo',
      prRef: 'demo/repo#8',
      agentCreated: false,
      headBranch: 'feature/x',
      config: { ...baseConfig, autoMerge: 'label' },
    };

    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(prLanding, {
        taskQueue,
        workflowId: input.taskId,
        args: [input],
      });
      return waitForLandingOutcome(
        handle,
        ['merged', 'merge-ready-manual', 'blocked', 'failed', 'cancelled'],
        30_000,
      );
    });

    expect(result.outcome).toBe('merged');
    expect(scm.getOperations().some((op) => op.type === 'mergePr')).toBe(true);
  });

  it('veto label yields merge-ready-manual without merge', async () => {
    testEnv = await buildTestEnv();
    const { env, worker, stub, scm, taskQueue } = testEnv;

    stub.scriptResponse('full_verify', 1, { output: 'FULL: PASS' });
    stub.scriptResponse('review', 1, { output: 'VERDICT: PASS' });

    scm.scriptSnapshots('demo/repo#9', [
      {
        prRef: 'demo/repo#9',
        headSha: 'abc',
        headRepo: 'demo/repo',
        headBranch: 'feature/x',
        checkoutRef: 'refs/pull/9/head',
        labels: ['automerge', 'automerge:disable'],
        state: 'open',
        draft: false,
        mergeable: true,
        mergedHeadSha: null,
        ciStatus: 'green',
        unresolvedThreads: 0,
        comments: [],
      },
    ]);

    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(prLanding, {
        taskQueue,
        workflowId: 'landing-veto',
        args: [
          {
            taskId: 'landing-veto',
            project: 'demo',
            repo: 'demo/repo',
            prRef: 'demo/repo#9',
            agentCreated: false,
            headBranch: 'feature/x',
            config: { ...baseConfig, autoMerge: 'label' },
          },
        ],
      });
      return waitForLandingOutcome(handle, ['merge-ready-manual'], 30_000);
    });

    expect(result.outcome).toBe('merge-ready-manual');
    expect(scm.getOperations().filter((op) => op.type === 'mergePr')).toHaveLength(0);
  });
});
