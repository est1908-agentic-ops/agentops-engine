import { describe, expect, it, vi } from 'vitest';
import type { BackendRunRequest } from '@agentops/contracts';
import { LiteLlmBackend, LiteLlmBudgetExceededError, LiteLlmRequestError, type LiteLlmBackendOptions } from './litellm-backend';

const baseRequest: BackendRunRequest = {
  taskId: 't1',
  stage: 'context',
  attempt: 1,
  callIndex: 1,
  backend: 'litellm',
  model: 'zai-glm-4.6',
  workspaceRef: '/tmp/ws',
  limits: { maxTokens: 1000, timeoutMs: 5000 },
  prompt: 'summarize the issue',
};

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function makeBackend(opts: Partial<LiteLlmBackendOptions>): LiteLlmBackend {
  return new LiteLlmBackend({
    baseUrl: 'http://litellm.platform.svc.cluster.local:4000',
    apiKey: 'sk-virtual-key',
    heartbeat: () => {},
    ...opts,
  });
}

describe('LiteLlmBackend', () => {
  it('posts an OpenAI-compatible chat completion request with the virtual key as bearer auth', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return fakeResponse(200, {
        choices: [{ message: { content: 'the issue is about X' } }],
        usage: { prompt_tokens: 42, completion_tokens: 7 },
      });
    });
    const backend = makeBackend({ fetchFn: fetchFn as unknown as typeof fetch });

    const result = await backend.run(baseRequest);

    expect(calls[0].url).toBe('http://litellm.platform.svc.cluster.local:4000/chat/completions');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer sk-virtual-key');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      model: 'zai-glm-4.6',
      messages: [{ role: 'user', content: 'summarize the issue' }],
    });
    expect(result).toEqual({ output: 'the issue is about X', tokensIn: 42, tokensOut: 7, wallMs: expect.any(Number) });
  });

  it('heartbeats once before making the request', async () => {
    const fetchFn = vi.fn(async () =>
      fakeResponse(200, {
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    const heartbeat = vi.fn();
    const backend = makeBackend({ fetchFn: fetchFn as unknown as typeof fetch, heartbeat });

    await backend.run(baseRequest);

    expect(heartbeat).toHaveBeenCalledWith({
      phase: 'started',
      taskId: 't1',
      stage: 'context',
      backend: 'litellm',
      model: 'zai-glm-4.6',
    });
  });

  it('throws LiteLlmBudgetExceededError on a 429 whose body identifies BudgetExceededError', async () => {
    const fetchFn = vi.fn(async () =>
      fakeResponse(429, { error: { message: 'Budget has been exceeded! Current cost: 1.20, Max budget: 1.00', error_class: 'BudgetExceededError' } }),
    );
    const backend = makeBackend({ fetchFn: fetchFn as unknown as typeof fetch });

    await expect(backend.run(baseRequest)).rejects.toThrow(LiteLlmBudgetExceededError);
  });

  it('throws the generic LiteLlmRequestError (not budget-exceeded) on a plain 429 rate limit', async () => {
    const fetchFn = vi.fn(async () => fakeResponse(429, { error: { message: 'rate limit exceeded, try again later' } }));
    const backend = makeBackend({ fetchFn: fetchFn as unknown as typeof fetch });

    await expect(backend.run(baseRequest)).rejects.toThrow(LiteLlmRequestError);
    await expect(backend.run(baseRequest)).rejects.not.toThrow(LiteLlmBudgetExceededError);
  });

  it('throws LiteLlmRequestError on a non-429 error status', async () => {
    const fetchFn = vi.fn(async () => fakeResponse(500, { error: { message: 'internal error' } }));
    const backend = makeBackend({ fetchFn: fetchFn as unknown as typeof fetch });

    await expect(backend.run(baseRequest)).rejects.toThrow(LiteLlmRequestError);
  });

  it('throws LiteLlmRequestError when the network request itself fails', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const backend = makeBackend({ fetchFn: fetchFn as unknown as typeof fetch });

    await expect(backend.run(baseRequest)).rejects.toThrow(LiteLlmRequestError);
  });

  it('throws LiteLlmRequestError when the response body has no choices[0].message.content', async () => {
    const fetchFn = vi.fn(async () => fakeResponse(200, { choices: [] }));
    const backend = makeBackend({ fetchFn: fetchFn as unknown as typeof fetch });

    await expect(backend.run(baseRequest)).rejects.toThrow(LiteLlmRequestError);
  });

  it('aborts and throws LiteLlmRequestError when the request exceeds limits.timeoutMs', async () => {
    const fetchFn = vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const backend = makeBackend({ fetchFn: fetchFn as unknown as typeof fetch });

    await expect(backend.run({ ...baseRequest, limits: { maxTokens: 1000, timeoutMs: 10 } })).rejects.toThrow(
      LiteLlmRequestError,
    );
  });
});
