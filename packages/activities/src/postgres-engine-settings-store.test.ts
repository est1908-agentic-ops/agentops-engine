import { describe, expect, it } from 'vitest';
import { PostgresEngineSettingsStore, selfHealDefaultsFromEnv } from './postgres-engine-settings-store';
import type { Queryable } from './postgres-stats-store';

function fakeDb(scriptedRows: unknown[] = []): Queryable & { calls: { sql: string; params?: unknown[] }[] } {
  const calls: { sql: string; params?: unknown[] }[] = [];
  let rows = [...scriptedRows];
  return {
    calls,
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (/SELECT id FROM engine_settings/.test(sql) && rows.length === 0) {
        return { rows: [] };
      }
      if (/SELECT self_heal_enabled/.test(sql)) {
        return { rows: rows.length ? rows : [{ self_heal_enabled: true, self_heal_cron: '*/30 * * * *' }] };
      }
      if (/INSERT INTO engine_settings/.test(sql) && params) {
        rows = [{ self_heal_enabled: params[0], self_heal_cron: params[1] }];
      }
      if (/UPDATE engine_settings/.test(sql) && params) {
        rows = [{ self_heal_enabled: params[0], self_heal_cron: params[1] }];
      }
      return { rows };
    },
  };
}

describe('PostgresEngineSettingsStore', () => {
  it('ensureSchema issues CREATE TABLE for engine_settings', async () => {
    const db = fakeDb();
    const store = new PostgresEngineSettingsStore(db);
    await store.ensureSchema();
    expect(db.calls[0].sql).toMatch(/CREATE TABLE IF NOT EXISTS engine_settings/);
  });

  it('seedIfEmpty inserts defaults only when the row is absent', async () => {
    const db = fakeDb([]);
    const store = new PostgresEngineSettingsStore(db);
    const seeded = await store.seedIfEmpty({ enabled: false, cron: '0 * * * *' });
    expect(seeded).toBe(true);
    expect(db.calls.some((c) => c.sql.includes('INSERT INTO engine_settings'))).toBe(true);
    const seededAgain = await store.seedIfEmpty({ enabled: true, cron: '*/30 * * * *' });
    expect(seededAgain).toBe(false);
  });

  it('setSelfHeal updates enabled and returns the new settings', async () => {
    const db = fakeDb([{ self_heal_enabled: true, self_heal_cron: '*/30 * * * *' }]);
    const store = new PostgresEngineSettingsStore(db);
    const next = await store.setSelfHeal({ enabled: false });
    expect(next).toEqual({ enabled: false, cron: '*/30 * * * *' });
  });
});

describe('selfHealDefaultsFromEnv', () => {
  it('defaults enabled to true unless SELF_HEAL_ENABLED is false', () => {
    const prev = process.env.SELF_HEAL_ENABLED;
    delete process.env.SELF_HEAL_ENABLED;
    expect(selfHealDefaultsFromEnv().enabled).toBe(true);
    process.env.SELF_HEAL_ENABLED = 'false';
    expect(selfHealDefaultsFromEnv().enabled).toBe(false);
    if (prev === undefined) delete process.env.SELF_HEAL_ENABLED;
    else process.env.SELF_HEAL_ENABLED = prev;
  });
});