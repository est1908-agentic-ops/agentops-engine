import { isReadOnlyStage } from '@agentops/contracts';
import type { AgentRunResult, BackendRunRequest } from '@agentops/contracts';
import type { CliSpec } from '../cli-spec';
import {
  ProcessCliAuthError,
  ProcessCliProcessError,
  ProcessCliTimeoutError,
} from '../process-cli-runner';
import { isRateLimitMessage, isSessionLimitMessage, RateLimitError, SessionLimitError } from '../provider-rate-limit';

export { ProcessCliProcessError as GrokBackendProcessError };
export { ProcessCliTimeoutError as GrokBackendTimeoutError };
export { ProcessCliAuthError as GrokBackendAuthError };

export interface GrokCliSpecOptions {
  image?: string;
}

interface GrokJsonResult {
  type?: string;
  is_error?: boolean;
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  duration_ms?: number;
  message?: string;
}

// Grok's `--output-format streaming-messages-json` matches Claude Code's
// stream-json wire shape: a `system`/`init` preamble, mid-run assistant/user
// events, then one final `{"type":"result", ...}` with the same fields the
// buffered `--output-format json` result carries. Prefer the terminal `result`
// event; fall back to a single-object blob with a string `result` for fixtures
// and older images. Streaming is required so the K8sJobRunner idle detector
// sees file growth during long runs (same rationale as claude-backend).
function extractResultEvent(stdout: string): GrokJsonResult | undefined {
  let resultEvent: GrokJsonResult | undefined;
  let fallback: GrokJsonResult | undefined;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let obj: GrokJsonResult;
    try {
      obj = JSON.parse(trimmed) as GrokJsonResult;
    } catch {
      continue;
    }
    if (obj === null || typeof obj !== 'object') {
      continue;
    }
    if (obj.type === 'result') {
      resultEvent = obj;
    } else if (typeof obj.result === 'string') {
      fallback = obj;
    }
  }
  return resultEvent ?? fallback;
}

// Auth failures surface both on stderr at startup and as is_error result
// messages mid-run. Keep the pattern broad (same class as claude-backend).
const AUTH_ERROR_PATTERN =
  /\b401\b|unauthoriz|failed to authenticate|(invalid|expired|incorrect|revoked)[\s\S]{0,30}(api key|token|credential)|(api key|token|credential)[\s\S]{0,30}(invalid|expired|incorrect|revoked)|no api key|xai_api_key/i;
const DEFAULT_IMAGE = 'ghcr.io/CHANGEME/agentops-engine/agent-runner:CHANGEME';

export function createGrokCliSpec(opts: GrokCliSpecOptions = {}): CliSpec {
  const image = opts.image ?? DEFAULT_IMAGE;

  return {
    image,
    binary: 'grok',
    buildArgs(req: BackendRunRequest): string[] {
      // Prompt arrives on stdin via K8sJobRunner's SHELL_REDIRECT /
      // ProcessCliRunner. Grok's `-p` requires an argv value, so read the
      // redirected stdin through `--prompt-file /dev/stdin` instead.
      //
      // `streaming-messages-json` (not plain `json`): the K8sJobRunner's
      // liveness check is purely file-growth. Buffered json writes nothing
      // until the whole run finishes and trips idleTimeoutMs on long work.
      // The Messages-shaped stream also reuses the same result-event parser
      // shape as claude-backend.
      //
      // Permission profile: read-only stages get `plan`; write stages get
      // `bypassPermissions` (Grok's always-approve mode, analogous to
      // Claude's `--dangerously-skip-permissions`).
      //
      // `--no-auto-update` keeps container images immutable at runtime.
      const args = [
        '--prompt-file',
        '/dev/stdin',
        '--output-format',
        'streaming-messages-json',
        '--no-auto-update',
        '--model',
        req.model,
      ];
      if (isReadOnlyStage(req.stage)) {
        args.push('--permission-mode', 'plan');
      } else {
        args.push('--permission-mode', 'bypassPermissions');
      }
      if (req.effort) {
        args.push('--effort', req.effort);
      }
      return args;
    },
    parseOutput(stdout: string, stderr: string, elapsedMs: number): AgentRunResult {
      // A top-level `{"type":"error","message":"..."}` line (non-zero exit
      // companion) can appear without a result event.
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as GrokJsonResult;
          if (obj?.type === 'error' && typeof obj.message === 'string') {
            if (AUTH_ERROR_PATTERN.test(obj.message)) {
              throw new ProcessCliAuthError(obj.message);
            }
            if (isSessionLimitMessage(obj.message)) {
              throw new SessionLimitError(obj.message);
            }
            if (isRateLimitMessage(obj.message)) {
              throw new RateLimitError(obj.message);
            }
            throw new ProcessCliProcessError(obj.message);
          }
        } catch (err) {
          if (
            err instanceof ProcessCliAuthError ||
            err instanceof SessionLimitError ||
            err instanceof RateLimitError ||
            err instanceof ProcessCliProcessError
          ) {
            throw err;
          }
        }
      }

      const parsed = extractResultEvent(stdout);

      if (!parsed || typeof parsed.result !== 'string') {
        throw new ProcessCliProcessError(`grok produced no parseable JSON result: ${(stdout || stderr).slice(0, 500)}`);
      }

      if (parsed.is_error) {
        const message = `grok reported is_error: ${parsed.result}`;
        if (AUTH_ERROR_PATTERN.test(parsed.result)) {
          throw new ProcessCliAuthError(message);
        }
        if (isSessionLimitMessage(parsed.result)) {
          throw new SessionLimitError(message);
        }
        if (isRateLimitMessage(parsed.result)) {
          throw new RateLimitError(message);
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
