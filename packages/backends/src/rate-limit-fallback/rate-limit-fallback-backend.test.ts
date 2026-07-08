import { describe, expect, it, vi } from 'vitest';
import type { AgentRunResult, BackendRunRequest } from '@agentops/contracts';
import type { AgentBackend } from '../agent-backend';
import { ProviderRateLimitedError } from '../provider-rate-limit';
import { RateLimitFallbackBackend } from './rate-limit-fallback-backend';

const baseRequest: BackendRunRequest = {
  taskId: 't1',
  stage: 'implement',
  attempt: 1,
  callIndex: 1,
  backend: 'pi',
  model: 'zai/glm-5.2',
  workspaceRef: '/tmp/ws',
  limits: { maxTokens: 1000, timeoutMs: 5000 },
  prompt: 'do the thing',
};

const successResult: AgentRunResult = { output: 'ok', tokensIn: 1, tokensOut: 1, wallMs: 10 };

describe('RateLimitFallbackBackend', () => {
  it('delegates straight through on success, without heartbeating or touching the fallback', async () => {
    const run = vi.fn().mockResolvedValue(successResult);
    const inner: AgentBackend = { run };
    const heartbeat = vi.fn();
    const backend = new RateLimitFallbackBackend(inner, 'openrouter/deepseek-v4-pro', 'pi', heartbeat);

    const result = await backend.run(baseRequest);

    expect(result).toBe(successResult);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(baseRequest);
    expect(heartbeat).not.toHaveBeenCalled();
  });

  it('propagates a non-rate-limit error without touching the fallback', async () => {
    const boom = new Error('boom');
    const run = vi.fn().mockRejectedValue(boom);
    const inner: AgentBackend = { run };
    const heartbeat = vi.fn();
    const backend = new RateLimitFallbackBackend(inner, 'openrouter/deepseek-v4-pro', 'pi', heartbeat);

    await expect(backend.run(baseRequest)).rejects.toThrow(boom);
    expect(run).toHaveBeenCalledTimes(1);
    expect(heartbeat).not.toHaveBeenCalled();
  });

  it('heartbeats and retries once against the fallback model on ProviderRateLimitedError', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new ProviderRateLimitedError('429 Fair Usage Policy'))
      .mockResolvedValueOnce(successResult);
    const inner: AgentBackend = { run };
    const heartbeat = vi.fn();
    const backend = new RateLimitFallbackBackend(inner, 'openrouter/deepseek-v4-pro', 'pi', heartbeat);

    const result = await backend.run(baseRequest);

    expect(result).toBe(successResult);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(1, baseRequest);
    expect(run).toHaveBeenNthCalledWith(2, { ...baseRequest, model: 'openrouter/deepseek-v4-pro' });
    expect(heartbeat).toHaveBeenCalledWith({
      event: 'provider-rate-limited',
      backend: 'pi',
      taskId: 't1',
      stage: 'implement',
      primaryModel: 'zai/glm-5.2',
      fallbackModel: 'openrouter/deepseek-v4-pro',
      message: '429 Fair Usage Policy',
    });
  });

  it('propagates the fallback error when the fallback attempt also fails', async () => {
    const fallbackErr = new Error('fallback also failed');
    const run = vi
      .fn()
      .mockRejectedValueOnce(new ProviderRateLimitedError('429 Fair Usage Policy'))
      .mockRejectedValueOnce(fallbackErr);
    const inner: AgentBackend = { run };
    const backend = new RateLimitFallbackBackend(inner, 'openrouter/deepseek-v4-pro', 'pi', () => {});

    await expect(backend.run(baseRequest)).rejects.toThrow(fallbackErr);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
