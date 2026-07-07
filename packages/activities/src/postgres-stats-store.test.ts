import { describe, expect, it } from 'vitest';
import { PostgresStatsStore, type Queryable } from './postgres-stats-store';

class FakeDb implements Queryable {
  readonly calls: { sql: string; params?: unknown[] }[] = [];
  private rows: unknown[] = [];

  seedRows(rows: unknown[]): void {
    this.rows = rows;
  }

  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    this.calls.push({ sql, params });
    if (/^\s*SELECT/i.test(sql)) {
      return { rows: this.rows };
    }
    return { rows: [] };
  }
}

describe('PostgresStatsStore', () => {
  it('ensureSchema issues idempotent CREATE TABLE / CREATE INDEX statements', async () => {
    const db = new FakeDb();
    const store = new PostgresStatsStore(db);
    await store.ensureSchema();
    expect(db.calls).toHaveLength(2);
    expect(db.calls[0].sql).toMatch(/CREATE TABLE IF NOT EXISTS agent_run_stats/);
    expect(db.calls[1].sql).toMatch(/CREATE INDEX IF NOT EXISTS/);
  });

  it('record issues a parameterized INSERT with the right values in order', async () => {
    const db = new FakeDb();
    const store = new PostgresStatsStore(db);
    await store.record({
      taskId: 't1',
      stage: 'implement',
      backend: 'stub',
      model: 'stub-v1',
      tokensIn: 12,
      tokensOut: 34,
      wallMs: 500,
      outcome: 'pass',
    });

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toMatch(/INSERT INTO agent_run_stats/);
    expect(db.calls[0].params).toEqual(['t1', 'implement', 'stub', 'stub-v1', 12, 34, 500, 'pass']);
  });

  it('all() maps rows back into validated RunStats objects', async () => {
    const db = new FakeDb();
    db.seedRows([
      {
        task_id: 't1',
        stage: 'implement',
        backend: 'stub',
        model: 'stub-v1',
        tokens_in: 12,
        tokens_out: 34,
        wall_ms: 500,
        outcome: 'pass',
      },
    ]);
    const store = new PostgresStatsStore(db);

    const all = await store.all();
    expect(all).toEqual([
      {
        taskId: 't1',
        stage: 'implement',
        backend: 'stub',
        model: 'stub-v1',
        tokensIn: 12,
        tokensOut: 34,
        wallMs: 500,
        outcome: 'pass',
      },
    ]);
  });

  it('all() throws if a row does not satisfy RunStatsSchema (schema drift guard)', async () => {
    const db = new FakeDb();
    db.seedRows([
      {
        task_id: 't1',
        stage: 'not-a-real-stage',
        backend: 'stub',
        model: 'x',
        tokens_in: 0,
        tokens_out: 0,
        wall_ms: 0,
        outcome: 'pass',
      },
    ]);
    const store = new PostgresStatsStore(db);

    await expect(store.all()).rejects.toThrow();
  });
});
