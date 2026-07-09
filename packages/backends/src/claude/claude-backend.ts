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
}

interface ClaudeJsonResult {
  is_error?: boolean;
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  duration_ms?: number;
}

// Matches an auth failure however the CLI phrases it. Kept deliberately broad
// because these arrive two ways: on stderr (a credential rejected at CLI
// startup) and -- as seen in prod -- inside the JSON `is_error` result on
// stdout ("Failed to authenticate. API Error: 401 token expired or incorrect"),
// which the stderr-only check never sees. Covers both word orders
// (token expired / expired token) plus a bare 401 and "unauthorized".
const AUTH_ERROR_PATTERN =
  /\b401\b|unauthoriz|failed to authenticate|(invalid|expired|incorrect|revoked)[\s\S]{0,30}(api key|token|credential)|(api key|token|credential)[\s\S]{0,30}(invalid|expired|incorrect|revoked)/i;
const DEFAULT_IMAGE = 'ghcr.io/CHANGEME/agentops-engine/agent-claude:CHANGEME';

export function createClaudeCliSpec(opts: ClaudeCliSpecOptions = {}): CliSpec {
  const image = opts.image ?? DEFAULT_IMAGE;

  return {
    image,
    binary: 'claude',
    buildArgs(req: BackendRunRequest): string[] {
      // No per-call turn cap is passed here: the CLI's `--max-turns` flag was
      // removed upstream (confirmed absent from `claude --help` on the pinned
      // agent-runner image version) and was being silently ignored -- a
      // no-op flag is worse than no flag, since it reads as a safety bound
      // that isn't actually enforced. Wall-clock (`limits.timeoutMs`) and
      // Temporal's activity retry cap are the only real bounds today;
      // `--max-budget-usd` is a real flag on the current CLI and the likely
      // replacement if a per-call cap is wanted again, but that's a product
      // decision (what budget?) left for whoever picks this up next.
      const args = ['-p', '--output-format', 'json', '--model', req.model, '--dangerously-skip-permissions'];
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
        throw new ProcessCliProcessError(`claude produced no parseable JSON result: ${(stdout || stderr).slice(0, 500)}`);
      }

      // is_error can be true on a JSON blob that still parses fine and still has
      // a string `result` (the error message itself) -- e.g. a bad model name,
      // an auth failure mid-turn, a provider outage. Left unchecked, that error
      // text silently becomes this stage's "output": fed into the next stage's
      // prompt as if it were real reasoning, and into verdict parsing for
      // full_verify/review, where it can never match FULL:/VERDICT: and just
      // reads as a garbled response instead of the actual failure it is.
      if (parsed.is_error) {
        const message = `claude reported is_error: ${parsed.result}`;
        // A 401 / expired / revoked credential is reported here, in the JSON
        // result on stdout -- not on stderr, so the stderr-only isAuthError()
        // check below never catches it. Without this, a dead credential looks
        // like a generic (retryable) process error: it gets retried pointlessly
        // and its cause is buried. Classify it as an auth error so runAgent can
        // fail fast and non-retryably.
        if (AUTH_ERROR_PATTERN.test(parsed.result)) {
          throw new ProcessCliAuthError(message);
        }
        throw new ProcessCliProcessError(message);
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
