import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import type { ProjectConfig, TaskInput } from '@agentops/contracts';
import { ENGINE_QUEUE } from '@agentops/contracts';
import {
  createActivities,
  InMemoryFiledFindingStore,
  InMemoryStageResultStore,
  InMemoryStatsStore,
  MemoryWorkspaceManager,
} from '@agentops/activities';
import { StubBackend } from '@agentops/backends';
import { MemoryScmPort, MemoryTrackerPort } from '@agentops/ports';
import { PromptPack } from '@agentops/prompts';
import { handleListAgents, handleTriggerAgent } from '../packages/control/src/agents-routes';
import { startDevCycleForIssue } from '../packages/gateway/src/start-dev-cycle';
import type { IssueLabeledEvent } from '../packages/gateway/src/parse-issue-labeled';
import { configSync, devCycle } from '@agentops/workflows';
import { createWorker } from '@agentops/worker';
import {
  buildTestEnv,
  nextTaskQueue,
  teardownTestEnv,
  waitForStatus,
  type TestEnv,
} from './helpers';

const baseConfig: ProjectConfig = {
  fastVerifyCommands: [],
  fullVerifyCommands: [],
  stages: {},
  routing: {},
  brakes: { maxImplementAttempts: 3, maxIterations: 10, maxTokens: 1_000_000, maxBabysitRounds: 5 },
};

describe('SP3 triggers e2e', () => {
  let testEnv: TestEnv | undefined;

  afterEach(async () => {
    await teardownTestEnv(testEnv);
    testEnv = undefined;
  });

  it('configSync reconcile creates an agent:* schedule; control trigger fires schedule.trigger()', async () => {
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    const created: unknown[] = [];
    const triggered: string[] = [];
    const scm = new MemoryScmPort();
    scm.seedFile(
      'acme/web',
      'agentops.json',
      JSON.stringify({
        agents: [
          {
            name: 'nb',
            workflow: 'whiteboxBugHunt',
            schedule: '0 2 * * *',
            input: {},
            enabled: true,
            timezone: 'UTC',
            overlap: 'skip',
          },
        ],
      }),
    );
    const scheduleClient = {
      create: vi.fn(async (opts: unknown) => {
        created.push(opts);
        return {};
      }),
      getHandle: (id: string) => ({
        update: vi.fn().mockResolvedValue(undefined),
        pause: vi.fn().mockResolvedValue(undefined),
        unpause: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        trigger: vi.fn(async () => {
          triggered.push(id);
        }),
      }),
      list: async function* () {
        // Reconcile starts from an empty schedule list; entries appear after create().
      },
    };
    const activities = createActivities({
      backends: { stub: new StubBackend() },
      tracker: new MemoryTrackerPort(),
      scm,
      stats: new InMemoryStatsStore(),
      stageResults: new InMemoryStageResultStore(),
      workspaces: new MemoryWorkspaceManager(),
      prompts: new PromptPack(),
      registry: [{ project: 'acme', repo: 'acme/web', token: 't', trackerType: 'github' }],
      filedFindings: new InMemoryFiledFindingStore(),
      scheduleClient: scheduleClient as never,
      taskQueue: ENGINE_QUEUE,
    });
    const taskQueue = nextTaskQueue();
    const worker = await createWorker({ taskQueue, activities, connection: env.nativeConnection });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(configSync, {
        taskQueue,
        workflowId: 'configsync:acme-e2e',
        args: [{ project: 'acme', repo: 'acme/web' }],
      });
      await handle.result();
    });
    expect(created).toHaveLength(1);
    expect((created[0] as { scheduleId: string }).scheduleId).toBe('agent:acme:nb');

    const listingClient = {
      list: async function* () {
        yield {
          scheduleId: 'agent:acme:nb',
          memo: { project: 'acme', agentName: 'nb', workflowType: 'whiteboxBugHunt' },
          schedule: { spec: { cron: { cronString: '0 2 * * *' } } },
          info: { paused: false },
        };
      },
      getHandle: scheduleClient.getHandle,
    };
    const listRes = await handleListAgents({
      client: { schedule: listingClient } as never,
      taskQueue: ENGINE_QUEUE,
      namespace: 'default',
      temporalUiBaseUrl: 'https://temporal.example',
    });
    expect((listRes.body as { agents: unknown[] }).agents).toHaveLength(1);

    const triggerRes = await handleTriggerAgent(
      {
        client: { schedule: scheduleClient } as never,
        taskQueue: ENGINE_QUEUE,
        namespace: 'default',
        temporalUiBaseUrl: 'https://temporal.example',
      },
      'agent:acme:nb',
    );
    expect(triggerRes.status).toBe(202);
    expect(triggered).toEqual(['agent:acme:nb']);
    await env.teardown();
  });

  it('issues.opened+agent:fix dedupes devcycle:<project>:<issue> and agent:working is stamped then dropped', async () => {
    testEnv = await buildTestEnv();
    const { env, worker, stub, tracker, scm, taskQueue } = testEnv;
    const issueRef = 'demo/repo#5';

    tracker.seedIssue({ ref: issueRef, title: 'Fix bug', body: 'details', labels: [] });
    const labelSpy = vi.spyOn(tracker, 'label');
    const removeLabelSpy = vi.spyOn(tracker, 'removeLabel');
    stub.scriptResponse('context', 1, { output: 'ctx' });
    stub.scriptResponse('design', 1, { output: 'design' });
    stub.scriptResponse('plan', 1, { output: 'plan' });
    stub.scriptResponse('implement', 1, { output: 'diff' });
    stub.scriptResponse('full_verify', 1, { output: 'FULL: PASS' });
    stub.scriptResponse('review', 1, { output: 'VERDICT: PASS' });
    scm.scriptFeedback('pr-1', [{ ciStatus: 'green', unresolvedThreads: 0, comments: [] }]);

    const input: TaskInput = {
      taskId: 'issue-demo-5',
      project: 'demo',
      repo: 'demo/repo',
      issueRef,
      goal: 'Fix bug',
      config: baseConfig,
    };

    const event: IssueLabeledEvent = {
      repo: 'demo/repo',
      issueRef,
      issueNumber: 5,
      title: 'Fix bug',
    };

    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(devCycle, {
        taskQueue,
        workflowId: 'devcycle:demo:5',
        args: [input],
      });
      const deduped = await startDevCycleForIssue(env.client, taskQueue, 'demo', event, baseConfig);
      expect(deduped.started).toBe(false);
      await waitForStatus(handle, ['done', 'failed', 'blocked'], 30_000);
      await handle.result();
    });

    expect(labelSpy).toHaveBeenCalledWith(issueRef, 'agent:working');
    expect(removeLabelSpy).toHaveBeenCalledWith(issueRef, 'agent:working');
    expect(tracker.getLabels(issueRef)).not.toContain('agent:working');
  });
});
