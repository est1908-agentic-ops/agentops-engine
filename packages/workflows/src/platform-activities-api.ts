import type { AgentRunRequest, AgentRunResult, ProductConfig, RunStats } from '@agentops/contracts';

export interface PlatformActivities {
  runAgent(req: AgentRunRequest): Promise<AgentRunResult>;
  recordRunStats(stats: RunStats): Promise<void>;
  resolveRepoConfig(
    repo: string,
  ): Promise<{ registered: boolean; product: string; config: ProductConfig }>;
  prepareScratchWorkspace(taskId: string): Promise<{ workspaceRef: string }>;
  cleanupScratchWorkspace(workspaceRef: string): Promise<void>;
}
