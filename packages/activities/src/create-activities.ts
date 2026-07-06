import type { AgentBackend } from '@agentops/backends';
import type { Issue, OpenPrRequest, OpenPrResult, ScmPort, TrackerPort } from '@agentops/ports';
import type { AgentRunRequest, AgentRunResult, PrFeedback, RunStats } from '@agentops/contracts';
import type { PromptPack } from '@agentops/prompts';
import type { StageResultRecord, StageResultStore } from './stage-result-store';
import type { StatsStore } from './stats-store';
import type { PreparedWorkspace, Workspaces } from './workspace/workspace-manager';

export interface ActivityDependencies {
  backends: Record<string, AgentBackend>;
  tracker: TrackerPort;
  scm: ScmPort;
  stats: StatsStore;
  stageResults: StageResultStore;
  workspaces: Workspaces;
  prompts: PromptPack;
}

export function createActivities(deps: ActivityDependencies) {
  return {
    async runAgent(req: AgentRunRequest): Promise<AgentRunResult> {
      const backend = deps.backends[req.backend];
      if (!backend) {
        throw new Error(`createActivities.runAgent: unknown backend "${req.backend}"`);
      }
      const prompt = deps.prompts.render(req.promptRef, req.promptContext);
      return backend.run({
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
      return deps.workspaces.prepare(req.taskId, req.repo);
    },
    async cleanupWorkspace(workspaceRef: string, repo: string): Promise<void> {
      await deps.workspaces.cleanup(workspaceRef, repo);
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
