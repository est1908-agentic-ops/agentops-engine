import { describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { PlatformActivities } from './platform-activities-api';
import { platform } from './platform';

let taskQueueCounter = 0;

async function withTestEnv<T>(
  activities: PlatformActivities,
  fn: (ctx: { env: TestWorkflowEnvironment; taskQueue: string }) => Promise<T>,
): Promise<T> {
  taskQueueCounter += 1;
  const taskQueue = `test-platform-${taskQueueCounter}`;
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

describe('platform', () => {
  it('surfaces the original runAgent error even when cleanup throws (regression for masking bug)', async () => {
    const activities: PlatformActivities = {
      async prepareScratchWorkspace() {
        return { workspaceRef: 'ws-1' };
      },
      async runAgent() {
        throw new Error('AGENT_BOOM');
      },
      async recordRunStats() {},
      async resolveRepoConfig() {
        return { registered: false } as never;
      },
      async cleanupScratchWorkspace() {
        throw new Error('CLEANUP_BOOM');
      },
    } as unknown as PlatformActivities;

    await withTestEnv(activities, async ({ env, taskQueue }) => {
      const handle = await env.client.workflow.start(platform, {
        taskQueue,
        workflowId: 'platform-cleanup-masking-test',
        args: [{ prompt: 'test' }],
      });
      // The test fails if it throws CLEANUP_BOOM (the old masking bug);
      // it passes if it throws AGENT_BOOM (the original error we want to surface).
      try {
        await handle.result();
        expect.fail('Expected workflow to reject');
      } catch (err) {
        const fullStr = JSON.stringify(err);
        // The key check: which activity error is the top-level failure?
        // With the bug, "cleanupScratchWorkspace" is the activityType of the top error
        // After the fix, "runAgent" should be the activityType
        const hasCleanupActivityError = fullStr.includes('"activityType":"cleanupScratchWorkspace"');
        const hasRunAgentActivityError = fullStr.includes('"activityType":"runAgent"');
        if (hasCleanupActivityError) {
          // This is the buggy behavior - cleanup masked the agent error
          const error = new Error('BUG: Cleanup error is masking agent error');
          error.cause = err;
          throw error;
        }
        expect(hasRunAgentActivityError).toBe(true);
      }
    });
  }, 30_000);

  it('surfaces cleanup error when runAgent succeeds but cleanup throws', async () => {
    const activities: PlatformActivities = {
      async prepareScratchWorkspace() {
        return { workspaceRef: 'ws-1' };
      },
      async runAgent() {
        return {
          output:
            'PLATFORM_RESULT: {"summary":"ok","actionsTaken":[],"proposedFixes":[]}',
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
      async cleanupScratchWorkspace() {
        throw new Error('CLEANUP_BOOM');
      },
    } as unknown as PlatformActivities;

    await withTestEnv(activities, async ({ env, taskQueue }) => {
      const handle = await env.client.workflow.start(platform, {
        taskQueue,
        workflowId: 'platform-cleanup-surfaces-on-success',
        args: [{ prompt: 'test' }],
      });
      try {
        await handle.result();
        expect.fail('Expected workflow to reject');
      } catch (err) {
        const fullStr = JSON.stringify(err);
        // When runAgent succeeds but cleanup fails, the cleanup error should be the final failure
        const hasCleanupActivityError = fullStr.includes('"activityType":"cleanupScratchWorkspace"');
        expect(hasCleanupActivityError).toBe(true);
        expect(fullStr).toContain('CLEANUP_BOOM');
      }
    });
  }, 30_000);

  it('returns the parsed result on successful run with successful cleanup', async () => {
    const activities: PlatformActivities = {
      async prepareScratchWorkspace() {
        return { workspaceRef: 'ws-1' };
      },
      async runAgent() {
        return {
          output:
            'PLATFORM_RESULT: {"summary":"checked and found nothing","actionsTaken":[],"proposedFixes":[]}',
          tokensIn: 100,
          tokensOut: 50,
          wallMs: 5000,
          resolvedBackend: 'claude',
          resolvedModel: 'claude-opus',
        } as never;
      },
      async recordRunStats() {},
      async resolveRepoConfig() {
        return { registered: false } as never;
      },
      async cleanupScratchWorkspace() {},
    } as unknown as PlatformActivities;

    await withTestEnv(activities, async ({ env, taskQueue }) => {
      const handle = await env.client.workflow.start(platform, {
        taskQueue,
        workflowId: 'platform-happy-path',
        args: [{ prompt: 'test' }],
      });
      const result = await handle.result();
      expect(result.summary).toBe('checked and found nothing');
      expect(result.actionsTaken).toEqual([]);
      expect(result.childWorkflows).toEqual([]);
    });
  }, 30_000);
});
