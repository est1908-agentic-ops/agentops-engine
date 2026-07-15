import { describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { defineSignal, defineQuery } from '@temporalio/workflow';
import type { DevCyclePrRepairInput, PrFeedback, ProjectConfig, AgentRunResult, DevCycleState } from '@agentops/contracts';
import type { DevCycleActivities } from './activities-api';
import { devCyclePrRepair } from './dev-cycle-pr-repair';

// Redefine signals for testing - the workflow also defines these
const stopSignal = defineSignal('stop');
// cancelSignal defined by workflow, not used directly in tests
const resumeSignal = defineSignal('resume');
const stateQuery = defineQuery<DevCycleState>('state');

// Increase test timeout for Temporal workflows
const TEST_TIMEOUT_MS = 60000; // 60 seconds

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createStubActivities(options: {
  getPrFeedbackSequence?: PrFeedback[];
  trackCleanup?: { called: boolean };
  trackImplement?: { callCount: number };
}): DevCycleActivities {
  let feedbackIndex = 0;

  return {
    async runAgent(): Promise<AgentRunResult & { promptHash: string; promptSource: string }> {
      options.trackImplement!.callCount += 1;
      return {
        output: 'FULL: PASS',
        tokensIn: 1,
        tokensOut: 1,
        wallMs: 1,
        resolvedBackend: 'stub',
        resolvedModel: 'stub',
        promptHash: 'h',
        promptSource: 's',
      };
    },
    async resolveRepoConfig(): Promise<{ registered: boolean; project: string; config: ProjectConfig }> {
      return {
        registered: true,
        project: 'test',
        config: {
          brakes: { maxBabysitRounds: 10, maxImplementAttempts: 5, maxIterations: 20, maxTokens: 100000 },
          initCommands: [],
          stages: {},
          tiers: {},
          routing: {},
          fastVerifyCommands: [],
          fullVerifyCommands: [],
          services: [],
          image: '',
        } as ProjectConfig,
      };
    },
    async prepareWorkspace() {
      return { workspaceRef: 'ws-1', branch: 'feature-branch', baseBranch: 'main' };
    },
    async pushBranch() {},
    async recordRunStats() {},
    async recordStageResult() {},
    async cleanupWorkspace() {
      options.trackCleanup!.called = true;
    },
    async getPrFeedback(): Promise<PrFeedback> {
      if (!options.getPrFeedbackSequence || feedbackIndex >= options.getPrFeedbackSequence.length) {
        return { ciStatus: 'pending', unresolvedThreads: 0, comments: [] };
      }
      return options.getPrFeedbackSequence[feedbackIndex++];
    },
    async readWorkspaceFile() {
      return null;
    },
    async openPr() {
      return { prRef: 'o/r#1', url: 'http://pr' };
    },
    async getIssue() {
      return { ref: 'o/r#1', title: 'test', body: '', labels: [] };
    },
    async labelIssue() {},
    async unlabelIssue() {},
    async commentOnIssue() {},
    async createIssue() {
      return { ref: 'o/r#2', url: 'http://issue', deduped: false };
    },
  } as unknown as DevCycleActivities;
}

const baseInput: DevCyclePrRepairInput = {
  taskId: 'task-1',
  repo: 'owner/repo',
  project: 'test',
  prRef: 'o/r#1',
  headBranch: 'main',
  config: {
    brakes: { maxBabysitRounds: 10, maxImplementAttempts: 5, maxIterations: 20, maxTokens: 100000 },
    initCommands: [],
    stages: {},
    tiers: {},
    routing: {},
    fastVerifyCommands: [],
    fullVerifyCommands: [],
    services: [],
    image: '',
  } as ProjectConfig,
};

describe('devCyclePrRepair', () => {
  describe('braked verdict handling', () => {
    it('blocks on unreadable ciStatus and is resumable', async () => {
      const cleanup = { called: false };
      const implement = { callCount: 0 };
      const feedbackSequence: PrFeedback[] = [
        // Initial PR feedback
        { ciStatus: 'unreadable', unresolvedThreads: 0, comments: [] },
        // After resume (should switch to green to unblock)
        { ciStatus: 'green', unresolvedThreads: 0, comments: [] },
      ];

      const env = await TestWorkflowEnvironment.createTimeSkipping();
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: 'test-pr-repair',
        workflowsPath: require.resolve('@agentops/workflows'),
        activities: createStubActivities({ getPrFeedbackSequence: feedbackSequence, trackCleanup: cleanup, trackImplement: implement }),
      });

      try {
        const promise = env.client.workflow.execute(devCyclePrRepair, {
          args: [baseInput],
          taskQueue: 'test-pr-repair',
          workflowId: 'repair-unreadable-test',
        });

        // Poll for the blocked state
        let blocked = false;
        for (let i = 0; i < 100; i++) {
          const state = await env.client.workflow.getHandle('repair-unreadable-test').query(stateQuery);
          if (state.status === 'blocked' && state.blockReason === 'babysit-brake') {
            blocked = true;
            break;
          }
          // eslint-disable-next-line no-restricted-globals
          await new Promise(r => setTimeout(r, 10));
        }
        expect(blocked).toBe(true);

        // Send resume signal
        await env.client.workflow.getHandle('repair-unreadable-test').signal(resumeSignal);

        // Wait for completion
        const result = await worker.runUntil(promise);

        expect(result.status).toBe('done');
        expect(result.blockReason).toBeNull();
        expect(cleanup.called).toBe(true);
      } finally {
        await env.teardown();
      }
    }, TEST_TIMEOUT_MS);

    it('pauses to pending status on stop signal and preserves workspace', async () => {
      const cleanup = { called: false };
      const implement = { callCount: 0 };
      // Serve endless waiting feedback so babysit loop keeps polling
      const feedbackSequence: PrFeedback[] = [
        { ciStatus: 'pending', unresolvedThreads: 0, comments: [] },
        { ciStatus: 'pending', unresolvedThreads: 0, comments: [] },
        { ciStatus: 'pending', unresolvedThreads: 0, comments: [] },
      ];

      const env = await TestWorkflowEnvironment.createTimeSkipping();
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: 'test-pr-repair-stop',
        workflowsPath: require.resolve('@agentops/workflows'),
        activities: createStubActivities({ getPrFeedbackSequence: feedbackSequence, trackCleanup: cleanup, trackImplement: implement }),
      });

      try {
        const promise = env.client.workflow.execute(devCyclePrRepair, {
          args: [baseInput],
          taskQueue: 'test-pr-repair-stop',
          workflowId: 'repair-stop-test',
        });

        // Give the workflow time to enter the babysit loop and poll once
        // eslint-disable-next-line no-restricted-globals
        await new Promise(r => setTimeout(r, 100));

        // Send stop signal
        await env.client.workflow.getHandle('repair-stop-test').signal(stopSignal);

        // Wait for completion
        const result = await worker.runUntil(promise);

        expect(result.status).toBe('pending');
        // Workspace should NOT be cleaned up on stop (pause, not terminate)
        expect(cleanup.called).toBe(false);
      } finally {
        await env.teardown();
      }
    }, TEST_TIMEOUT_MS);
  });
});
