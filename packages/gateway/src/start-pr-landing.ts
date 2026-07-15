import type { Client } from '@temporalio/client';
import { WorkflowExecutionAlreadyStartedError, WorkflowIdReusePolicy } from '@temporalio/client';
import type { ProjectConfig } from '@agentops/contracts';
import { prLandingWorkflowId } from '@agentops/policies';
import { prLanding, prLandingWakeSignal } from '@agentops/workflows';
import type { PrLandingEvent } from './parse-pr-landing-event';

export interface StartPrLandingResult {
  started: boolean;
  workflowId: string;
}

export async function startOrSignalPrLanding(
  client: Client,
  taskQueue: string,
  project: string,
  event: PrLandingEvent,
  config: ProjectConfig,
): Promise<StartPrLandingResult> {
  const workflowId = prLandingWorkflowId(event.prRef);

  if (event.kind === 'wake') {
    try {
      await client.workflow.getHandle(workflowId).signal(prLandingWakeSignal);
    } catch {
      // No active execution — acknowledge without reviving a completed run.
    }
    return { started: false, workflowId };
  }

  try {
    await client.workflow.start(prLanding, {
      taskQueue,
      workflowId,
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
      args: [{
        taskId: workflowId,
        project,
        repo: event.repo,
        prRef: event.prRef,
        agentCreated: false,
        headBranch: event.headBranch,
        config,
      }],
    });
    return { started: true, workflowId };
  } catch (err) {
    if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
    await client.workflow.getHandle(workflowId).signal(prLandingWakeSignal);
    return { started: false, workflowId };
  }
}