import type { Client } from '@temporalio/client';
import { devCyclePrRepair } from '@agentops/workflows';
import type { DevCyclePrRepairInput } from '@agentops/contracts';
import type { PrReviewEvent } from './parse-pr-review-event';

export async function startDevCyclePrRepair(
  client: Client,
  taskQueue: string,
  project: string,
  reviewEvent: PrReviewEvent,
  config?: unknown,
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
    config: config as any, // config is ProjectConfig | undefined
  };

  try {
    await client.workflow.start(devCyclePrRepair, {
      taskQueue,
      workflowId,
      args: [input],
    });
    return { started: true, taskId };
  } catch (err: unknown) {
    const e = err as { name?: string; message?: string };
    if (e?.name?.includes('AlreadyStarted') || e?.message?.includes('already exists')) {
      return { started: false, taskId };
    }
    throw err;
  }
}
