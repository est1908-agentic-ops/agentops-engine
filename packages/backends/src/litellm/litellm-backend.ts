import type { AgentRunResult, BackendRunRequest } from '@agentops/contracts';
import type { AgentBackend } from '../agent-backend';

export class LiteLlmRequestError extends Error {}
export class LiteLlmBudgetExceededError extends Error {}

export interface LiteLlmBackendOptions {
  baseUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface LiteLlmErrorBody {
  error?: { message?: string; error_class?: string };
}

function isBudgetExceeded(status: number, bodyText: string): boolean {
  if (status !== 429) return false;
  try {
    const parsed = JSON.parse(bodyText) as LiteLlmErrorBody;
    return parsed.error?.error_class === 'BudgetExceededError' || /budget has been exceeded/i.test(parsed.error?.message ?? '');
  } catch {
    return /budget has been exceeded/i.test(bodyText);
  }
}

function extractMessage(bodyText: string): string | undefined {
  try {
    return (JSON.parse(bodyText) as LiteLlmErrorBody).error?.message;
  } catch {
    return undefined;
  }
}

// Non-CLI backend: an HTTP call through LiteLLM's OpenAI-compatible endpoint
// instead of a spawned process. req.model is the LiteLLM-side model_list
// alias (e.g. "zai-glm-4.6"), not a raw provider string — see
// agentops-platform's litellm-deploy-design.md for why that indirection
// matters. req.limits.maxTokens is the workflow's cumulative token brake,
// unrelated to the OpenAI "max output tokens" concept, so it's deliberately
// not sent as a request parameter (claude/pi backends don't map it either).
export class LiteLlmBackend implements AgentBackend {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: LiteLlmBackendOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async run(req: BackendRunRequest): Promise<AgentRunResult> {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.limits.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(`${this.opts.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({
          model: req.model,
          messages: [{ role: 'user', content: req.prompt }],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new LiteLlmRequestError(`litellm request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    const wallMs = Date.now() - start;
    const bodyText = await response.text();

    if (!response.ok) {
      if (isBudgetExceeded(response.status, bodyText)) {
        throw new LiteLlmBudgetExceededError(extractMessage(bodyText) ?? 'litellm virtual key budget exceeded');
      }
      throw new LiteLlmRequestError(`litellm returned ${response.status}: ${bodyText.slice(0, 500)}`);
    }

    let parsed: ChatCompletionResponse;
    try {
      parsed = JSON.parse(bodyText) as ChatCompletionResponse;
    } catch {
      throw new LiteLlmRequestError(`litellm returned unparseable JSON: ${bodyText.slice(0, 500)}`);
    }

    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new LiteLlmRequestError(`litellm response missing choices[0].message.content: ${bodyText.slice(0, 500)}`);
    }

    return {
      output: content,
      tokensIn: parsed.usage?.prompt_tokens ?? 0,
      tokensOut: parsed.usage?.completion_tokens ?? 0,
      wallMs,
    };
  }
}
