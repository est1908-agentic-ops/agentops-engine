import { LiteLlmBudgetExceededError, type AgentBackend } from '@agentops/backends';
import type { Issue, OpenPrRequest, OpenPrResult, ScmPort, TrackerPort } from '@agentops/ports';
import type { AgentRunRequest, AgentRunResult, PrFeedback, RunStats } from '@agentops/contracts';
import type { PromptPack } from '@agentops/prompts';
import type { StageResultRecord, StageResultStore } from './stage-result-store';
import type { StatsStore } from './stats-store';
import { WorkspaceError, type PreparedWorkspace, type Workspaces } from './workspace/workspace-manager';
import { ApplicationFailure } from '@temporalio/common';

export interface ActivityDependencies {
  backends: Record<string, AgentBackend>;
  tracker: TrackerPort;
  scm: ScmPort;
  stats: StatsStore;
  stageResults: StageResultStore;
  workspaces: Workspaces;
  prompts: PromptPack;
}

function rethrowWorkspaceError(err: unknown): never {
  if (err instanceof WorkspaceError && err.nonRetryable) {
    throw ApplicationFailure.nonRetryable(err.message, 'WorkspaceError');
  }
  throw err;
}

export function createActivities(deps: ActivityDependencies) {
  return {
    async runAgent(req: AgentRunRequest): Promise<AgentRunResult> {
      const backend = deps.backends[req.backend];
      if (!backend) {
        throw new Error(`createActivities.runAgent: unknown backend "${req.backend}"`);
      }
      const prompt = deps.prompts.render(req.promptRef, req.promptContext);
      try {
        return await backend.run({
          taskId: req.taskId,
          stage: req.stage,
          attempt: req.attempt,
          callIndex: req.callIndex,
          backend: req.backend,
          model: req.model,
          effort: req.effort,
          workspaceRef: req.workspaceRef,
          limits: req.limits,
          prompt,
        });
      } catch (err) {
        // A LiteLLM virtual-key budget cap is definitive, not transient --
        // same "typed error at the boundary, non-retryable ApplicationFailure
        // here" shape as rethrowWorkspaceError below.
        if (err instanceof LiteLlmBudgetExceededError) {
          throw ApplicationFailure.nonRetryable(err.message, 'LiteLlmBudgetExceededError');
        }
        throw err;
      }
    },
    async getIssue(ref: string): Promise<Issue> {
      return deps.tracker.getIssue(ref);
    },
    async commentOnIssue(ref: string, body: string): Promise<void> {
      await deps.tracker.comment(ref, body);
    },
    async labelIssue(ref: string, label: string): Promise<void> {
      await deps.tracker.label(ref, label);
    },
    async openPr(req: OpenPrRequest): Promise<OpenPrResult> {
      return deps.scm.openPr(req);
    },
    async getPrFeedback(prRef: string): Promise<PrFeedback> {
      return deps.scm.getPrFeedback(prRef);
    },
    async pushBranch(repo: string, workspaceRef: string, branch: string, contentHash: string): Promise<void> {
      await deps.scm.push(repo, workspaceRef, branch, contentHash);
    },
    async recordStageResult(result: StageResultRecord): Promise<void> {
      deps.stageResults.record(result);
    },
    async recordRunStats(stats: RunStats): Promise<void> {
      deps.stats.record(stats);
    },
    async prepareWorkspace(req: { taskId: string; repo: string }): Promise<PreparedWorkspace> {
      try {
        return await deps.workspaces.prepare(req.taskId, req.repo);
      } catch (err) {
        rethrowWorkspaceError(err);
      }
    },
    async cleanupWorkspace(workspaceRef: string, repo: string): Promise<void> {
      try {
        await deps.workspaces.cleanup(workspaceRef, repo);
      } catch (err) {
        rethrowWorkspaceError(err);
      }
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
