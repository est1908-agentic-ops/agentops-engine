import { afterEach, describe, expect, it } from 'vitest';
import type { PlatformAgentInput } from '@agentops/contracts';
import { platform } from '@agentops/workflows';
import { buildTestEnv, waitForStatus, type TestEnv } from './helpers';

describe('platform e2e', () => {
  let testEnv: TestEnv | undefined;

  afterEach(async () => {
    await testEnv?.env.teardown();
  });

  it('answers a pure question with no proposed fixes and starts no child workflow', async () => {
    testEnv = await buildTestEnv();
    const { env, worker, stub, taskQueue } = testEnv;

    stub.scriptResponse('platform', 1, {
      output:
        'Nothing looks wrong.\nPLATFORM_RESULT: {"summary": "all quiet", "actionsTaken": [], "proposedFixes": []}',
    });

    const input: PlatformAgentInput = {
      prompt: 'check the last workflow failures, do you see anything strange?',
    };

    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(platform, {
        taskQueue,
        workflowId: 'platform-quiet',
        args: [input],
      });
      return handle.result();
    });

    expect(result.summary).toBe('all quiet');
    expect(result.actionsTaken).toEqual([]);
    expect(result.childWorkflows).toEqual([]);
  });

  it('starts a child devCycle for a proposed fix and it runs to done', async () => {
    testEnv = await buildTestEnv({
      registry: [
        {
          product: 'engine',
          repo: 'demo/repo',
          trackerType: 'github',
          tokenEnvVar: 'X',
          token: 'fake',
        },
      ],
    });
    const { env, worker, stub, scm, taskQueue } = testEnv;

    const stubRoute = { backend: 'stub', model: 'stub-v1' };
    scm.seedFile(
      'demo/repo',
      'agentops.json',
      JSON.stringify({
        fastVerifyCommands: [],
        fullVerifyCommands: [],
        routing: {
          context: stubRoute,
          assess: stubRoute,
          design: stubRoute,
          plan: stubRoute,
          implement: stubRoute,
          full_verify: stubRoute,
          review: stubRoute,
        },
      }),
    );

    stub.scriptResponse('platform', 1, {
      output:
        'Found a retry-policy bug.\nPLATFORM_RESULT: {"summary": "found one bug", "actionsTaken": [], "proposedFixes": [{"repo": "demo/repo", "goal": "bound retries"}]}',
    });
    stub.scriptResponse('implement', 1, { output: 'diff --git a/x.ts b/x.ts (fix)' });
    stub.scriptResponse('full_verify', 1, { output: 'FULL: PASS' });
    stub.scriptResponse('review', 1, { output: 'VERDICT: PASS' });
    scm.scriptFeedback('pr-1', [{ ciStatus: 'green', unresolvedThreads: 0, comments: [] }]);

    const input: PlatformAgentInput = {
      prompt: 'investigate the last workflow failures and fix them',
    };

    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(platform, {
        taskQueue,
        workflowId: 'platform-fix',
        args: [input],
      });
      const platformResult = await handle.result();

      const childHandle = env.client.workflow.getHandle(
        platformResult.childWorkflows[0].workflowId,
      );
      await waitForStatus(childHandle as never, ['done', 'blocked', 'failed'], 30_000);

      return platformResult;
    });

    expect(result.summary).toBe('found one bug');
    expect(result.childWorkflows).toHaveLength(1);
    expect(result.childWorkflows[0].repo).toBe('demo/repo');
    const childState = await env.client.workflow
      .getHandle(result.childWorkflows[0].workflowId)
      .result();
    expect(childState.status).toBe('done');
    expect(scm.getOpenedPrs()).toHaveLength(1);
  });

  it('skips a proposed fix for an unregistered repo instead of failing the whole run', async () => {
    testEnv = await buildTestEnv();
    const { env, worker, stub, taskQueue } = testEnv;

    stub.scriptResponse('platform', 1, {
      output:
        'Found a rate-limit bug in the engine itself.\nPLATFORM_RESULT: {"summary": "found one bug", "actionsTaken": [], "proposedFixes": [{"repo": "agentic-ops/agent-runner", "goal": "add retry backoff"}]}',
    });

    const input: PlatformAgentInput = {
      prompt: 'check the last workflow failures, do you see anything strange?',
    };

    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(platform, {
        taskQueue,
        workflowId: 'platform-unregistered-repo',
        args: [input],
      });
      return handle.result();
    });

    expect(result.summary).toBe('found one bug');
    expect(result.childWorkflows).toEqual([]);
    expect(result.skippedFixes).toEqual([
      {
        repo: 'agentic-ops/agent-runner',
        goal: 'add retry backoff',
        reason: expect.stringContaining('agentic-ops/agent-runner'),
      },
    ]);
  });

  it('retries once on unparseable output before giving up', async () => {
    testEnv = await buildTestEnv();
    const { env, worker, stub, taskQueue } = testEnv;

    stub.scriptResponse('platform', 1, { output: 'no sentinel in this one' }, 1);
    stub.scriptResponse('platform', 1, { output: 'still no sentinel' }, 2);

    const input: PlatformAgentInput = { prompt: 'anything strange?' };

    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(platform, {
        taskQueue,
        workflowId: 'platform-unparseable',
        args: [input],
      });
      return handle.result();
    });

    expect(result.summary).toContain('unparseable');
    expect(result.childWorkflows).toEqual([]);
  });
});
