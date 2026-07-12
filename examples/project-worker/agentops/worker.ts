import { createEngineWorker } from '@agentic-ops/engine-sdk/worker';
import { NativeConnection } from '@temporalio/worker';
// import * as workflows from './workflows/rollbar-monitor'; // register if using path-based


export async function run() {
  const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  const worker = await createEngineWorker({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE,
    taskQueue: process.env.PROJECT_TASK_QUEUE ?? 'proj-acme',
    workflowsPath: require.resolve('./workflows/rollbar-monitor'),
    activities: {
      // project-owned activities would go here (holding project's secrets)
    },
  });
  await worker.run();
}
