import { describe, expect, it } from 'vitest';
import { PostgresFiledFindingStore } from './postgres-filed-finding-store';
import type { Queryable } from './postgres-stats-store';

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
    if (/RETURNING/i.test(sql)) {
      return { rows: this.rows };
    }
    return { rows: [] };
  }
}

describe('PostgresFiledFindingStore', () => {
  it('ensureSchema issues CREATE TABLE IF NOT EXISTS', async () => {
    const db = new FakeDb();
    const store = new PostgresFiledFindingStore(db);
    await store.ensureSchema();
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toMatch(/CREATE TABLE IF NOT EXISTS filed_findings/);
  });

  it('reserve wins on fresh insert and returns { won: true, issueRef: "" }', async () => {
    const db = new FakeDb();
    db.seedRows([{ issue_ref: '' }]);
    const store = new PostgresFiledFindingStore(db);

    const result = await store.reserve('proj1', 'fp1');

    expect(result).toEqual({ won: true, issueRef: '' });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toMatch(/INSERT INTO filed_findings/);
    expect(db.calls[0].sql).toMatch(/ON CONFLICT/);
    expect(db.calls[0].sql).toMatch(/RETURNING issue_ref/);
    expect(db.calls[0].params).toEqual(['proj1', 'fp1', '15 minutes']);
  });

  it('reserve loses on conflict with finalized row and returns { won: false, issueRef }', async () => {
    const db = new FakeDb();
    db.seedRows([]);
    const store = new PostgresFiledFindingStore(db);

    const result = await store.reserve('proj1', 'fp1');

    expect(result.won).toBe(false);
    expect(db.calls).toHaveLength(2);
    expect(db.calls[0].sql).toMatch(/INSERT INTO filed_findings/);
    expect(db.calls[1].sql).toMatch(/SELECT issue_ref/);
  });

  it('reserve includes stale-reclaim predicate in the UPDATE clause', async () => {
    const db = new FakeDb();
    db.seedRows([]);
    const store = new PostgresFiledFindingStore(db);

    await store.reserve('proj1', 'fp1');

    const insertCall = db.calls[0].sql;
    expect(insertCall).toMatch(/issue_ref = ''.*AND.*last_seen < now\(\) - \(\$3\)::interval/s);
  });

  it('finalize updates issue_ref only if still pending', async () => {
    const db = new FakeDb();
    const store = new PostgresFiledFindingStore(db);

    await store.finalize('proj1', 'fp1', 'ref-123');

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toMatch(/UPDATE filed_findings/);
    expect(db.calls[0].sql).toMatch(/issue_ref = \$3/);
    expect(db.calls[0].sql).toMatch(/AND issue_ref = ''/);
    expect(db.calls[0].params).toEqual(['proj1', 'fp1', 'ref-123']);
  });

  it('release deletes only if still pending', async () => {
    const db = new FakeDb();
    const store = new PostgresFiledFindingStore(db);

    await store.release('proj1', 'fp1');

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toMatch(/DELETE FROM filed_findings/);
    expect(db.calls[0].sql).toMatch(/AND issue_ref = ''/);
    expect(db.calls[0].params).toEqual(['proj1', 'fp1']);
  });
});
