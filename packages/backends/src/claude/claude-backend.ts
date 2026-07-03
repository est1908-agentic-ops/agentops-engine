import type { AgentRunResult, BackendRunRequest } from '@agentops/contracts';
import type { CliSpec } from '../cli-spec';
import {
  ProcessCliAuthError,
  ProcessCliProcessError,
  ProcessCliTimeoutError,
} from '../process-cli-runner';

export { ProcessCliProcessError as ClaudeBackendProcessError };
export { ProcessCliTimeoutError as ClaudeBackendTimeoutError };
export { ProcessCliAuthError as ClaudeBackendAuthError };

export interface ClaudeCliSpecOptions {
  image?: string;
  maxTurns?: number;
}

interface ClaudeJsonResult {
  is_error?: boolean;
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  duration_ms?: number;
}

const AUTH_ERROR_PATTERN = /(invalid|expired).{0,30}(api key|token)/i;
const DEFAULT_IMAGE = 'ghcr.io/CHANGEME/agentops-engine/agent-claude:CHANGEME';

export function createClaudeCliSpec(opts: ClaudeCliSpecOptions = {}): CliSpec {
  const maxTurns = opts.maxTurns ?? 30;
  const image = opts.image ?? DEFAULT_IMAGE;

  return {
    image,
    binary: 'claude',
    buildArgs(req: BackendRunRequest): string[] {
      const args = [
        '-p',
        '--output-format',
        'json',
        '--model',
        req.model,
        '--max-turns',
        String(maxTurns),
        '--dangerously-skip-permissions',
      ];
      if (req.effort) {
        args.push('--effort', req.effort);
      }
      return args;
    },
    parseOutput(stdout: string, stderr: string, elapsedMs: number): AgentRunResult {
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
    },
    isAuthError(stderr: string): boolean {
      return AUTH_ERROR_PATTERN.test(stderr);
    },
  };
}
