import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { PlatformActivities } from './platform-activities-api';
import { conversationQuery, decisionSignal, platformChat, userTurnSignal } from './platform-chat';

let env: TestWorkflowEnvironment;
beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
});
afterAll(async () => {
  await env?.teardown();
});

// A scripted runAgent that returns one canned CHAT_TURN per call, in order.
function scriptedActivities(outputs: string[]): PlatformActivities {
  let i = 0;
  const child: string[] = [];
  const executed: unknown[] = [];
  return {
    async prepareScratchWorkspace() {
      return { workspaceRef: 'ws-1' };
    },
    async cleanupScratchWorkspace() {},
    async runAgent() {
      const output = outputs[Math.min(i, outputs.length - 1)];
      i += 1;
      return { output, tokensIn: 1, tokensOut: 1, wallMs: 1, resolvedBackend: 'stub', resolvedModel: 'stub' } as never;
    },
    async recordRunStats() {},
    async resolveRepoConfig() {
      return { registered: false } as never;
    },
    async executePlatformAction(req) {
      executed.push(req);
      return { ok: true, detail: `did ${req.type}` };
    },
  } as unknown as PlatformActivities;
}

async function withWorker<T>(activities: PlatformActivities, fn: (taskQueue: string) => Promise<T>): Promise<T> {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: 'test-chat',
    workflowsPath: require.resolve('./index'),
    activities,
  });
  return worker.runUntil(fn('test-chat'));
}

describe('platformChat', () => {
  it('records the seeded prompt, replies, and waits for the operator', async () => {
    const activities = scriptedActivities(['CHAT_TURN: {"message":"Hello, how can I help?"}']);
    await withWorker(activities, async (taskQueue) => {
      const handle = await env.client.workflow.start(platformChat, {
        taskQueue,
        workflowId: 'chat-1',
        args: [{ prompt: 'hi' }],
      });
      await env.sleep('2 seconds');
      const state = await handle.query(conversationQuery);
      expect(state.phase).toBe('awaiting-user');
      expect(state.messages.map((m) => m.role)).toEqual(['user', 'agent']);
      expect(state.messages[1].text).toBe('Hello, how can I help?');
      await handle.signal(userTurnSignal, '/close-test');
      // Second scripted turn marks done to end the run.
      await handle.terminate('test done');
    });
  });

  it('surfaces a proposal, executes it on approve, and skips it on reject', async () => {
    const activities = scriptedActivities([
      'CHAT_TURN: {"message":"Terminate the stuck run?","pending":{"kind":"proposal","proposal":{"type":"terminate","workflowId":"wf-9","reason":"stuck"}}}',
      'CHAT_TURN: {"message":"Done.","done":true}',
    ]);
    await withWorker(activities, async (taskQueue) => {
      const handle = await env.client.workflow.start(platformChat, {
        taskQueue,
        workflowId: 'chat-2',
        args: [{ prompt: 'the run wf-9 is stuck' }],
      });
      await env.sleep('2 seconds');
      let state = await handle.query(conversationQuery);
      expect(state.phase).toBe('awaiting-approval');
      expect(state.pendingProposal?.type).toBe('terminate');
      await handle.signal(decisionSignal, { proposalId: state.pendingProposal!.id, approve: true });
      const result = await handle.result();
      expect(result.actionsExecuted).toHaveLength(1);
      expect(result.actionsExecuted[0].workflowId).toBe('wf-9');
    });
  });

  it('auto-closes after the idle timeout with no input', async () => {
    const activities = scriptedActivities(['CHAT_TURN: {"message":"unused"}']);
    await withWorker(activities, async (taskQueue) => {
      const handle = await env.client.workflow.start(platformChat, {
        taskQueue,
        workflowId: 'chat-3',
        args: [{}], // no seeded prompt -> waits, then times out
      });
      await env.sleep('31 minutes'); // time-skipping fast-forwards the idle timer
      const result = await handle.result();
      expect(result.turns).toBe(0);
    });
  });
});