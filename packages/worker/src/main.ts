import { NativeConnection } from '@temporalio/worker';
import { createActivities, InMemoryStageResultStore, InMemoryStatsStore, MemoryWorkspaceManager } from '@agentops/activities';
import { StubBackend } from '@agentops/backends';
import { MemoryScmPort, MemoryTrackerPort } from '@agentops/ports';
import type { DevCycleActivities } from '@agentops/workflows';
import { createWorker } from './create-worker';

async function main(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });

  const activities: DevCycleActivities = createActivities({
    backends: { stub: new StubBackend() },
    tracker: new MemoryTrackerPort(),
    scm: new MemoryScmPort(),
    stats: new InMemoryStatsStore(),
    stageResults: new InMemoryStageResultStore(),
    workspaces: new MemoryWorkspaceManager(),
  });

  const worker = await createWorker({
    taskQueue: 'agentops-devcycle',
    activities,
    connection,
  });

  console.log('agentops worker started on task queue "agentops-devcycle"');
  await worker.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
