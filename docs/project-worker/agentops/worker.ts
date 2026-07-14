import { createEngineWorker } from '@agentic-ops/engine-sdk/worker';
import { NativeConnection } from '@temporalio/worker';
import * as rollbarFetch from './activities/rollbar-fetch';

export async function run(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });

  const worker = await createEngineWorker({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE,
    // Helm chart sets PROJECT_TASK_QUEUE; local dev defaults match proj-acme.
    taskQueue: process.env.PROJECT_TASK_QUEUE ?? 'proj-acme',
    workflowsPath: require.resolve('./workflows/rollbar-monitor'),
    activities: {
      rollbarFetch: rollbarFetch.rollbarFetch,
    },
  });

  await worker.run();
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
