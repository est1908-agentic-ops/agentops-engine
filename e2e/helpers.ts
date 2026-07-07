import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { WorkflowHandle } from '@temporalio/client';
import {
  createActivities,
  InMemoryStageResultStore,
  InMemoryStatsStore,
  MemoryWorkspaceManager,
} from '@agentops/activities';
import { StubBackend, type AgentBackend } from '@agentops/backends';
import { MemoryScmPort, MemoryTrackerPort } from '@agentops/ports';
import { PromptPack } from '@agentops/prompts';
import type { DevCycleActivities, DevCycleState } from '@agentops/workflows';
import { createWorker } from '@agentops/worker';

export interface TestEnv {
  env: TestWorkflowEnvironment;
  worker: Worker;
  stub: StubBackend;
  tracker: MemoryTrackerPort;
  scm: MemoryScmPort;
  stats: InMemoryStatsStore;
  stageResults: InMemoryStageResultStore;
  workspaces: MemoryWorkspaceManager;
  taskQueue: string;
}

let counter = 0;

export function nextTaskQueue(): string {
  counter += 1;
  return `agentops-devcycle-test-${counter}`;
}

export async function buildTestEnv(extraBackends: Record<string, AgentBackend> = {}): Promise<TestEnv> {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const stub = new StubBackend();
  const tracker = new MemoryTrackerPort();
  const scm = new MemoryScmPort();
  const stats = new InMemoryStatsStore();
  const stageResults = new InMemoryStageResultStore();
  const workspaces = new MemoryWorkspaceManager();

  const activities: DevCycleActivities = createActivities({
    backends: { stub, ...extraBackends },
    tracker,
    scm,
    stats,
    stageResults,
    workspaces,
    prompts: new PromptPack(),
  });

  const taskQueue = nextTaskQueue();
  const worker = await createWorker({
    taskQueue,
    activities,
    connection: env.nativeConnection,
  });

  return { env, worker, stub, tracker, scm, stats, stageResults, workspaces, taskQueue };
}

export async function waitForStatus(
  handle: WorkflowHandle<(input: never) => Promise<DevCycleState>>,
  statuses: DevCycleState['status'][],
  timeoutMs = 30_000,
): Promise<DevCycleState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await handle.query('state');
    if (statuses.includes(state.status)) {
      return state as DevCycleState;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for status in [${statuses.join(', ')}]`);
}
