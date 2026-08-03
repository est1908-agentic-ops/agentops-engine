import type { Client } from '@temporalio/client';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { configSync } from '@agentops/workflows';

export async function startConfigSync(
  client: Client,
  taskQueue: string,
  project: string,
  repo: string,
): Promise<{ started: boolean }> {
  try {
    await client.workflow.start(configSync, {
      taskQueue,
      workflowId: `configsync:${project}`,
      args: [{ project, repo }],
    });
    return { started: true };
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) {
      return { started: false };
    }
    throw err;
  }
}
