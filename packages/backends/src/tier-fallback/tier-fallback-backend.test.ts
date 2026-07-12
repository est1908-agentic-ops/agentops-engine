import { describe, expect, it, vi } from 'vitest';
import type { AgentRunResult, BackendRunRequest, ModelRef } from '@agentops/contracts';
import type { AgentBackend } from '../agent-backend';
import { RateLimitError, SessionLimitError, SessionLimitExhaustedError } from '../provider-rate-limit';
import { TierFallbackBackend } from './tier-fallback-backend';

const baseRequest: BackendRunRequest = {
  taskId: 't1',
  stage: 'design',
  attempt: 1,
  callIndex: 1,
  backend: 'claude',
  model: 'opus',
  workspaceRef: '/tmp/ws',
  limits: { maxTokens: 1000, timeoutMs: 5000 },
  prompt: 'do the thing',
};

const successResult: AgentRunResult = { output: 'ok', tokensIn: 1, tokensOut: 1, wallMs: 10 };

function makeBackend(resultOrError: AgentRunResult | Error): AgentBackend {
  const run = vi.fn();
  if (resultOrError instanceof Error) {
    run.mockRejectedValue(resultOrError);
  } else {
    run.mockResolvedValue(resultOrError);
  }
  return { run };
}

describe('TierFallbackBackend', () => {
  it('delegates straight through on primary success, without walking the chain', async () => {
    const inner = makeBackend(successResult);
    const registry = { claude: inner };
    const heartbeat = vi.fn();
    const backend = new TierFallbackBackend(inner, registry, [], 'design', heartbeat);

    const result = await backend.run(baseRequest);

    expect(result).toBe(successResult);
    expect(inner.run).toHaveBeenCalledTimes(1);
    expect(heartbeat).not.toHaveBeenCalled();
  });

  it('walks the chain on SessionLimitError, dispatching cross-backend via the registry', async () => {
    const primary = makeBackend(new SessionLimitError('session limit'));
    const fallbackResult: AgentRunResult = { output: 'fallback ok', tokensIn: 2, tokensOut: 2, wallMs: 20 };
    const fallback = makeBackend(fallbackResult);
    const registry = { claude: primary, pi: fallback };
    const heartbeat = vi.fn();
    const chain: ModelRef[] = [{ backend: 'pi', model: 'zai/glm-5.2' }];
    const backend = new TierFallbackBackend(primary, registry, chain, 'design', heartbeat);

    const result = await backend.run(baseRequest);

    expect(result).toBe(fallbackResult);
    expect(primary.run).toHaveBeenCalledTimes(1);
    expect(fallback.run).toHaveBeenCalledTimes(1);
    expect(fallback.run).toHaveBeenCalledWith(
      expect.objectContaining({ backend: 'pi', model: 'zai/glm-5.2' }),
    );
    expect(heartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'session-limit-fallback' }),
    );
  });

  it('propagates RateLimitError without walking the chain', async () => {
    const primary = makeBackend(new RateLimitError('429 rate limit'));
    const fallback = makeBackend(successResult);
    const registry = { claude: primary, pi: fallback };
    const backend = new TierFallbackBackend(primary, registry, [{ backend: 'pi', model: 'zai/glm-5.2' }], 'design', vi.fn());

    await expect(backend.run(baseRequest)).rejects.toThrow(RateLimitError);
    expect(fallback.run).not.toHaveBeenCalled();
  });

  it('throws SessionLimitExhaustedError when the entire chain is exhausted', async () => {
    const primary = makeBackend(new SessionLimitError('session limit'));
    const fallback = makeBackend(new SessionLimitError('also session limited'));
    const registry = { claude: primary, pi: fallback };
    const chain: ModelRef[] = [{ backend: 'pi', model: 'zai/glm-5.2' }];
    const backend = new TierFallbackBackend(primary, registry, chain, 'design', () => {});

    await expect(backend.run(baseRequest)).rejects.toThrow(SessionLimitExhaustedError);
  });

  it('propagates a non-session error during a fallback attempt immediately (does not swallow)', async () => {
    const primary = makeBackend(new SessionLimitError('session limit'));
    const fallback = makeBackend(new Error('fallback auth blew up'));
    const registry = { claude: primary, pi: fallback };
    const chain: ModelRef[] = [{ backend: 'pi', model: 'zai/glm-5.2' }];
    const backend = new TierFallbackBackend(primary, registry, chain, 'design', () => {});

    await expect(backend.run(baseRequest)).rejects.toThrow('fallback auth blew up');
  });

  it('propagates any non-throttle error from the primary without touching the chain', async () => {
    const boom = new Error('genuine outage');
    const primary = makeBackend(boom);
    const fallback = makeBackend(successResult);
    const registry = { claude: primary, pi: fallback };
    const backend = new TierFallbackBackend(primary, registry, [{ backend: 'pi', model: 'zai/glm-5.2' }], 'design', vi.fn());

    await expect(backend.run(baseRequest)).rejects.toThrow(boom);
    expect(fallback.run).not.toHaveBeenCalled();
  });
});
