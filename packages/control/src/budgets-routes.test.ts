import { describe, expect, it, vi } from 'vitest';
import type { RunStats, BudgetsResponse } from '@agentops/contracts';
import { handleGetBudgets } from './budgets-routes';

const mockStats: RunStats[] = [
  // Claude runs with multiple models
  {
    taskId: 'task-1',
    stage: 'plan',
    backend: 'claude',
    model: 'claude-sonnet-5',
    tokensIn: 1000,
    tokensOut: 500,
    wallMs: 100,
    outcome: 'success',
  },
  {
    taskId: 'task-2',
    stage: 'fix',
    backend: 'claude',
    model: 'claude-sonnet-5',
    tokensIn: 2000,
    tokensOut: 1000,
    wallMs: 150,
    outcome: 'success',
  },
  {
    taskId: 'task-3',
    stage: 'explore',
    backend: 'claude',
    model: 'claude-opus-4-8',
    tokensIn: 5000,
    tokensOut: 3000,
    wallMs: 200,
    outcome: 'success',
  },
  // OpenRouter run (should not be counted as Claude usage)
  {
    taskId: 'task-4',
    stage: 'plan',
    backend: 'litellm',
    model: 'openrouter/deepseek-v4-pro',
    tokensIn: 3000,
    tokensOut: 2000,
    wallMs: 120,
    outcome: 'success',
  },
  // Stub backend run (should not affect anything)
  {
    taskId: 'task-5',
    stage: 'fix',
    backend: 'stub',
    model: 'stub-model',
    tokensIn: 100,
    tokensOut: 50,
    wallMs: 10,
    outcome: 'success',
  },
];

describe('budgets-routes', () => {
  it('aggregates Claude usage from stats store', async () => {
    const statsStore = {
      all: vi.fn().mockResolvedValue(mockStats),
    };

    const res = await handleGetBudgets({ statsStore });
    expect(res.status).toBe(200);

    const body = res.body as BudgetsResponse;
    expect(body.claude).toBeDefined();
    expect(body.claude.totalCalls).toBe(3); // 3 Claude runs
    expect(body.claude.tokensIn).toBe(1000 + 2000 + 5000); // sum of all tokensIn for Claude
    expect(body.claude.tokensOut).toBe(500 + 1000 + 3000); // sum of all tokensOut for Claude
    expect(body.claude.period).toBe('from agent_run_stats (all recorded runs)');

    // Check model breakdown
    expect(body.claude.modelBreakdown).toHaveLength(2);
    const sonnetEntry = body.claude.modelBreakdown.find((m) => m.model === 'claude-sonnet-5');
    expect(sonnetEntry).toEqual({
      model: 'claude-sonnet-5',
      calls: 2,
      tokens: 3000 + 1500, // (1000+500) + (2000+1000)
    });

    const opusEntry = body.claude.modelBreakdown.find((m) => m.model === 'claude-opus-4-8');
    expect(opusEntry).toEqual({
      model: 'claude-opus-4-8',
      calls: 1,
      tokens: 8000, // 5000 + 3000
    });

    // Model breakdown should be sorted by tokens descending
    expect(body.claude.modelBreakdown[0].model).toBe('claude-opus-4-8');
    expect(body.claude.modelBreakdown[1].model).toBe('claude-sonnet-5');
  });

  it('returns zeros when no Claude runs are recorded', async () => {
    const statsStore = {
      all: vi.fn().mockResolvedValue([
        {
          taskId: 'task-1',
          stage: 'plan',
          backend: 'litellm',
          model: 'openrouter/deepseek-v4-pro',
          tokensIn: 1000,
          tokensOut: 500,
          wallMs: 100,
          outcome: 'success',
        },
      ]),
    };

    const res = await handleGetBudgets({ statsStore });
    const body = res.body as BudgetsResponse;
    expect(body.claude.totalCalls).toBe(0);
    expect(body.claude.tokensIn).toBe(0);
    expect(body.claude.tokensOut).toBe(0);
    expect(body.claude.modelBreakdown).toHaveLength(0);
  });

  it('uses "no data yet" period when stats store is empty or absent', async () => {
    const res1 = await handleGetBudgets({ statsStore: { all: vi.fn().mockResolvedValue([]) } });
    const body1 = res1.body as BudgetsResponse;
    expect(body1.claude.period).toBe('no data yet');

    const res2 = await handleGetBudgets({});
    const body2 = res2.body as BudgetsResponse;
    expect(body2.claude.period).toBe('no data yet');
  });

  it('gracefully handles stats store errors', async () => {
    const statsStore = {
      all: vi.fn().mockRejectedValue(new Error('Database connection failed')),
    };

    const res = await handleGetBudgets({ statsStore });
    const body = res.body as BudgetsResponse;
    expect(body.claude.totalCalls).toBe(0);
    expect(body.claude.period).toBe('no data yet');
  });

  it('includes OpenRouter spend data (existing functionality)', async () => {
    const statsStore = {
      all: vi.fn().mockResolvedValue(mockStats),
    };

    const res = await handleGetBudgets({ statsStore });
    const body = res.body as BudgetsResponse;
    expect(body.openRouter).toBeDefined();
    expect(body.openRouter.totalTokens).toBe(5000); // only openrouter runs
    expect(body.openRouter.modelBreakdown).toHaveLength(1);
    expect(body.openRouter.modelBreakdown[0].model).toBe('openrouter/deepseek-v4-pro');
  });
});
