import { describe, expect, it } from 'vitest';
import { AgentRunRequestSchema, AgentRunResultSchema } from './agent-run';

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
