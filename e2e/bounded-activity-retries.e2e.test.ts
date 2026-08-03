import { afterEach, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import type { TaskInput } from '@agentops/contracts';
import { devCycle } from '@agentops/workflows';
import {
  createActivities,
  InMemoryStageResultStore,
  InMemoryStatsStore,
  WorkspaceError,
  type Workspaces,
} from '@agentops/activities';
import { StubBackend } from '@agentops/backends';
import { MemoryScmPort, MemoryTrackerPort } from '@agentops/ports';
import { PromptPack } from '@agentops/prompts';
import { createWorker } from '@agentops/worker';
import { nextTaskQueue } from './helpers';

// Reproduces the issue-broccoli-94 incident at the workflow level: an activity
// that fails the same way on every attempt must not retry forever just because
// no one told it to stop. This applies to any activity, not just
// prepareWorkspace -- the fix is a bounded retry policy on the activity proxy,
// not special-casing one call site.
describe('DevCycle e2e: bounded activity retries', () => {
  let env: TestWorkflowEnvironment | undefined;
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;

  afterEach(async () => {
    if (worker && worker.getState() !== 'STOPPED') {
      await worker.shutdown();
    }
    await env?.teardown();
    worker = undefined;
    env = undefined;
  });

  it('gives up instead of retrying forever when an activity fails the same way on every attempt', async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const alwaysFailingWorkspaces: Workspaces = {
      prepare: async () => {
        throw new WorkspaceError(
          "git worktree add failed: fatal: a branch named 'agentops/x' already exists",
          false,
        );
      },
      cleanup: async () => {},
      prepareScratch: async () => ({ workspaceRef: 'memory://scratch/x' }),
      cleanupScratch: async () => {},
    };
    const activities = createActivities({
      backends: { stub: new StubBackend() },
      tracker: new MemoryTrackerPort(),
      scm: new MemoryScmPort(),
      stats: new InMemoryStatsStore(),
      stageResults: new InMemoryStageResultStore(),
      workspaces: alwaysFailingWorkspaces,
      prompts: new PromptPack(),
      registry: [],
    });
    const taskQueue = nextTaskQueue();
    worker = await createWorker({ taskQueue, activities, connection: env.nativeConnection });

    const input: TaskInput = {
      taskId: 'stuck-workspace-task',
      project: 'demo',
      repo: 'demo/repo',
      goal: 'Should give up, not retry forever',
      config: {
        fastVerifyCommands: [],
        fullVerifyCommands: [],
        stages: {},
        routing: {},
        brakes: {
          maxImplementAttempts: 3,
          maxIterations: 10,
          maxTokens: 500_000,
          maxBabysitRounds: 5,
        },
      },
    };

    await worker.runUntil(async () => {
      const handle = await env!.client.workflow.start(devCycle, {
        taskQueue,
        workflowId: input.taskId,
        args: [input],
      });

      await expect(handle.result()).rejects.toThrow();
    });
  }, 15_000);
});
