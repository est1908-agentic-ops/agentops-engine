import type { AgentRunResult, BackendRunRequest } from '@agentops/contracts';
import type { CliSpec } from '../cli-spec';
import { ProcessCliProcessError } from '../process-cli-runner';
import { isProviderRateLimitMessage, ProviderRateLimitedError } from '../provider-rate-limit';

export interface PiCliSpecOptions {
  image?: string;
}

interface PiTextContent {
  type?: string;
  text?: string;
}

interface PiUsage {
  input?: number;
  output?: number;
}

interface PiMessage {
  role?: string;
  content?: PiTextContent[];
  stopReason?: string;
  errorMessage?: string;
  usage?: PiUsage;
}

interface PiJsonEvent {
  type?: string;
  message?: PiMessage;
  messages?: PiMessage[];
}

const AUTH_ERROR_PATTERN = /(no api key found|invalid api key|unauthorized|expired token)/i;
const DEFAULT_IMAGE = 'ghcr.io/CHANGEME/agentops-engine/agent-pi:CHANGEME';

function extractAssistantText(message: PiMessage | undefined): string {
  if (!message?.content) return '';
  return message.content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('');
}

export function createPiCliSpec(opts: PiCliSpecOptions = {}): CliSpec {
  const image = opts.image ?? DEFAULT_IMAGE;

  return {
    image,
    binary: 'pi',
    buildArgs(req: BackendRunRequest): string[] {
      const args = ['--print', '--mode', 'json', '--model', req.model, '--no-session'];
      if (req.effort) {
        args.push('--thinking', req.effort === 'max' ? 'xhigh' : req.effort);
      }
      return args;
    },
    parseOutput(stdout: string, stderr: string, elapsedMs: number): AgentRunResult {
      const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
      let lastAssistantMessage: PiMessage | undefined;

      for (const line of lines) {
        try {
          const event = JSON.parse(line) as PiJsonEvent;
          if (event.type === 'message_end' && event.message?.role === 'assistant') {
            lastAssistantMessage = event.message;
          }
          if (event.type === 'agent_end' && event.messages) {
            const found = [...event.messages].reverse().find((m) => m.role === 'assistant');
            if (found) lastAssistantMessage = found;
          }
        } catch {
          // skip malformed JSONL lines
        }
      }

      // pi's --mode json print mode always exits 0, even when a turn ends in
      // error or gets aborted -- process exit code carries no failure signal
      // at all here (unlike claude's is_error field, which at least comes
      // with a nonzero exit in some cases). stopReason/errorMessage on the
      // last assistant message is the only place a mid-session failure shows
      // up, and leaving it unchecked means that failure gets read as this
      // stage's real output instead.
      if (lastAssistantMessage?.stopReason === 'error' || lastAssistantMessage?.stopReason === 'aborted') {
        const message =
          lastAssistantMessage.errorMessage || `pi turn ended with stopReason "${lastAssistantMessage.stopReason}"`;
        if (isProviderRateLimitMessage(message)) {
          throw new ProviderRateLimitedError(message);
        }
        throw new ProcessCliProcessError(message);
      }

      const output = extractAssistantText(lastAssistantMessage);
      if (!output) {
        throw new ProcessCliProcessError(`pi produced no assistant text: ${(stdout || stderr).slice(0, 500)}`);
      }

      return {
        output,
        tokensIn: lastAssistantMessage?.usage?.input ?? 0,
        tokensOut: lastAssistantMessage?.usage?.output ?? 0,
        wallMs: elapsedMs,
      };
    },
    isAuthError(stderr: string): boolean {
      return AUTH_ERROR_PATTERN.test(stderr);
    },
  };
}
