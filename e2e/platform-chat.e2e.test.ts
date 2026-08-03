import { afterEach, describe, expect, it } from 'vitest';
import { conversationQuery, decisionSignal, platformChat } from '@agentops/workflows';
import { buildTestEnv, teardownTestEnv, waitForStatus, type TestEnv } from './helpers';

describe('platformChat e2e (stub backend)', () => {
  let testEnv: TestEnv | undefined;

  afterEach(async () => {
    await teardownTestEnv(testEnv);
  });

  it('drives a child devCycle when the operator approves a fix', async () => {
    testEnv = await buildTestEnv({
      registry: [
        {
          project: 'acme',
          repo: 'acme/webapp',
          trackerType: 'github',
          token: 'fake',
        },
      ],
    });
    const { env, worker, stub, scm, taskQueue } = testEnv;

    const stubRoute = { tier: 'stub' };
    scm.seedFile(
      'acme/webapp',
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
        'Found a flaky test.\nCHAT_TURN: {"message":"I can fix the flaky test in acme/webapp. Approve?","pending":{"kind":"proposal","proposal":{"type":"fix","repo":"acme/webapp","goal":"fix the flaky test","reason":"test fails intermittently"}}}',
    });
    stub.scriptResponse(
      'platform',
      1,
      {
        output: 'CHAT_TURN: {"message":"Fix started.","done":true}',
      },
      2,
    );
    stub.scriptResponse('implement', 1, { output: 'diff --git a/x.ts b/x.ts (fix)' });
    stub.scriptResponse('full_verify', 1, { output: 'FULL: PASS' });
    stub.scriptResponse('review', 1, { output: 'VERDICT: PASS' });
    scm.scriptFeedback('pr-1', [{ ciStatus: 'green', unresolvedThreads: 0, comments: [] }]);

    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(platformChat, {
        taskQueue,
        workflowId: 'e2e-chat-1',
        args: [{ prompt: 'fix the flaky test in acme/webapp' }],
      });

      const deadline = Date.now() + 30_000;
      let state = await handle.query(conversationQuery);
      while (state.phase !== 'awaiting-approval' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        state = await handle.query(conversationQuery);
      }
      expect(state.phase).toBe('awaiting-approval');
      expect(state.pendingProposal?.type).toBe('fix');

      await handle.signal(decisionSignal, { proposalId: state.pendingProposal!.id, approve: true });

      const chatResult = await handle.result();
      const childHandle = env.client.workflow.getHandle(chatResult.childWorkflows[0].workflowId);
      await waitForStatus(childHandle as never, ['done', 'blocked', 'failed'], 30_000);

      return chatResult;
    });

    expect(result.childWorkflows).toHaveLength(1);
    expect(result.childWorkflows[0].repo).toBe('acme/webapp');
  });
});
