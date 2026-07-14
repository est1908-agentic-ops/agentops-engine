import type { Client } from '@temporalio/client';
import { WorkflowExecutionAlreadyStartedError, WorkflowIdReusePolicy } from '@temporalio/client';
import { devCyclePrRepair } from '@agentops/workflows';
import type { DevCyclePrRepairInput, ProjectConfig } from '@agentops/contracts';
import type { PrReviewEvent } from './parse-pr-review-event';

export interface StartDevCyclePrRepairResult {
  taskId: string;
  started: boolean;
}

export async function startDevCyclePrRepair(
  client: Client,
  taskQueue: string,
  project: string,
  reviewEvent: PrReviewEvent,
  config?: ProjectConfig,
): Promise<StartDevCyclePrRepairResult> {
  const taskId = `pr-repair-${reviewEvent.repo.replace('/', '-')}-${reviewEvent.prRef.split('#')[1]}`;
  const workflowId = `devCyclePrRepair-${reviewEvent.prRef.replace('/', '-').replace('#', '-')}`;

  const input: DevCyclePrRepairInput = {
    taskId,
    project,
    repo: reviewEvent.repo,
    prRef: reviewEvent.prRef,
    prReviewFeedback: reviewEvent.reviewBody,
    headBranch: reviewEvent.headBranch,
    config,
  };

  try {
    await client.workflow.start(devCyclePrRepair, {
      taskQueue,
      workflowId,
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
      args: [input],
    });
    return { started: true, taskId };
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) {
      return { started: false, taskId };
    }
    throw err;
  }
}
