import { DEFAULT_TIERS } from '@agentops/policies';
import { ModelRefSchema, type ModelRef } from '@agentops/contracts';
import type { Queryable } from './postgres-stats-store';

// Queryable + an optional checked-out client for transactions. The worker and
// control both inject a real pg Pool (which has connect()); tests inject a bare
// Queryable (connect() undefined -> we skip the transaction wrapper).
interface ClientLike extends Queryable {
  release?(): void;
}

interface PoolLike extends Queryable {
  connect?(): Promise<ClientLike>;
}

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

// The UNIQUE(tier_name, position) table constraint already creates the unique
// index -- an earlier version duplicated it with a separate CREATE INDEX.

interface TierRow {
  tier_name: string;
  position: number;
  backend: string;
  model: string;
  effort: string | null;
}

function rowToEntry(row: TierRow): ModelRef {
  return ModelRefSchema.parse({
    backend: row.backend as ModelRef['backend'],
    model: row.model,
    ...(row.effort ? { effort: row.effort as ModelRef['effort'] } : {}),
  });
}

function insertEntrySql(): string {
  return 'INSERT INTO tiers (tier_name, position, backend, model, effort) VALUES ($1, $2, $3, $4, $5)';
}

// Postgres-backed tier table (SP3-A). One row per (tier_name, position);
// position defines both primary preference (0) and the session-limit
// fallback order (1, 2, ...). Seeded from DEFAULT_TIERS at startup if empty;
// editable live from Mission Control via /api/tiers. See
// docs/superpowers/specs/2026-07-10-model-tiering-fallback-design.md §5.
export class PostgresTierStore {
  constructor(private readonly db: PoolLike) {}

  /** Idempotent -- safe to call on every startup, same convention as the other stores. */
  async ensureSchema(): Promise<void> {
    await this.db.query(CREATE_TABLE_SQL);
    await this.db.query(
      "DELETE FROM tiers WHERE backend NOT IN ('claude', 'cursor', 'pi', 'codex', 'stub', 'platform')",
    );
  }

  /** Load every tier into an in-memory Map. The worker calls this at startup + on refresh. */
  async loadAll(): Promise<Map<string, ModelRef[]>> {
    const { rows } = await this.db.query(
      'SELECT tier_name, position, backend, model, effort FROM tiers ORDER BY tier_name, position',
    );
    const tiers = new Map<string, ModelRef[]>();
    for (const row of rows as TierRow[]) {
      const entry: ModelRef[] = tiers.get(row.tier_name) ?? [];
      entry.push(rowToEntry(row));
      tiers.set(row.tier_name, entry);
    }
    return tiers;
  }

  /**
   * Replace-all inside a transaction: BEGIN, DELETE, INSERT each entry, COMMIT.
   * Awaits every insert so the method only resolves once the new table is
   * durable -- critical because the worker's 60s refresh does DELETE-then-read,
   * and a half-applied replace would leave it loading an empty table. If the
   * injected db has no connect() (test fake), falls back to sequential awaited
   * queries without a transaction wrapper.
   */
  async replaceAll(tiers: Record<string, ModelRef[]>): Promise<void> {
    const inserts: { sql: string; params: unknown[] }[] = [];
    for (const [tierName, entries] of Object.entries(tiers)) {
      entries.forEach((entry, position) => {
        inserts.push({
          sql: insertEntrySql(),
          params: [tierName, position, entry.backend, entry.model, entry.effort],
        });
      });
    }
    if (!this.db.connect) {
      await this.db.query('DELETE FROM tiers');
      for (const ins of inserts) await this.db.query(ins.sql, ins.params);
      return;
    }
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM tiers');
      for (const ins of inserts) await client.query(ins.sql, ins.params);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release?.();
    }
  }

  /**
   * Seed DEFAULT_TIERS only when the table is empty. Returns true if it seeded.
   * Lets an operator's edits survive a worker restart -- the seed never
   * clobbers existing rows. Awaits all inserts.
   */
  async seedIfEmpty(): Promise<boolean> {
    const { rows } = await this.db.query('SELECT tier_name FROM tiers LIMIT 1');
    if (rows.length > 0) {
      return false;
    }
    for (const [tierName, entries] of Object.entries(DEFAULT_TIERS)) {
      for (const [position, entry] of entries.entries()) {
        await this.db.query(insertEntrySql(), [
          tierName,
          position,
          entry.backend,
          entry.model,
          entry.effort,
        ]);
      }
    }
    return true;
  }
}
