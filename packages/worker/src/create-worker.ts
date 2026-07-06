import { NativeConnection, Worker } from '@temporalio/worker';
import type { DevCycleActivities } from '@agentops/workflows';

export interface CreateWorkerOptions {
  taskQueue: string;
  activities: DevCycleActivities;
  connection?: NativeConnection;
  workflowsPath?: string;
  namespace?: string;
}

export async function createWorker(options: CreateWorkerOptions): Promise<Worker> {
  return Worker.create({
    connection: options.connection,
    namespace: options.namespace,
    taskQueue: options.taskQueue,
    workflowsPath: options.workflowsPath ?? require.resolve('@agentops/workflows'),
    activities: options.activities as unknown as Record<string, (...args: never[]) => Promise<unknown>>,
  });
}
