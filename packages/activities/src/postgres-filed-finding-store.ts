import type { Queryable } from './postgres-stats-store';
import type { FiledFinding, FiledFindingStore } from './filed-finding-store';

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

const INSERT_SQL = `
  INSERT INTO filed_findings (project, fingerprint, issue_ref, last_seen)
  VALUES ($1, $2, $3, now())
  ON CONFLICT (project, fingerprint) DO UPDATE SET last_seen = now()
`;

const SELECT_SQL = `
  SELECT project, fingerprint, issue_ref FROM filed_findings
  WHERE project = $1 AND fingerprint = $2
`;

export class PostgresFiledFindingStore implements FiledFindingStore {
  constructor(private readonly db: Queryable) {}

  async ensureSchema(): Promise<void> {
    await this.db.query(CREATE_TABLE_SQL);
  }

  async find(project: string, fingerprint: string): Promise<FiledFinding | null> {
    const { rows } = await this.db.query(SELECT_SQL, [project, fingerprint]);
    const row = (rows as Array<{ project: string; fingerprint: string; issue_ref: string }>)[0];
    if (!row) return null;
    return { project: row.project, fingerprint: row.fingerprint, issueRef: row.issue_ref };
  }

  async record(f: FiledFinding): Promise<void> {
    await this.db.query(INSERT_SQL, [f.project, f.fingerprint, f.issueRef]);
  }
}
