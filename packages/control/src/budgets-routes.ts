import { BudgetsResponseSchema, type RunStats } from '@agentops/contracts';
import type { HandlerResponse } from './handler-util';

export interface BudgetsRouteDeps {
  // Optional stats reader (backed by PostgresStatsStore when ENGINE_DB_HOST is set).
  // We only use .all() for the simple slice; aggregation happens in the handler.
  statsStore?: { all(): Promise<RunStats[]> };
}

const OPENROUTER_PRICE_PER_M: Record<string, { prompt: number; completion: number }> = {
  // Example prices in USD per million tokens. These are illustrative and
  // will be replaced by live provider data in the follow-up. Update as needed.
  'openrouter/deepseek-v4-pro': { prompt: 0.5, completion: 1.5 },
  'openrouter/deepseek-v4-flash': { prompt: 0.1, completion: 0.3 },
  // Fallback for any other openrouter/* model
  default: { prompt: 0.3, completion: 1.0 },
};

function getPrice(model: string) {
  const key = Object.keys(OPENROUTER_PRICE_PER_M).find((k) =>
    model.toLowerCase().includes(k.replace('openrouter/', '')),
  );
  return (
    OPENROUTER_PRICE_PER_M[key as keyof typeof OPENROUTER_PRICE_PER_M] ??
    OPENROUTER_PRICE_PER_M.default
  );
}

function parseRateWindow(prefix: string): {
  maxCalls: number;
  windowHours: number;
  configured: boolean;
} {
  const maxCalls = Number(process.env[`${prefix}_RATE_WINDOW_MAX_CALLS`] ?? '0');
  const windowMs = Number(process.env[`${prefix}_RATE_WINDOW_MS`] ?? '0');
  const windowHours = windowMs > 0 ? windowMs / (1000 * 60 * 60) : 0;
  const configured = maxCalls > 0 && windowHours > 0;
  return { maxCalls: configured ? maxCalls : 0, windowHours, configured };
}

export async function handleGetBudgets(deps: BudgetsRouteDeps): Promise<HandlerResponse> {
  const rateWindows = {
    claude: parseRateWindow('CLAUDE'),
    pi: parseRateWindow('PI'),
  };

  let rows: RunStats[] = [];
  if (deps.statsStore) {
    try {
      rows = await deps.statsStore.all();
    } catch {
      // best effort; treat as empty
      rows = [];
    }
  }

  // Claude usage aggregation (from rows where backend === 'claude')
  const claudeRows = rows.filter((r) => r.backend === 'claude');
  const claudeByModel: Record<string, { calls: number; tokensIn: number; tokensOut: number }> = {};
  let claudeTotalCalls = 0;
  let claudeTotalTokensIn = 0;
  let claudeTotalTokensOut = 0;

  for (const r of claudeRows) {
    claudeTotalCalls += 1;
    claudeTotalTokensIn += r.tokensIn ?? 0;
    claudeTotalTokensOut += r.tokensOut ?? 0;
    if (!claudeByModel[r.model]) {
      claudeByModel[r.model] = { calls: 0, tokensIn: 0, tokensOut: 0 };
    }
    claudeByModel[r.model].calls += 1;
    claudeByModel[r.model].tokensIn += r.tokensIn ?? 0;
    claudeByModel[r.model].tokensOut += r.tokensOut ?? 0;
  }

  const claudeModelBreakdown = Object.entries(claudeByModel)
    .map(([model, { calls, tokensIn, tokensOut }]) => ({
      model,
      calls,
      tokens: tokensIn + tokensOut,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  // OpenRouter spend aggregation (existing logic)
  const orRows = rows.filter((r) => r.model.toLowerCase().includes('openrouter'));

  let totalTokens = 0;
  const byModel: Record<string, number> = {};
  for (const r of orRows) {
    const t = (r.tokensIn ?? 0) + (r.tokensOut ?? 0);
    totalTokens += t;
    byModel[r.model] = (byModel[r.model] ?? 0) + t;
  }

  let estimatedUsd = 0;
  const modelBreakdown = Object.entries(byModel).map(([model, tokens]) => {
    const price = getPrice(model);
    // tokens / 1_000_000 * price
    const usd = ((tokens / 1_000_000) * (price.prompt + price.completion)) / 2; // conservative average of in/out
    estimatedUsd += usd;
    return { model, tokens, estimatedUsd: Number(usd.toFixed(6)) };
  });

  const body = {
    rateWindows,
    claude: {
      totalCalls: claudeTotalCalls,
      tokensIn: claudeTotalTokensIn,
      tokensOut: claudeTotalTokensOut,
      period: rows.length > 0 ? 'from agent_run_stats (all recorded runs)' : 'no data yet',
      modelBreakdown: claudeModelBreakdown,
    },
    openRouter: {
      estimatedUsd: Number(estimatedUsd.toFixed(6)),
      totalTokens,
      period: rows.length > 0 ? 'from agent_run_stats (all recorded runs)' : 'no data yet',
      modelBreakdown: modelBreakdown.sort((a, b) => b.tokens - a.tokens),
    },
  };

  return { status: 200, body: BudgetsResponseSchema.parse(body) };
}
