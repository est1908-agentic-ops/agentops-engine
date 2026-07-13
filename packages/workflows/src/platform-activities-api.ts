import type {
  AgentRunRequest,
  AgentRunResult,
  ExecutePlatformActionRequest,
  ExecutePlatformActionResult,
  RunStats,
} from '@agentops/contracts';
import type { RepoConfigResolution } from './activities-api';

export interface PlatformActivities {
  runAgent(req: AgentRunRequest): Promise<AgentRunResult>;
  recordRunStats(stats: RunStats): Promise<void>;
  resolveRepoConfig(repo: string): Promise<RepoConfigResolution>;
  prepareScratchWorkspace(taskId: string): Promise<{ workspaceRef: string }>;
  cleanupScratchWorkspace(workspaceRef: string): Promise<void>;
  executePlatformAction(req: ExecutePlatformActionRequest): Promise<ExecutePlatformActionResult>;
}
