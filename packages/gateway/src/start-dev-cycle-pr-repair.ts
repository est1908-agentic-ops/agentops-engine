import type { Client } from '@temporalio/client';
import { devCyclePrRepair } from '@agentops/workflows';
import type { DevCyclePrRepairInput } from '@agentops/contracts';

export async function startDevCyclePrRepair(
  client: Client,
  taskQueue: string,
  project: string,
  reviewEvent: { repo: string; prRef: string; reviewBody: string },
  config?: any,
): Promise<{ started: boolean; taskId: string }> {
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
      args: [input],
    });
    return { started: true, taskId };
  } catch (err: any) {
    if (err?.name?.includes('AlreadyStarted') || err?.message?.includes('already exists')) {
      return { started: false, taskId };
    }
    throw err;
  }
}
