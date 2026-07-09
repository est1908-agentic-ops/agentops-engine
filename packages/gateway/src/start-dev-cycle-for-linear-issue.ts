import type { Client } from '@temporalio/client';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import type { ProjectConfig } from '@agentops/contracts';
import { linearRef } from '@agentops/ports';
import { devCycle } from '@agentops/workflows';
import type { LinearIssueEvent } from './parse-linear-issue-event';
import type { StartDevCycleResult } from './start-dev-cycle';

// Parallel to startDevCycleForIssue rather than a shared/generalized
// function -- see the Linear trigger design doc's non-goals. The `linear-`
// workflow-id prefix (vs. the GitHub path's `issue-`) keeps the two dedupe
// spaces from ever colliding even if a project were somehow double-registered
// under both trackers.
export async function startDevCycleForLinearIssue(
  client: Client,
  taskQueue: string,
  project: string,
  event: LinearIssueEvent,
  repo: string,
  config: ProjectConfig,
): Promise<StartDevCycleResult> {
  const taskId = `linear-${project}-${event.identifier}`;
  try {
    await client.workflow.start(devCycle, {
      taskQueue,
      workflowId: taskId,
      args: [
        {
          taskId,
          project,
          repo,
          issueRef: linearRef(event.identifier),
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
