import type { BackendRunRequest, AgentRunResult } from '@agentops/contracts';

export interface AgentBackend {
  run(req: BackendRunRequest): Promise<AgentRunResult>;
}
