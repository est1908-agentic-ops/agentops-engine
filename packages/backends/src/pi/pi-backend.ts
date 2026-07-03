import type { AgentRunResult, BackendRunRequest } from '@agentops/contracts';
import { ProcessCliBackend, type ProcessCliBackendOptions } from '../process-cli-backend';

export interface PiBackendOptions {
  executablePath?: string;
  spawn?: ProcessCliBackendOptions['spawn'];
  env?: NodeJS.ProcessEnv;
  killGraceMs?: number;
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

function extractAssistantText(message: PiMessage | undefined): string {
  if (!message?.content) return '';
  return message.content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('');
}

export class PiBackend extends ProcessCliBackend {
  constructor(opts: PiBackendOptions = {}) {
    super({
      executablePath: opts.executablePath ?? 'pi',
      spawn: opts.spawn,
      env: opts.env,
      killGraceMs: opts.killGraceMs,
    });
  }

  protected buildArgs(req: BackendRunRequest): string[] {
    const args = ['--print', '--mode', 'json', '--model', req.model, '--no-session'];
    if (req.effort) {
      args.push('--thinking', req.effort === 'max' ? 'xhigh' : req.effort);
    }
    return args;
  }

  protected parseOutput(stdout: string, stderr: string, elapsedMs: number): AgentRunResult {
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
  }

  protected isAuthError(stderr: string): boolean {
    return AUTH_ERROR_PATTERN.test(stderr);
  }
}
