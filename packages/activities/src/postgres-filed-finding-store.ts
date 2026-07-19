import type { Queryable } from './postgres-stats-store';
import type { FiledFindingStore } from './filed-finding-store';

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS filed_findings (
    project TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    issue_ref TEXT NOT NULL,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project, fingerprint)
  )
`;

const STALE_RESERVATION = '15 minutes';

export class PostgresFiledFindingStore implements FiledFindingStore {
  constructor(private readonly db: Queryable) {}

  async ensureSchema(): Promise<void> {
    await this.db.query(CREATE_TABLE_SQL);
  }

  async reserve(
    project: string,
    fingerprint: string,
  ): Promise<{ won: boolean; issueRef: string }> {
    const insertResult = await this.db.query(
      `
      INSERT INTO filed_findings (project, fingerprint, issue_ref, last_seen)
      VALUES ($1, $2, '', now())
      ON CONFLICT (project, fingerprint) DO UPDATE SET last_seen = now()
        WHERE filed_findings.issue_ref = ''
          AND filed_findings.last_seen < now() - ($3)::interval
      RETURNING issue_ref
      `,
      [project, fingerprint, STALE_RESERVATION],
    );

    if (insertResult.rows.length > 0) {
      return { won: true, issueRef: '' };
    }

    const selectResult = await this.db.query(
      `SELECT issue_ref FROM filed_findings WHERE project = $1 AND fingerprint = $2`,
      [project, fingerprint],
    );
    const row = (selectResult.rows as Array<{ issue_ref: string }>)[0];
    return { won: false, issueRef: row?.issue_ref ?? '' };
  }

  async finalize(project: string, fingerprint: string, issueRef: string): Promise<void> {
    await this.db.query(
      `UPDATE filed_findings SET issue_ref = $3, last_seen = now() WHERE project = $1 AND fingerprint = $2 AND issue_ref = ''`,
      [project, fingerprint, issueRef],
    );
  }

  async release(project: string, fingerprint: string): Promise<void> {
    await this.db.query(
      `DELETE FROM filed_findings WHERE project = $1 AND fingerprint = $2 AND issue_ref = ''`,
      [project, fingerprint],
    );
  }
}
