import type { AgentRunResult, BackendRunRequest } from '@agentops/contracts';
import type { CliSpec } from '../cli-spec';

export interface PiCliSpecOptions {
  image?: string;
}

interface PiTextContent {
  type?: string;
  text?: string;
}

interface PiMessage {
  role?: string;
  content?: PiTextContent[];
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
      let output = '';

      for (const line of lines) {
        try {
          const event = JSON.parse(line) as PiJsonEvent;
          if (event.type === 'message_end' && event.message?.role === 'assistant') {
            output = extractAssistantText(event.message);
          }
          if (event.type === 'agent_end' && event.messages) {
            const lastAssistant = [...event.messages].reverse().find((m) => m.role === 'assistant');
            const text = extractAssistantText(lastAssistant);
            if (text) output = text;
          }
        } catch {
          // skip malformed JSONL lines
        }
      }

      if (!output) {
        return { output: stdout || stderr, tokensIn: 0, tokensOut: 0, wallMs: elapsedMs };
      }

      return { output, tokensIn: 0, tokensOut: 0, wallMs: elapsedMs };
    },
    isAuthError(stderr: string): boolean {
      return AUTH_ERROR_PATTERN.test(stderr);
    },
  };
}
