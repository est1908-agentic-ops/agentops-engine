import type { AgentRunResult, BackendRunRequest } from '@agentops/contracts';
import {
  ProcessCliBackend,
  ProcessCliAuthError,
  ProcessCliProcessError,
  ProcessCliTimeoutError,
  type ProcessCliBackendOptions,
} from '../process-cli-backend';

export { ProcessCliProcessError as ClaudeBackendProcessError };
export { ProcessCliTimeoutError as ClaudeBackendTimeoutError };
export { ProcessCliAuthError as ClaudeBackendAuthError };

export interface ClaudeBackendOptions {
  executablePath?: string;
  spawn?: ProcessCliBackendOptions['spawn'];
  env?: NodeJS.ProcessEnv;
  maxTurns?: number;
  killGraceMs?: number;
}

interface ClaudeJsonResult {
  is_error?: boolean;
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  duration_ms?: number;
}

const AUTH_ERROR_PATTERN = /(invalid|expired).{0,30}(api key|token)/i;

export class ClaudeBackend extends ProcessCliBackend {
  private readonly maxTurns: number;

  constructor(opts: ClaudeBackendOptions = {}) {
    super({
      executablePath: opts.executablePath ?? 'claude',
      spawn: opts.spawn,
      env: opts.env,
      killGraceMs: opts.killGraceMs,
    });
    this.maxTurns = opts.maxTurns ?? 30;
  }

  protected buildArgs(req: BackendRunRequest): string[] {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--model',
      req.model,
      '--max-turns',
      String(this.maxTurns),
      '--dangerously-skip-permissions',
    ];
    if (req.effort) {
      args.push('--effort', req.effort);
    }
    return args;
  }

  protected parseOutput(stdout: string, stderr: string, elapsedMs: number): AgentRunResult {
    let parsed: ClaudeJsonResult | undefined;
    try {
      parsed = JSON.parse(stdout) as ClaudeJsonResult;
    } catch {
      parsed = undefined;
    }

    if (!parsed || typeof parsed.result !== 'string') {
      return { output: stdout || stderr, tokensIn: 0, tokensOut: 0, wallMs: elapsedMs };
    }

    return {
      output: parsed.result,
      tokensIn: parsed.usage?.input_tokens ?? 0,
      tokensOut: parsed.usage?.output_tokens ?? 0,
      wallMs: parsed.duration_ms ?? elapsedMs,
    };
  }

  protected isAuthError(stderr: string): boolean {
    return AUTH_ERROR_PATTERN.test(stderr);
  }
}
