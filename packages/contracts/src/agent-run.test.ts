import { describe, expect, it } from 'vitest';
import {
  AgentRunLimitsSchema,
  AgentRunRequestSchema,
  AgentRunResultSchema,
  BackendRunRequestSchema,
  DEFAULT_BACKSTOP_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
} from './agent-run';

describe('AgentRunRequestSchema', () => {
  it('defaults callIndex to 1', () => {
    const parsed = AgentRunRequestSchema.parse({
      taskId: 'task-1',
      stage: 'implement',
      attempt: 1,
      backend: 'stub',
      model: 'stub-v1',
      promptRef: 'implement.md',
      workspaceRef: 'demo/repo',
      limits: { maxTokens: 1000, timeoutMs: 60_000 },
    });
    expect(parsed.callIndex).toBe(1);
  });

  it('AgentRunRequestSchema defaults promptContext to an empty object', () => {
    const parsed = AgentRunRequestSchema.parse({
      taskId: 't1',
      stage: 'implement',
      attempt: 1,
      backend: 'claude',
      model: 'claude-sonnet-5',
      promptRef: 'implement.md',
      workspaceRef: '/tmp/ws',
      limits: { maxTokens: 1000, timeoutMs: 60_000 },
    });
    expect(parsed.promptContext).toEqual({});
    expect(parsed.effort).toBeUndefined();
  });

  it('AgentRunRequestSchema accepts promptContext and effort', () => {
    const parsed = AgentRunRequestSchema.parse({
      taskId: 't1',
      stage: 'implement',
      attempt: 1,
      backend: 'claude',
      model: 'claude-sonnet-5',
      effort: 'high',
      promptRef: 'implement.md',
      promptContext: { goal: 'add a widget' },
      workspaceRef: '/tmp/ws',
      limits: { maxTokens: 1000, timeoutMs: 60_000 },
    });
    expect(parsed.promptContext).toEqual({ goal: 'add a widget' });
    expect(parsed.effort).toBe('high');
  });

  it('accepts an optional image and services array', () => {
    const parsed = AgentRunRequestSchema.parse({
      taskId: 't1',
      stage: 'full_verify',
      attempt: 1,
      backend: 'claude',
      model: 'claude-sonnet-5',
      image: 'ghcr.io/example/agentops:latest',
      services: [
        { name: 'redis', image: 'redis:7-alpine', readiness: { type: 'tcpSocket', port: 6379 } },
      ],
      promptRef: 'full_verify.md',
      workspaceRef: '/tmp/ws',
      limits: { maxTokens: 1000, timeoutMs: 60_000 },
    });
    expect(parsed.image).toBe('ghcr.io/example/agentops:latest');
    expect(parsed.services).toEqual([
      { name: 'redis', image: 'redis:7-alpine', readiness: { type: 'tcpSocket', port: 6379 } },
    ]);
  });
});

describe('BackendRunRequestSchema', () => {
  it('has prompt instead of promptRef/promptContext, keeps everything else', () => {
    const parsed = BackendRunRequestSchema.parse({
      taskId: 't1',
      stage: 'implement',
      attempt: 1,
      callIndex: 1,
      backend: 'claude',
      model: 'claude-sonnet-5',
      effort: 'high',
      workspaceRef: '/tmp/ws',
      limits: { maxTokens: 1000, timeoutMs: 60_000 },
      prompt: 'rendered prompt text',
    });
    expect(parsed.prompt).toBe('rendered prompt text');
    expect((parsed as Record<string, unknown>).promptRef).toBeUndefined();
  });

  it('carries image and services through, same as AgentRunRequestSchema', () => {
    const parsed = BackendRunRequestSchema.parse({
      taskId: 't1',
      stage: 'full_verify',
      attempt: 1,
      callIndex: 1,
      backend: 'claude',
      model: 'claude-sonnet-5',
      image: 'ghcr.io/example/agentops:latest',
      services: [
        { name: 'redis', image: 'redis:7-alpine', readiness: { type: 'tcpSocket', port: 6379 } },
      ],
      workspaceRef: '/tmp/ws',
      limits: { maxTokens: 1000, timeoutMs: 60_000 },
      prompt: 'run verify',
    });
    expect(parsed.image).toBe('ghcr.io/example/agentops:latest');
    expect(parsed.services).toHaveLength(1);
  });
});

describe('AgentRunResultSchema', () => {
  it('parses a result with token/time usage', () => {
    const parsed = AgentRunResultSchema.parse({
      output: 'VERDICT: PASS',
      tokensIn: 100,
      tokensOut: 50,
      wallMs: 1200,
    });
    expect(parsed.tokensIn + parsed.tokensOut).toBe(150);
  });
});

describe('AgentRunLimitsSchema', () => {
  it('accepts limits without idleTimeoutMs — optional, only K8sJobRunner reads it', () => {
    expect(() => AgentRunLimitsSchema.parse({ maxTokens: 1000, timeoutMs: 60_000 })).not.toThrow();
  });

  it('accepts limits with an explicit idleTimeoutMs', () => {
    const parsed = AgentRunLimitsSchema.parse({
      maxTokens: 1000,
      idleTimeoutMs: 300_000,
      timeoutMs: 1_800_000,
    });
    expect(parsed.idleTimeoutMs).toBe(300_000);
  });

  it('rejects a negative idleTimeoutMs', () => {
    expect(() =>
      AgentRunLimitsSchema.parse({ maxTokens: 1000, idleTimeoutMs: -1, timeoutMs: 60_000 }),
    ).toThrow();
  });
});

describe('default timeout constants', () => {
  it('DEFAULT_IDLE_TIMEOUT_MS is 5 minutes', () => {
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(300_000);
  });

  it('DEFAULT_BACKSTOP_TIMEOUT_MS is 30 minutes', () => {
    expect(DEFAULT_BACKSTOP_TIMEOUT_MS).toBe(1_800_000);
  });
});
