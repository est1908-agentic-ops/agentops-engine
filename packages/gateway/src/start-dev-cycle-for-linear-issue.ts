import type { Client } from '@temporalio/client';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import type { ProjectConfig } from '@agentops/contracts';
import { linearRef } from '@agentops/ports';
import { devCycle } from '@agentops/workflows';
import type { LinearIssueEvent } from './parse-linear-issue-event';
import { slugifyProject } from './slug';
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
  // Slugify the project part: the taskId becomes a git branch and workspace dir
  // (see slugifyProject / startDevCycleForIssue). The Linear identifier (e.g.
  // "ENG-123") is already branch-safe.
  const taskId = `linear-${slugifyProject(project)}-${event.identifier}`;
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
