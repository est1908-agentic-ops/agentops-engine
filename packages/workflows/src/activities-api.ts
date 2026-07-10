import type { AgentRunRequest, AgentRunResult, PrFeedback, ProjectConfig, RunStats, StageResult } from '@agentops/contracts';

export interface Issue {
  ref: string;
  title: string;
  body: string;
  labels: string[];
}

export interface OpenPrRequest {
  repo: string;
  branch: string;
  title: string;
  body: string;
}

export interface OpenPrResult {
  prRef: string;
  url: string;
}

export interface StageResultRecord extends StageResult {
  taskId: string;
}

// Shared with PlatformActivities -- one declaration for the one activity
// implementation in packages/activities/src/create-activities.ts.
export interface RepoConfigResolution {
  registered: boolean;
  project: string;
  config: ProjectConfig;
}

export interface PreparedWorkspace {
  workspaceRef: string;
  branch: string;
  baseBranch: string;
}

export interface DevCycleActivities {
  runAgent(req: AgentRunRequest): Promise<AgentRunResult>;
  resolveRepoConfig(repo: string): Promise<RepoConfigResolution>;
  getIssue(ref: string): Promise<Issue>;
  commentOnIssue(ref: string, body: string): Promise<void>;
  labelIssue(ref: string, label: string): Promise<void>;
  openPr(req: OpenPrRequest): Promise<OpenPrResult>;
  getPrFeedback(prRef: string): Promise<PrFeedback>;
  pushBranch(repo: string, workspaceRef: string, branch: string, contentHash: string): Promise<void>;
  recordStageResult(result: StageResultRecord): Promise<void>;
  recordRunStats(stats: RunStats): Promise<void>;
  prepareWorkspace(req: { taskId: string; repo: string; initCommands?: string[] }): Promise<PreparedWorkspace>;
  cleanupWorkspace(workspaceRef: string, repo: string): Promise<void>;
}
