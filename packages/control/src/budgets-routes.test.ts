import { describe, expect, it } from 'vitest';
import { type BudgetsResponse, type RunStats } from '@agentops/contracts';
import { handleGetBudgets } from './budgets-routes';

describe('handleGetBudgets', () => {
  it('aggregates Claude rows and excludes non-Claude rows', async () => {
    const claudeRows: RunStats[] = [
      {
        backend: 'claude',
        model: 'claude-opus-4-8',
        tokensIn: 300,
        tokensOut: 200,
      } as RunStats,
      {
        backend: 'claude',
        model: 'claude-sonnet-5',
        tokensIn: 150,
        tokensOut: 100,
      } as RunStats,
    ];

    const otherRows: RunStats[] = [
      {
        backend: 'openrouter',
        model: 'openrouter/deepseek-v4-pro',
        tokensIn: 500,
        tokensOut: 300,
      } as RunStats,
    ];

    const allRows = [...claudeRows, ...otherRows];

    const deps = {
      statsStore: {
        all: async () => allRows,
      },
    };

    const response = await handleGetBudgets(deps);

    expect(response.status).toBe(200);
    const body = response.body as BudgetsResponse;

    // Check Claude aggregation
    expect(body.claude.totalTokens).toBe(750); // (300+200) + (150+100)
    expect(body.claude.tokensIn).toBe(450); // 300 + 150
    expect(body.claude.tokensOut).toBe(300); // 200 + 100
    expect(body.claude.calls).toBe(2); // 2 Claude rows
    expect(body.claude.period).toBe('from agent_run_stats (all recorded runs)');

    // Check Claude model breakdown is sorted by tokens descending
    expect(body.claude.modelBreakdown).toHaveLength(2);
    expect(body.claude.modelBreakdown[0].model).toBe('claude-opus-4-8');
    expect(body.claude.modelBreakdown[0].tokens).toBe(500);
    expect(body.claude.modelBreakdown[0].calls).toBe(1);
    expect(body.claude.modelBreakdown[1].model).toBe('claude-sonnet-5');
    expect(body.claude.modelBreakdown[1].tokens).toBe(250);
    expect(body.claude.modelBreakdown[1].calls).toBe(1);

    // Ensure no estimatedUsd anywhere in Claude block
    expect(body.claude).not.toHaveProperty('estimatedUsd');
    expect(body.claude.modelBreakdown[0]).not.toHaveProperty('estimatedUsd');

    // Check OpenRouter section is still correct
    expect(body.openRouter.totalTokens).toBe(800);
  });

  it('handles fallback Claude detection via model name', async () => {
    const rows: RunStats[] = [
      {
        backend: 'unknown',
        model: 'claude-haiku-4-5-20251001',
        tokensIn: 100,
        tokensOut: 50,
      } as RunStats,
    ];

    const deps = {
      statsStore: {
        all: async () => rows,
      },
    };

    const response = await handleGetBudgets(deps);

    expect(response.status).toBe(200);
    const body = response.body as BudgetsResponse;

    expect(body.claude.totalTokens).toBe(150);
    expect(body.claude.calls).toBe(1);
    expect(body.claude.modelBreakdown).toHaveLength(1);
    expect(body.claude.modelBreakdown[0].model).toBe('claude-haiku-4-5-20251001');
  });

  it('degrades gracefully when statsStore is absent', async () => {
    const deps = {};

    const response = await handleGetBudgets(deps);

    expect(response.status).toBe(200);
    const body = response.body as BudgetsResponse;

    expect(body.claude.totalTokens).toBe(0);
    expect(body.claude.tokensIn).toBe(0);
    expect(body.claude.tokensOut).toBe(0);
    expect(body.claude.calls).toBe(0);
    expect(body.claude.period).toBe('no data yet');
    expect(body.claude.modelBreakdown).toEqual([]);
  });

  it('degrades gracefully when statsStore.all() throws', async () => {
    const deps = {
      statsStore: {
        all: async () => {
          throw new Error('database connection failed');
        },
      },
    };

    const response = await handleGetBudgets(deps);

    expect(response.status).toBe(200);
    const body = response.body as BudgetsResponse;

    expect(body.claude.totalTokens).toBe(0);
    expect(body.claude.calls).toBe(0);
    expect(body.claude.period).toBe('no data yet');
    expect(body.claude.modelBreakdown).toEqual([]);
  });

  it('handles empty rows gracefully', async () => {
    const deps = {
      statsStore: {
        all: async () => [],
      },
    };

    const response = await handleGetBudgets(deps);

    expect(response.status).toBe(200);
    const body = response.body as BudgetsResponse;

    expect(body.claude.period).toBe('no data yet');
    expect(body.claude.modelBreakdown).toEqual([]);
    expect(body.openRouter.period).toBe('no data yet');
    expect(body.openRouter.modelBreakdown).toEqual([]);
  });
});
