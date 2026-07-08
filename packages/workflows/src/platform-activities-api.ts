import type { AgentRunRequest, AgentRunResult, ProjectConfig, RunStats } from '@agentops/contracts';

export interface PlatformActivities {
  runAgent(req: AgentRunRequest): Promise<AgentRunResult>;
  recordRunStats(stats: RunStats): Promise<void>;
  resolveRepoConfig(
    repo: string,
  ): Promise<{ registered: boolean; project: string; config: ProjectConfig }>;
  prepareScratchWorkspace(taskId: string): Promise<{ workspaceRef: string }>;
  cleanupScratchWorkspace(workspaceRef: string): Promise<void>;
}
