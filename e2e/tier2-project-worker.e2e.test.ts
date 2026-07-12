import { afterEach, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ENGINE_QUEUE } from '@agentops/contracts';
import { createActivities, type ActivityDependencies } from '@agentops/activities';
import { MemoryTrackerPort } from '@agentops/ports';
import { InMemoryStatsStore, InMemoryStageResultStore, MemoryWorkspaceManager, InMemoryFiledFindingStore } from '@agentops/activities';
import { PromptPack } from '@agentops/prompts';
import { StubBackend } from '@agentops/backends';
import { rollbarMonitor } from '../examples/project-worker/agentops/workflows/rollbar-monitor';
import { createEngineWorker } from '@agentops/engine-sdk/worker';

describe('Tier-2 project worker e2e (cross-worker delegation + authz)', () => {
  let env: TestWorkflowEnvironment | undefined;
  let engineWorker: Worker | undefined;
  let projectWorker: Worker | undefined;

  afterEach(async () => {
    try { await engineWorker?.shutdown(); } catch {}
    try { await projectWorker?.shutdown(); } catch {}
    await env?.teardown();
  });

  it('delegates createIssue to engine and files the issue', async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const tracker = new MemoryTrackerPort();
    const stub = new StubBackend();
    const deps: ActivityDependencies = {
      backends: { stub },
      tracker,
      scm: { readFile: async () => null, clone: async () => ({} as any), openPr: async () => ({ prRef: '' }), getPrFeedback: async () => ({} as any), push: async () => {}, getFileContent: async () => '' } as any,
      stats: new InMemoryStatsStore(),
      stageResults: new InMemoryStageResultStore(),
      workspaces: new MemoryWorkspaceManager(),
      prompts: new PromptPack(),
      registry: [{ project: 'acme', repo: 'acme/web', trackerType: 'github' as const, token: 't' }],
      filedFindings: new InMemoryFiledFindingStore(),
    };
    const activities = createActivities(deps);

    engineWorker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue: ENGINE_QUEUE,
      workflowsPath: require.resolve('@agentops/workflows'),
      activities: activities as any,
      interceptors: { workflowModules: [require.resolve('@agentops/workflows/src/project-interceptor')] },
    });

    projectWorker = await createEngineWorker({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue: 'proj-acme',
      workflowsPath: require.resolve('../examples/project-worker/agentops/workflows/rollbar-monitor'),
      activities: {},
    });

    await Promise.all([engineWorker.run(), projectWorker.run()]); // they run until stopped by test

    // To exercise, we use the client to start the rollbar workflow with proper memo (as reconciler would stamp)
    const handle = await env.client.workflow.start(rollbarMonitor, {
      taskQueue: 'proj-acme',
      workflowId: 'agent:acme:mon-demo',
      args: [{ repo: 'acme/web', project: 'acme', findings: [{ title: 'Bug from rollbar', body: 'stack', fingerprint: 'fp1' }] }],
      memo: { project: 'acme' },
    });

    const res = await handle.result();
    expect(res.filed).toBe(1);
    const issues = (tracker as any).issues || [];
    expect(issues.some((i: any) => i.title.includes('Bug from rollbar'))).toBe(true);
  });

  it('rejects cross-project repo action with ProjectAuthorizationError', async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    const tracker = new MemoryTrackerPort();
    const stub = new StubBackend();
    const deps: ActivityDependencies = {
      backends: { stub },
      tracker,
      scm: { readFile: async () => null, clone: async () => ({} as any), openPr: async () => ({ prRef: '' }), getPrFeedback: async () => ({} as any), push: async () => {}, getFileContent: async () => '' } as any,
      stats: new InMemoryStatsStore(),
      stageResults: new InMemoryStageResultStore(),
      workspaces: new MemoryWorkspaceManager(),
      prompts: new PromptPack(),
      registry: [{ project: 'acme', repo: 'acme/web', trackerType: 'github' as const, token: 't' }],
      filedFindings: new InMemoryFiledFindingStore(),
    };
    const activities = createActivities(deps);

    engineWorker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue: ENGINE_QUEUE,
      workflowsPath: require.resolve('@agentops/workflows'),
      activities: activities as any,
      interceptors: { workflowModules: [require.resolve('@agentops/workflows/src/project-interceptor')] },
    });

    projectWorker = await createEngineWorker({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue: 'proj-acme',
      workflowsPath: require.resolve('../examples/project-worker/agentops/workflows/rollbar-monitor'),
      activities: {},
    });

    await Promise.all([engineWorker.run(), projectWorker.run()]);

    const handle = await env.client.workflow.start(rollbarMonitor, {
      taskQueue: 'proj-acme',
      workflowId: 'agent:acme:mon-bad',
      args: [{ repo: 'globex/api', project: 'acme', findings: [{ title: 'x', body: 'y', fingerprint: 'f' }] }],
      memo: { project: 'acme' },
    });

    await expect(handle.result()).rejects.toThrow(/ProjectAuthorizationError|not authorized/);
    // no issue should be created for the cross-repo attempt
    const issues = (tracker as any).issues || [];
    expect(issues.length).toBe(0);
  });
});
