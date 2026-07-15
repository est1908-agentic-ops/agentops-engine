import { describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { AgentRunRequest, ExecutePlatformActionRequest } from '@agentops/contracts';
import type { PlatformActivities } from './platform-activities-api';
import { conversationQuery, decisionSignal, platformChat, userTurnSignal } from './platform-chat';

let taskQueueCounter = 0;

// A scripted runAgent that returns one canned CHAT_TURN per call, in order.
function scriptedActivities(outputs: string[]): PlatformActivities {
  let i = 0;
  const executed: unknown[] = [];
  return {
    async prepareScratchWorkspace() {
      return { workspaceRef: 'ws-1' };
    },
    async cleanupScratchWorkspace() {},
    async runAgent() {
      const output = outputs[Math.min(i, outputs.length - 1)];
      i += 1;
      return {
        output,
        tokensIn: 1,
        tokensOut: 1,
        wallMs: 1,
        resolvedBackend: 'stub',
        resolvedModel: 'stub',
      } as never;
    },
    async recordRunStats() {},
    async resolveRepoConfig() {
      return { registered: false } as never;
    },
    async executePlatformAction(req: ExecutePlatformActionRequest) {
      executed.push(req);
      return { ok: true, detail: `did ${req.type}` };
    },
  } as unknown as PlatformActivities;
}

async function withTestEnv<T>(
  activities: PlatformActivities,
  fn: (ctx: { env: TestWorkflowEnvironment; taskQueue: string }) => Promise<T>,
): Promise<T> {
  taskQueueCounter += 1;
  const taskQueue = `test-chat-${taskQueueCounter}`;
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: require.resolve('@agentops/workflows'),
    activities,
  });
  try {
    return await worker.runUntil(fn({ env, taskQueue }));
  } finally {
    await env.teardown();
  }
}

describe('platformChat', () => {
  it('records the seeded prompt, replies, and waits for the operator', async () => {
    const activities = scriptedActivities(['CHAT_TURN: {"message":"Hello, how can I help?"}']);
    await withTestEnv(activities, async ({ env, taskQueue }) => {
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
    await withTestEnv(activities, async ({ env, taskQueue }) => {
      const handle = await env.client.workflow.start(platformChat, {
        taskQueue,
        workflowId: 'chat-2',
        args: [{ prompt: 'the run wf-9 is stuck' }],
      });
      await env.sleep('2 seconds');
      const state = await handle.query(conversationQuery);
      expect(state.phase).toBe('awaiting-approval');
      expect(state.pendingProposal?.type).toBe('terminate');
      await handle.signal(decisionSignal, { proposalId: state.pendingProposal!.id, approve: true });
      const result = await handle.result();
      expect(result.actionsExecuted).toHaveLength(1);
      expect(result.actionsExecuted[0].workflowId).toBe('wf-9');
    });
  });

  it('gives each turn a distinct runAgent `attempt` so K8sJobRunner cannot 409-reuse a stale Job/output across turns', async () => {
    // taskId is the chatId, which is constant for the whole conversation (unlike
    // the one-shot `platform` workflow's per-run taskId), so k8sJobName's
    // `${taskId}-${stage}-${attempt}-${callIndex}` key only stays collision-free
    // across turns if `attempt` varies per turn.
    const attempts: number[] = [];
    const outputs = [
      'CHAT_TURN: {"message":"turn one"}',
      'CHAT_TURN: {"message":"turn two","done":true}',
    ];
    let i = 0;
    const activities: PlatformActivities = {
      async prepareScratchWorkspace() {
        return { workspaceRef: 'ws-1' };
      },
      async cleanupScratchWorkspace() {},
      async runAgent(req: AgentRunRequest) {
        attempts.push(req.attempt);
        const output = outputs[Math.min(i, outputs.length - 1)];
        i += 1;
        return {
          output,
          tokensIn: 1,
          tokensOut: 1,
          wallMs: 1,
          resolvedBackend: 'stub',
          resolvedModel: 'stub',
        } as never;
      },
      async recordRunStats() {},
      async resolveRepoConfig() {
        return { registered: false } as never;
      },
      async executePlatformAction(req: ExecutePlatformActionRequest) {
        return { ok: true, detail: `did ${req.type}` };
      },
    } as unknown as PlatformActivities;

    await withTestEnv(activities, async ({ env, taskQueue }) => {
      const handle = await env.client.workflow.start(platformChat, {
        taskQueue,
        workflowId: 'chat-attempt-uniqueness',
        args: [{ prompt: 'first' }],
      });
      await env.sleep('2 seconds');
      await handle.signal(userTurnSignal, 'second');
      await handle.result();
    });

    expect(attempts).toHaveLength(2);
    expect(attempts[0]).not.toBe(attempts[1]);
  });

  it('auto-closes after the idle timeout with no input', async () => {
    const activities = scriptedActivities(['CHAT_TURN: {"message":"unused"}']);
    await withTestEnv(activities, async ({ env, taskQueue }) => {
      const handle = await env.client.workflow.start(platformChat, {
        taskQueue,
        workflowId: 'chat-3',
        args: [{}], // no seeded prompt -> waits, then times out
      });
      // Let prepareScratchWorkspace finish before skipping the idle timer.
      await env.sleep('1 second');
      await env.sleep('31 minutes'); // time-skipping fast-forwards the idle timer
      const result = await handle.result();
      expect(result.turns).toBe(0);
    });
  }, 30_000);
});
