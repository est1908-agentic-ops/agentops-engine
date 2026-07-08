import type { Client } from '@temporalio/client';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import type { ProjectConfig } from '@agentops/contracts';
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
  project: string,
  event: IssueLabeledEvent,
  config: ProjectConfig,
): Promise<StartDevCycleResult> {
  // Deterministic per-issue workflow id. Temporal's default reuse policy lets
  // a NEW run start under the same id once the previous one has completed
  // (re-labeling after a task finishes correctly starts a fresh attempt) but
  // rejects starting one while the previous run is still open — which is
  // exactly the dedupe behavior a redelivered webhook needs.
  //
  // Keyed by `project`, not `event.repo`: the registry (parseProjectRegistry)
  // already guarantees project names are unique, whereas naively collapsing
  // "owner/repo" into "owner-repo" is lossy and can collide across two
  // distinct registered repos (e.g. "foo-bar/baz" and "foo/bar-baz" both
  // become "foo-bar-baz"), which would silently swallow one project's events.
  const taskId = `issue-${project}-${event.issueNumber}`;
  try {
    await client.workflow.start(devCycle, {
      taskQueue,
      workflowId: taskId,
      args: [
        {
          taskId,
          project,
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
