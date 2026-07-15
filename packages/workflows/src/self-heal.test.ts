import { describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { AgentRunRequest } from '@agentops/contracts';
import type { PlatformActivities } from './platform-activities-api';
import { SELF_HEAL_PROMPT, selfHeal } from './self-heal';

// Stub the activities the child `platform` workflow uses, capturing the prompt
// the child agent was given so we can assert selfHeal handed it SELF_HEAL_PROMPT.
function stubActivities(captured: { prompt?: string }): PlatformActivities {
  return {
    async prepareScratchWorkspace() {
      return { workspaceRef: 'ws-1' };
    },
    async cleanupScratchWorkspace() {},
    async recordRunStats() {},
    async resolveRepoConfig() {
      return { registered: false } as never;
    },
    async executePlatformAction() {
      return { ok: true, detail: 'noop' };
    },
    async runAgent(req: AgentRunRequest) {
      captured.prompt = (req.promptContext as { prompt?: string }).prompt;
      return {
        output:
          'PLATFORM_RESULT: {"summary":"self-heal sweep: nothing actionable","actionsTaken":[],"proposedFixes":[]}',
        tokensIn: 1,
        tokensOut: 1,
        wallMs: 1,
        resolvedBackend: 'stub',
        resolvedModel: 'stub',
      } as never;
    },
  } as unknown as PlatformActivities;
}

describe('selfHeal', () => {
  it('runs a child platform agent with SELF_HEAL_PROMPT and returns its result', async () => {
    const captured: { prompt?: string } = {};
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test-self-heal',
      workflowsPath: require.resolve('@agentops/workflows'),
      activities: stubActivities(captured),
    });
    try {
      const result = await worker.runUntil(
        env.client.workflow.execute(selfHeal, {
          taskQueue: 'test-self-heal',
          workflowId: 'self-heal-1',
        }),
      );
      expect(captured.prompt).toBe(SELF_HEAL_PROMPT);
      expect(result.summary).toContain('nothing actionable');
    } finally {
      await env.teardown();
    }
  });
});
