import { afterEach, describe, expect, it } from 'vitest';
import type { AgentBackend } from '@agentops/backends';
import type { BackendRunRequest, TaskInput } from '@agentops/contracts';
import { devCycle } from '@agentops/workflows';
import { buildTestEnv, teardownTestEnv, waitForStatus, type TestEnv } from './helpers';

describe('DevCycle e2e: project image and services reach every stage agent call', () => {
  let testEnv: TestEnv | undefined;

  afterEach(async () => {
    await teardownTestEnv(testEnv);
  });

  it('threads config.image and config.services from TaskInput into runAgent for implement/full_verify/review', async () => {
    const captured: BackendRunRequest[] = [];
    const recording: AgentBackend = {
      async run(req) {
        captured.push(req);
        if (req.stage === 'full_verify') return { output: 'FULL: PASS', tokensIn: 1, tokensOut: 1, wallMs: 10 };
        if (req.stage === 'review') return { output: 'VERDICT: PASS', tokensIn: 1, tokensOut: 1, wallMs: 10 };
        return { output: 'diff --git a/widget.ts b/widget.ts', tokensIn: 1, tokensOut: 1, wallMs: 10 };
      },
    };

    testEnv = await buildTestEnv({ extraBackends: { recording } });
    const { env, worker, tracker, scm, taskQueue } = testEnv;

    tracker.seedIssue({ ref: 'issue-1', title: 'Add widget', body: 'Please add a widget', labels: [] });
    scm.scriptFeedback('pr-1', [{ ciStatus: 'green', unresolvedThreads: 0, comments: [] }]);

    const recordingTier = [{ backend: 'recording', model: 'recording-v1' }];
    const input: TaskInput = {
      taskId: 'image-services-task',
      project: 'demo',
      repo: 'demo/repo',
      issueRef: 'issue-1',
      goal: 'Add a widget',
      config: {
        image: 'ghcr.io/example/agentops:latest',
        services: [{ name: 'redis', image: 'redis:7-alpine', readiness: { type: 'tcpSocket', port: 6379 } }],
        fastVerifyCommands: [],
        fullVerifyCommands: [],
        stages: {},
        tiers: { recording: recordingTier },
        routing: {
          implement: { tier: 'recording' },
          full_verify: { tier: 'recording' },
          review: { tier: 'recording' },
        },
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
    expect(captured.length).toBeGreaterThanOrEqual(2);
    for (const req of captured) {
      expect(req.image).toBe('ghcr.io/example/agentops:latest');
      expect(req.services).toEqual([
        { name: 'redis', image: 'redis:7-alpine', readiness: { type: 'tcpSocket', port: 6379 } },
      ]);
    }
  });
});
