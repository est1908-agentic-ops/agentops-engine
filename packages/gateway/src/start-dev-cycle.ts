import type { Client } from '@temporalio/client';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import type { ProductConfig } from '@agentops/contracts';
import { devCycle } from '@agentops/workflows';
import type { IssueLabeledEvent } from './parse-issue-labeled';

export interface StartDevCycleResult {
  taskId: string;
  // false when a task for this issue was already running — a redelivered or
  // duplicate "labeled" webhook must not spawn a second overlapping DevCycle.
  started: boolean;
}

export async function startDevCycleForIssue(
  client: Client,
  taskQueue: string,
  product: string,
  event: IssueLabeledEvent,
  config: ProductConfig,
): Promise<StartDevCycleResult> {
  // Deterministic per-issue workflow id. Temporal's default reuse policy lets
  // a NEW run start under the same id once the previous one has completed
  // (re-labeling after a task finishes correctly starts a fresh attempt) but
  // rejects starting one while the previous run is still open — which is
  // exactly the dedupe behavior a redelivered webhook needs.
  //
  // Keyed by `product`, not `event.repo`: the registry (parseProjectRegistry)
  // already guarantees product names are unique, whereas naively collapsing
  // "owner/repo" into "owner-repo" is lossy and can collide across two
  // distinct registered repos (e.g. "foo-bar/baz" and "foo/bar-baz" both
  // become "foo-bar-baz"), which would silently swallow one project's events.
  const taskId = `issue-${product}-${event.issueNumber}`;
  try {
    await client.workflow.start(devCycle, {
      taskQueue,
      workflowId: taskId,
      args: [
        {
          taskId,
          product,
          repo: event.repo,
          issueRef: event.issueRef,
          goal: event.title,
          config,
        },
      ],
    });
    return { taskId, started: true };
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) {
      return { taskId, started: false };
    }
    throw err;
  }
}
