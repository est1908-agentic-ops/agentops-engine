import type { AgentRunRequest, AgentRunResult, Stage } from '@agentops/contracts';
import type { AgentBackend } from '../agent-backend';

export interface ScriptedResponse {
  output: string;
  tokensIn?: number;
  tokensOut?: number;
  wallMs?: number;
}

const DEFAULT_RESPONSE: Required<ScriptedResponse> = {
  output: '',
  tokensIn: 10,
  tokensOut: 10,
  wallMs: 100,
};

export class StubBackend implements AgentBackend {
  private readonly script = new Map<string, ScriptedResponse>();

  scriptResponse(stage: Stage, attempt: number, response: ScriptedResponse, callIndex = 1): void {
    this.script.set(this.key(stage, attempt, callIndex), response);
  }

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    const scripted = this.script.get(this.key(req.stage, req.attempt, req.callIndex));
    return { ...DEFAULT_RESPONSE, ...scripted };
  }

  private key(stage: Stage, attempt: number, callIndex: number): string {
    return `${stage}#${attempt}.${callIndex}`;
  }
}
