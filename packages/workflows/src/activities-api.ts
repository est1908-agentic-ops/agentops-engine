import type {
  AgentRunRequest,
  AgentRunResult,
  MergePrRequest,
  MergePrResult,
  PrFeedback,
  PrSnapshot,
  ProjectConfig,
  RunStats,
  StageResult,
} from '@agentops/contracts';
import type { AgentSpec, AgentsManifest } from '@agentops/contracts';
import type { ExistingSchedule, ReconcilePlan } from '@agentops/policies';

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
  labels?: string[];
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
  runAgent(
    req: AgentRunRequest,
  ): Promise<AgentRunResult & { promptHash: string; promptSource: string }>;
  resolveRepoConfig(repo: string): Promise<RepoConfigResolution>;
  getIssue(ref: string): Promise<Issue>;
  commentOnIssue(ref: string, body: string): Promise<void>;
  labelIssue(ref: string, label: string): Promise<void>;
  unlabelIssue(ref: string, label: string): Promise<void>;
  openPr(req: OpenPrRequest): Promise<OpenPrResult>;
  getPrFeedback(prRef: string): Promise<PrFeedback>;
  getPrSnapshot(prRef: string): Promise<PrSnapshot>;
  mergePr(req: MergePrRequest): Promise<MergePrResult>;
  pushBranch(
    repo: string,
    workspaceRef: string,
    branch: string,
    contentHash: string,
  ): Promise<void>;
  recordStageResult(result: StageResultRecord): Promise<void>;
  recordRunStats(stats: RunStats): Promise<void>;
  prepareWorkspace(req: {
    taskId: string;
    repo: string;
    initCommands?: string[];
    headBranch?: string;
    headRef?: string;
  }): Promise<PreparedWorkspace>;
  cleanupWorkspace(workspaceRef: string, repo: string): Promise<void>;
  readWorkspaceFile(workspaceRef: string, relativePath: string): Promise<string | null>;
  createIssue(req: {
    repo: string;
    project: string;
    title: string;
    body: string;
    labels: string[];
    dedupeFingerprint?: string;
  }): Promise<{ ref: string; url: string; deduped: boolean }>;
}

export interface ConfigSyncActivities {
  listManagedProjects(): Promise<Array<{ project: string; repo: string }>>;
  loadAgentsManifest(project: string, repo: string): Promise<AgentsManifest>;
  listAgentSchedules(project: string): Promise<ExistingSchedule[]>;
  applyScheduleChanges(project: string, repo: string, plan: ReconcilePlan): Promise<void>;
  // Delete `agent:*` schedules whose project is no longer in `liveProjects`
  // (a removed project's leftovers). Returns the ids deleted.
  pruneOrphanAgentSchedules(liveProjects: string[]): Promise<{ deleted: string[] }>;
  // Remove base clones + worktrees on the shared PVCs for repos no longer in
  // `liveRepos` (a removed project's leftover source). Returns the paths removed.
  pruneOrphanWorkspaces(liveRepos: string[]): Promise<{ removed: string[] }>;
  listContinuousAgents(project: string): Promise<string[]>;
  startContinuousAgent(project: string, repo: string, spec: AgentSpec): Promise<void>;
  terminateContinuousAgent(id: string): Promise<void>;
}
