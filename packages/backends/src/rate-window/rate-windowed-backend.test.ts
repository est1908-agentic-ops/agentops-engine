import { describe, expect, it, vi } from 'vitest';
import type { AgentRunResult, BackendRunRequest } from '@agentops/contracts';
import type { AgentBackend } from '../agent-backend';
import { RateWindowLimiter } from './rate-window-limiter';
import { RateWindowedBackend, RateWindowExceededError } from './rate-windowed-backend';

const baseRequest: BackendRunRequest = {
  taskId: 't1',
  stage: 'implement',
  attempt: 1,
  callIndex: 1,
  backend: 'claude',
  model: 'claude-sonnet-5',
  workspaceRef: '/tmp/ws',
  limits: { maxTokens: 1000, timeoutMs: 5000 },
  prompt: 'do the thing',
};

const successResult: AgentRunResult = { output: 'ok', tokensIn: 1, tokensOut: 1, wallMs: 10 };

describe('RateWindowedBackend', () => {
  it('delegates to the inner backend and records a call when a slot is free', async () => {
    const inner: AgentBackend = { run: vi.fn().mockResolvedValue(successResult) };
    const limiter = new RateWindowLimiter({ maxCalls: 5, windowMs: 1000 }, () => 0);
    const backend = new RateWindowedBackend(inner, limiter, 'claude');

    const result = await backend.run(baseRequest);

    expect(result).toBe(successResult);
    expect(inner.run).toHaveBeenCalledWith(baseRequest);
  });

  it('throws RateWindowExceededError with the wait time, without calling the inner backend', async () => {
    const inner: AgentBackend = { run: vi.fn().mockResolvedValue(successResult) };
    let now = 0;
    const limiter = new RateWindowLimiter({ maxCalls: 1, windowMs: 1000 }, () => now);
    const backend = new RateWindowedBackend(inner, limiter, 'claude');

    await backend.run(baseRequest); // consumes the only slot
    now += 100;

    let caught: unknown;
    try {
      await backend.run(baseRequest);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(RateWindowExceededError);
    expect((caught as RateWindowExceededError).retryAfterMs).toBe(900);
    expect(inner.run).toHaveBeenCalledTimes(1);
  });
});
