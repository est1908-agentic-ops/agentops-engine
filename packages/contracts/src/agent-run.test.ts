import { describe, expect, it } from 'vitest';
import { AgentRunRequestSchema, AgentRunResultSchema, BackendRunRequestSchema } from './agent-run';

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
