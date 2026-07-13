import { DEFAULT_TIERS } from '@agentops/policies';
import type { ModelRef } from '@agentops/contracts';
import type { Queryable } from './postgres-stats-store';

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS tiers (
    id SERIAL PRIMARY KEY,
    tier_name TEXT NOT NULL,
    position INT NOT NULL,
    backend TEXT NOT NULL,
    model TEXT NOT NULL,
    effort TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tier_name, position)
  )
`;

const CREATE_INDEX_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS tiers_name_position ON tiers (tier_name, position)`;

interface TierRow {
  tier_name: string;
  position: number;
  backend: string;
  model: string;
  effort: string | null;
}

// Postgres-backed tier table (SP3-A). One row per (tier_name, position);
// position defines both primary preference (0) and the session-limit
// fallback order (1, 2, ...). Seeded from DEFAULT_TIERS at startup if empty;
// editable live from Mission Control via /api/tiers. See
// docs/superpowers/specs/2026-07-10-model-tiering-fallback-design.md §5.
export class PostgresTierStore {
  constructor(private readonly db: Queryable) {}

  /** Idempotent -- safe to call on every startup, same convention as the other stores. */
  async ensureSchema(): Promise<void> {
    await this.db.query(CREATE_TABLE_SQL);
    await this.db.query(CREATE_INDEX_SQL);
  }

  /** Load every tier into an in-memory Map. The worker calls this at startup + on refresh. */
  async loadAll(): Promise<Map<string, ModelRef[]>> {
    const { rows } = await this.db.query('SELECT tier_name, position, backend, model, effort FROM tiers ORDER BY tier_name, position');
    const tiers = new Map<string, ModelRef[]>();
    for (const row of rows as TierRow[]) {
      const entry: ModelRef[] = tiers.get(row.tier_name) ?? [];
      entry.push({
        backend: row.backend as ModelRef['backend'],
        model: row.model,
        ...(row.effort ? { effort: row.effort as ModelRef['effort'] } : {}),
      });
      tiers.set(row.tier_name, entry);
    }
    return tiers;
  }

  /** Replace-all (delete-then-insert). Used by /api/tiers PUT. Validation runs in control. */
  async replaceAll(tiers: Record<string, ModelRef[]>): Promise<void> {
    await this.db.query('DELETE FROM tiers');
    for (const [tierName, entries] of Object.entries(tiers)) {
      entries.forEach((entry, position) => {
        // Param order matches INSERT columns below: tier_name, position, backend, model, effort.
        void this.db.query(
          'INSERT INTO tiers (tier_name, position, backend, model, effort) VALUES ($1, $2, $3, $4, $5)',
          [tierName, position, entry.backend, entry.model, entry.effort],
        );
      });
    }
  }

  /**
   * Seed DEFAULT_TIERS only when the table is empty. Returns true if it seeded.
   * Lets an operator's edits survive a worker restart -- the seed never
   * clobbers existing rows.
   */
  async seedIfEmpty(): Promise<boolean> {
    const { rows } = await this.db.query('SELECT tier_name FROM tiers LIMIT 1');
    if (rows.length > 0) {
      return false;
    }
    for (const [tierName, entries] of Object.entries(DEFAULT_TIERS)) {
      entries.forEach((entry, position) => {
        void this.db.query(
          'INSERT INTO tiers (tier_name, position, backend, model, effort) VALUES ($1, $2, $3, $4, $5)',
          [tierName, position, entry.backend, entry.model, entry.effort],
        );
      });
    }
    return true;
  }
}
