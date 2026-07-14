import { describe, expect, it } from 'vitest';
import {
  BudgetsResponseSchema,
  RepoListResponseSchema,
  RunDetailSchema,
  RunListItemSchema,
  StartRunRequestSchema,
  StartRunResponseSchema,
} from './control-api';

describe('StartRunRequestSchema', () => {
  it('requires a non-empty prompt', () => {
    expect(() => StartRunRequestSchema.parse({ prompt: '' })).toThrow();
  });

  it('allows hintRepos and workflowId to be omitted', () => {
    const parsed = StartRunRequestSchema.parse({ prompt: 'check the last failures' });
    expect(parsed.hintRepos).toBeUndefined();
    expect(parsed.workflowId).toBeUndefined();
  });

  it('accepts hintRepos and a caller-supplied workflowId', () => {
    const parsed = StartRunRequestSchema.parse({
      prompt: 'check the last failures',
      hintRepos: ['flair-hr/agentops-engine'],
      workflowId: 'platform-my-run',
    });
    expect(parsed.hintRepos).toEqual(['flair-hr/agentops-engine']);
    expect(parsed.workflowId).toBe('platform-my-run');
  });
});

describe('StartRunResponseSchema', () => {
  it('requires workflowId and runId', () => {
    expect(() => StartRunResponseSchema.parse({ workflowId: 'w1' })).toThrow();
    expect(StartRunResponseSchema.parse({ workflowId: 'w1', runId: 'r1' })).toEqual({
      workflowId: 'w1',
      runId: 'r1',
    });
  });
});

describe('RunListItemSchema', () => {
  it('accepts a running item with no closeTime/promptSnippet', () => {
    const parsed = RunListItemSchema.parse({
      workflowId: 'platform-1',
      runId: 'r1',
      status: 'RUNNING',
      startTime: '2026-07-07T00:00:00.000Z',
    });
    expect(parsed.closeTime).toBeUndefined();
    expect(parsed.promptSnippet).toBeUndefined();
  });

  it('rejects an unrecognized status', () => {
    expect(() =>
      RunListItemSchema.parse({
        workflowId: 'platform-1',
        runId: 'r1',
        status: 'BOGUS',
        startTime: '2026-07-07T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('accepts the full set of realistic terminal statuses', () => {
    for (const status of ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'TERMINATED', 'TIMED_OUT', 'CONTINUED_AS_NEW']) {
      expect(() =>
        RunListItemSchema.parse({ workflowId: 'w', runId: 'r', status, startTime: '2026-07-07T00:00:00.000Z' }),
      ).not.toThrow();
    }
  });
});

describe('RunDetailSchema', () => {
  it('accepts a running detail with no result/error', () => {
    const parsed = RunDetailSchema.parse({
      workflowId: 'platform-1',
      runId: 'r1',
      status: 'RUNNING',
      temporalUrl: 'https://temporal.example/namespaces/default/workflows/platform-1/r1/history',
    });
    expect(parsed.result).toBeUndefined();
    expect(parsed.error).toBeUndefined();
  });

  it('accepts a completed detail with a result', () => {
    const parsed = RunDetailSchema.parse({
      workflowId: 'platform-1',
      runId: 'r1',
      status: 'COMPLETED',
      temporalUrl: 'https://temporal.example/namespaces/default/workflows/platform-1/r1/history',
      result: { summary: 'all quiet', actionsTaken: [], childWorkflows: [] },
    });
    expect(parsed.result?.summary).toBe('all quiet');
  });

  it('accepts a failed detail with an error and no result', () => {
    const parsed = RunDetailSchema.parse({
      workflowId: 'platform-1',
      runId: 'r1',
      status: 'FAILED',
      temporalUrl: 'https://temporal.example/namespaces/default/workflows/platform-1/r1/history',
      error: 'workflow ended with status FAILED',
    });
    expect(parsed.result).toBeUndefined();
    expect(parsed.error).toBe('workflow ended with status FAILED');
  });
});

describe('RepoListResponseSchema', () => {
  it('accepts an empty repo list', () => {
    expect(RepoListResponseSchema.parse({ repos: [] })).toEqual({ repos: [] });
  });
});

describe('BudgetsResponseSchema', () => {
  it('accepts a full payload with all sections populated', () => {
    const payload = {
      rateWindows: {
        claude: { maxCalls: 50, windowHours: 1, configured: true },
        pi: { maxCalls: 0, windowHours: 0, configured: false },
      },
      claude: {
        totalTokens: 1000,
        tokensIn: 600,
        tokensOut: 400,
        calls: 2,
        period: 'from agent_run_stats (all recorded runs)',
        modelBreakdown: [
          { model: 'claude-opus-4-8', tokens: 800, calls: 1 },
          { model: 'claude-sonnet-5', tokens: 200, calls: 1 },
        ],
      },
      openRouter: {
        estimatedUsd: 1.234567,
        totalTokens: 500,
        period: 'from agent_run_stats (all recorded runs)',
        modelBreakdown: [{ model: 'openrouter/deepseek-v4-pro', tokens: 500, estimatedUsd: 0.123456 }],
      },
    };
    const parsed = BudgetsResponseSchema.parse(payload);
    expect(parsed.claude.totalTokens).toBe(1000);
    expect(parsed.claude.calls).toBe(2);
    expect(parsed.claude.modelBreakdown).toHaveLength(2);
  });

  it('rejects a payload missing the required claude block', () => {
    const payload = {
      rateWindows: {
        claude: { maxCalls: 50, windowHours: 1, configured: true },
        pi: { maxCalls: 0, windowHours: 0, configured: false },
      },
      openRouter: {
        estimatedUsd: 1.234567,
        totalTokens: 500,
        period: 'from agent_run_stats (all recorded runs)',
        modelBreakdown: [],
      },
    };
    expect(() => BudgetsResponseSchema.parse(payload)).toThrow();
  });

  it('rejects a claude modelBreakdown row with a negative token count', () => {
    const payload = {
      rateWindows: {
        claude: { maxCalls: 50, windowHours: 1, configured: true },
        pi: { maxCalls: 0, windowHours: 0, configured: false },
      },
      claude: {
        totalTokens: 1000,
        tokensIn: 600,
        tokensOut: 400,
        calls: 2,
        period: 'from agent_run_stats (all recorded runs)',
        modelBreakdown: [{ model: 'claude-opus-4-8', tokens: -100, calls: 1 }],
      },
      openRouter: {
        estimatedUsd: 1.234567,
        totalTokens: 500,
        period: 'from agent_run_stats (all recorded runs)',
        modelBreakdown: [],
      },
    };
    expect(() => BudgetsResponseSchema.parse(payload)).toThrow();
  });

  it('rejects a claude modelBreakdown row missing the calls field', () => {
    const payload = {
      rateWindows: {
        claude: { maxCalls: 50, windowHours: 1, configured: true },
        pi: { maxCalls: 0, windowHours: 0, configured: false },
      },
      claude: {
        totalTokens: 1000,
        tokensIn: 600,
        tokensOut: 400,
        calls: 2,
        period: 'from agent_run_stats (all recorded runs)',
        modelBreakdown: [{ model: 'claude-opus-4-8', tokens: 800 }],
      },
      openRouter: {
        estimatedUsd: 1.234567,
        totalTokens: 500,
        period: 'from agent_run_stats (all recorded runs)',
        modelBreakdown: [],
      },
    };
    expect(() => BudgetsResponseSchema.parse(payload)).toThrow();
  });
});
