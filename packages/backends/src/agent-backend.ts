import type { AgentRunRequest, AgentRunResult } from '@agentops/contracts';

export interface AgentBackend {
  run(req: AgentRunRequest): Promise<AgentRunResult>;
}
