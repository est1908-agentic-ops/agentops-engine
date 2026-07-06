import { RunStatsSchema, type RunStats } from '@agentops/contracts';
import type { StatsStore } from './stats-store';

/**
 * Minimal shape PostgresStatsStore needs -- a real `pg.Pool` satisfies this
 * as-is. Injectable (like K8sJobRunner's BatchV1ApiLike) so tests don't need
 * a real Postgres instance.
 */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS agent_run_stats (
    id BIGSERIAL PRIMARY KEY,
    task_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    backend TEXT NOT NULL,
    model TEXT NOT NULL,
    tokens_in INTEGER NOT NULL,
    tokens_out INTEGER NOT NULL,
    wall_ms INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;
const CREATE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS agent_run_stats_task_id_idx ON agent_run_stats (task_id)
`;

const INSERT_SQL = `
  INSERT INTO agent_run_stats (task_id, stage, backend, model, tokens_in, tokens_out, wall_ms, outcome)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
`;

const SELECT_ALL_SQL = `
  SELECT task_id, stage, backend, model, tokens_in, tokens_out, wall_ms, outcome
  FROM agent_run_stats
  ORDER BY id
`;

interface AgentRunStatsRow {
  task_id: string;
  stage: string;
  backend: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  wall_ms: number;
  outcome: string;
}

export class PostgresStatsStore implements StatsStore {
  constructor(private readonly db: Queryable) {}

  /** Idempotent -- safe to call every time the worker starts. */
  async ensureSchema(): Promise<void> {
    await this.db.query(CREATE_TABLE_SQL);
    await this.db.query(CREATE_INDEX_SQL);
  }

  async record(stats: RunStats): Promise<void> {
    await this.db.query(INSERT_SQL, [
      stats.taskId,
      stats.stage,
      stats.backend,
      stats.model,
      stats.tokensIn,
      stats.tokensOut,
      stats.wallMs,
      stats.outcome,
    ]);
  }

  async all(): Promise<RunStats[]> {
    const { rows } = await this.db.query(SELECT_ALL_SQL);
    return (rows as AgentRunStatsRow[]).map((row) =>
      RunStatsSchema.parse({
        taskId: row.task_id,
        stage: row.stage,
        backend: row.backend,
        model: row.model,
        tokensIn: row.tokens_in,
        tokensOut: row.tokens_out,
        wallMs: row.wall_ms,
        outcome: row.outcome,
      }),
    );
  }
}
