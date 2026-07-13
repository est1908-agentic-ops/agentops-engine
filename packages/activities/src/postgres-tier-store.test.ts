import { describe, expect, it } from 'vitest';
import { PostgresTierStore } from './postgres-tier-store';
import type { Queryable } from './postgres-stats-store';

// Minimal fake pg pool: records calls + returns scripted rows. Mirrors the
// pattern in postgres-managed-project-store.test.ts / postgres-stats-store.test.ts.
function fakeDb(scriptedRows: unknown[] = []): Queryable & { calls: { sql: string; params?: unknown[] }[] } {
  const calls: { sql: string; params?: unknown[] }[] = [];
  return {
    calls,
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return { rows: scriptedRows as Record<string, unknown>[] };
    },
  };
}

describe('PostgresTierStore', () => {
  it('ensureSchema issues an idempotent CREATE TABLE + unique-position index', async () => {
    const db = fakeDb();
    const store = new PostgresTierStore(db);
    await store.ensureSchema();
    expect(db.calls[0].sql).toMatch(/CREATE TABLE IF NOT EXISTS tiers/);
    expect(db.calls[1].sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS tiers_name_position/);
    // All statements are idempotent (IF NOT EXISTS) so re-running on startup is safe.
    expect(db.calls.every((c) => /IF NOT EXISTS/.test(c.sql))).toBe(true);
  });

  it('loadAll returns tiers grouped by name, ordered by position', async () => {
    const db = fakeDb([
      { tier_name: 'smart', position: 0, backend: 'claude', model: 'opus', effort: 'high' },
      { tier_name: 'smart', position: 1, backend: 'pi', model: 'zai/glm-5.2', effort: null },
      { tier_name: 'implementation', position: 0, backend: 'pi', model: 'openrouter/deepseek-v4-flash', effort: 'high' },
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

  it('replaceAll deletes all rows then inserts the new set, ordered by position', async () => {
    const db = fakeDb([]);
    const store = new PostgresTierStore(db);
    await store.replaceAll({
      smart: [
        { backend: 'claude', model: 'opus', effort: 'high' },
        { backend: 'pi', model: 'zai/glm-5.2' },
      ],
    });
    // First a DELETE, then one INSERT per entry in position order.
    expect(db.calls[0].sql).toMatch(/^DELETE FROM tiers/);
    const inserts = db.calls.slice(1);
    expect(inserts).toHaveLength(2);
    expect(inserts[0].params).toEqual(['smart', 0, 'claude', 'opus', 'high']);
    expect(inserts[1].params).toEqual(['smart', 1, 'pi', 'zai/glm-5.2', undefined]);
  });

  it('seedIfEmpty inserts DEFAULT_TIERS only when the table is empty', async () => {
    // Empty table -> seeds.
    const emptyDb = fakeDb([]);
    const emptyStore = new PostgresTierStore(emptyDb);
    const seeded = await emptyStore.seedIfEmpty();
    expect(seeded).toBe(true);
    expect(emptyDb.calls.filter((c) => /INSERT INTO tiers/.test(c.sql)).length).toBeGreaterThan(0);

    // Non-empty table -> no-op.
    const fullDb = fakeDb([{ tier_name: 'smart', position: 0, backend: 'claude', model: 'opus', effort: null }]);
    const fullStore = new PostgresTierStore(fullDb);
    const seededAgain = await fullStore.seedIfEmpty();
    expect(seededAgain).toBe(false);
    expect(fullDb.calls.some((c) => /INSERT INTO tiers/.test(c.sql))).toBe(false);
  });
});
