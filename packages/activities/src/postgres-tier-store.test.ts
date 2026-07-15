import { describe, expect, it } from 'vitest';
import { PostgresTierStore } from './postgres-tier-store';
import type { Queryable } from './postgres-stats-store';

// Minimal fake pg pool: records calls + returns scripted rows. Mirrors the
// pattern in postgres-managed-project-store.test.ts / postgres-stats-store.test.ts.
function fakeDb(
  scriptedRows: unknown[] = [],
): Queryable & { calls: { sql: string; params?: unknown[] }[] } {
  const calls: { sql: string; params?: unknown[] }[] = [];
  return {
    calls,
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return { rows: scriptedRows as Record<string, unknown>[] };
    },
  };
}

// Fake pool with connect() -> a fake client that records BEGIN/COMMIT/INSERT,
// so the transactional path is observable.
function fakePool(): Queryable & {
  connect(): Promise<Queryable & { calls: { sql: string; params?: unknown[] }[] }>;
  calls: { sql: string; params?: unknown[] }[];
} {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const client: Queryable & { calls: { sql: string; params?: unknown[] }[] } = {
    calls,
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  return {
    calls,
    async connect() {
      return client;
    },
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
}

describe('PostgresTierStore', () => {
  it('ensures the table and removes unsupported persisted backends', async () => {
    const db = fakeDb();
    const store = new PostgresTierStore(db);
    await store.ensureSchema();
    expect(db.calls).toHaveLength(2);
    expect(db.calls[0].sql).toMatch(/CREATE TABLE IF NOT EXISTS tiers/);
    expect(db.calls[1].sql).toMatch(/DELETE FROM tiers WHERE backend NOT IN/);
  });

  it('loadAll returns tiers grouped by name, ordered by position', async () => {
    const db = fakeDb([
      { tier_name: 'smart', position: 0, backend: 'claude', model: 'opus', effort: 'high' },
      { tier_name: 'smart', position: 1, backend: 'pi', model: 'zai/glm-5.2', effort: null },
      {
        tier_name: 'implementation',
        position: 0,
        backend: 'pi',
        model: 'openrouter/deepseek-v4-flash',
        effort: 'high',
      },
    ]);
    const store = new PostgresTierStore(db);
    const tiers = await store.loadAll();
    expect(tiers.get('smart')).toEqual([
      { backend: 'claude', model: 'opus', effort: 'high' },
      { backend: 'pi', model: 'zai/glm-5.2' },
    ]);
    expect(tiers.get('implementation')).toEqual([
      { backend: 'pi', model: 'openrouter/deepseek-v4-flash', effort: 'high' },
    ]);
  });

  it('loadAll returns an empty map when no rows exist', async () => {
    const db = fakeDb([]);
    const store = new PostgresTierStore(db);
    const tiers = await store.loadAll();
    expect(tiers.size).toBe(0);
  });

  it('replaceAll awaits every insert in position order (no fire-and-forget)', async () => {
    const db = fakeDb();
    const store = new PostgresTierStore(db);
    await store.replaceAll({
      smart: [
        { backend: 'claude', model: 'opus', effort: 'high' },
        { backend: 'pi', model: 'zai/glm-5.2' },
      ],
    });
    // Without connect(): DELETE then one INSERT per entry in position order.
    expect(db.calls[0].sql).toMatch(/^DELETE FROM tiers/);
    const inserts = db.calls.slice(1);
    expect(inserts).toHaveLength(2);
    expect(inserts[0].params).toEqual(['smart', 0, 'claude', 'opus', 'high']);
    expect(inserts[1].params).toEqual(['smart', 1, 'pi', 'zai/glm-5.2', undefined]);
  });

  it('replaceAll wraps DELETE+INSERTs in BEGIN/COMMIT when the db exposes connect()', async () => {
    const pool = fakePool();
    const store = new PostgresTierStore(pool);
    await store.replaceAll({ smart: [{ backend: 'claude', model: 'opus', effort: 'high' }] });
    const sqls = pool.calls.map((c) => c.sql);
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toMatch(/^DELETE FROM tiers/);
    expect(sqls[2]).toMatch(/INSERT INTO tiers/);
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    expect(sqls).not.toContain('ROLLBACK');
  });

  it('replaceAll issues ROLLBACK and rethrows when an INSERT fails mid-transaction', async () => {
    const calls: { sql: string; params?: unknown[] }[] = [];
    let beginCount = 0;
    const client: Queryable = {
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params });
        if (sql === 'BEGIN') beginCount += 1;
        if (sql.startsWith('INSERT')) throw new Error('constraint violation');
        return { rows: [] };
      },
    };
    const pool: Queryable & { connect(): Promise<Queryable> } = {
      connect: async () => client,
      query: async () => ({ rows: [] }),
    };
    const store = new PostgresTierStore(pool);
    await expect(
      store.replaceAll({ smart: [{ backend: 'claude', model: 'opus' }] }),
    ).rejects.toThrow('constraint violation');
    expect(calls.map((c) => c.sql)).toContain('ROLLBACK');
    expect(beginCount).toBe(1); // no retry
  });

  it('seedIfEmpty inserts DEFAULT_TIERS only when the table is empty', async () => {
    const emptyDb = fakeDb([]);
    const emptyStore = new PostgresTierStore(emptyDb);
    const seeded = await emptyStore.seedIfEmpty();
    expect(seeded).toBe(true);
    expect(emptyDb.calls.filter((c) => /INSERT INTO tiers/.test(c.sql)).length).toBeGreaterThan(0);

    const fullDb = fakeDb([
      { tier_name: 'smart', position: 0, backend: 'claude', model: 'opus', effort: null },
    ]);
    const fullStore = new PostgresTierStore(fullDb);
    const seededAgain = await fullStore.seedIfEmpty();
    expect(seededAgain).toBe(false);
    expect(fullDb.calls.some((c) => /INSERT INTO tiers/.test(c.sql))).toBe(false);
  });
});
