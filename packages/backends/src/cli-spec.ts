import type { AgentRunResult, BackendRunRequest } from '@agentops/contracts';

export interface CliSpec {
  image: string;
  binary: string;
  buildArgs(req: BackendRunRequest): string[];
  parseOutput(stdout: string, stderr: string, elapsedMs: number): AgentRunResult;
  isAuthError(stderr: string): boolean;
}
