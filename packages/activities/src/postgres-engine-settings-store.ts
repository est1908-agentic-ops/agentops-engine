import type { SelfHealSettings } from '@agentops/contracts';
import type { Queryable } from './postgres-stats-store';

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS engine_settings (
    id INT PRIMARY KEY DEFAULT 1,
    self_heal_enabled BOOLEAN NOT NULL,
    self_heal_cron TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT engine_settings_singleton CHECK (id = 1)
  )
`;

interface SettingsRow {
  self_heal_enabled: boolean;
  self_heal_cron: string;
}

function rowToSettings(row: SettingsRow): SelfHealSettings {
  return { enabled: row.self_heal_enabled, cron: row.self_heal_cron };
}

/** First-boot seed when engine_settings is empty (DB is the only source of truth). */
export const DEFAULT_SELF_HEAL_SETTINGS: SelfHealSettings = {
  enabled: true,
  cron: '*/30 * * * *',
};

// Postgres-backed engine operator settings (M6 self-heal toggle). A single-row
// table edited from Mission Control; the worker reads it on boot so UI changes
// survive restarts.
export class PostgresEngineSettingsStore {
  constructor(private readonly db: Queryable) {}

  async ensureSchema(): Promise<void> {
    await this.db.query(CREATE_TABLE_SQL);
  }

  async getSelfHeal(): Promise<SelfHealSettings> {
    const { rows } = await this.db.query(
      'SELECT self_heal_enabled, self_heal_cron FROM engine_settings WHERE id = 1',
    );
    if (rows.length === 0) {
      throw new Error('engine_settings row missing — call seedIfEmpty first');
    }
    return rowToSettings(rows[0] as SettingsRow);
  }

  async setSelfHeal(patch: Partial<SelfHealSettings>): Promise<SelfHealSettings> {
    const current = await this.getSelfHeal();
    const next: SelfHealSettings = {
      enabled: patch.enabled ?? current.enabled,
      cron: patch.cron ?? current.cron,
    };
    await this.db.query(
      `UPDATE engine_settings
       SET self_heal_enabled = $1, self_heal_cron = $2, updated_at = now()
       WHERE id = 1`,
      [next.enabled, next.cron],
    );
    return next;
  }

  /** Seed the singleton row when the table is empty. */
  async seedIfEmpty(): Promise<boolean> {
    const { rows } = await this.db.query('SELECT id FROM engine_settings WHERE id = 1');
    if (rows.length > 0) {
      return false;
    }
    await this.db.query(
      'INSERT INTO engine_settings (id, self_heal_enabled, self_heal_cron) VALUES (1, $1, $2)',
      [DEFAULT_SELF_HEAL_SETTINGS.enabled, DEFAULT_SELF_HEAL_SETTINGS.cron],
    );
    return true;
  }
}