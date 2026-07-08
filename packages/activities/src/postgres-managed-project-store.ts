import { ManagedProjectSchema, UpsertManagedProjectRequestSchema, type ManagedProject, type UpsertManagedProjectRequest } from '@agentops/contracts';
import { encryptForManagedProject } from './credential-crypto';
import type { Queryable } from './postgres-stats-store';

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS managed_projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project TEXT NOT NULL UNIQUE,
    repo TEXT NOT NULL UNIQUE,
    encrypted_token TEXT NOT NULL,
    config JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

interface ManagedProjectRow {
  id: string;
  project: string;
  repo: string;
  encrypted_token: string;
  config: unknown;
  created_at: Date;
  updated_at: Date;
}

function rowToManagedProject(row: ManagedProjectRow): ManagedProject {
  return ManagedProjectSchema.parse({
    id: row.id,
    project: row.project,
    repo: row.repo,
    credentialSet: true,
    config: row.config ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

export class PostgresManagedProjectStore {
  constructor(private readonly db: Queryable) {}

  /** Idempotent -- safe to call every time a process starts, same as PostgresStatsStore. */
  async ensureSchema(): Promise<void> {
    await this.db.query(CREATE_TABLE_SQL);
  }

  private async getRow(repo: string): Promise<ManagedProjectRow | null> {
    const { rows } = await this.db.query('SELECT * FROM managed_projects WHERE repo = $1', [repo]);
    return (rows[0] as ManagedProjectRow | undefined) ?? null;
  }

  async get(repo: string): Promise<ManagedProject | null> {
    const row = await this.getRow(repo);
    return row ? rowToManagedProject(row) : null;
  }

  /** Lookup by the unique `project` slug -- used by control's POST to 409 on a duplicate project name. */
  async getByProject(project: string): Promise<ManagedProject | null> {
    const { rows } = await this.db.query('SELECT * FROM managed_projects WHERE project = $1', [project]);
    const row = rows[0] as ManagedProjectRow | undefined;
    return row ? rowToManagedProject(row) : null;
  }

  /** Raw encrypted blob, or null if unregistered. Decrypt with credential-crypto's decryptForManagedProject -- this class never touches a private key. */
  async getEncryptedToken(repo: string): Promise<string | null> {
    const row = await this.getRow(repo);
    return row?.encrypted_token ?? null;
  }

  async list(): Promise<ManagedProject[]> {
    const { rows } = await this.db.query('SELECT * FROM managed_projects ORDER BY project');
    return (rows as ManagedProjectRow[]).map(rowToManagedProject);
  }

  /**
   * Encrypts with `publicKey` -- this class never accepts or needs a private
   * key. `token` omitted on an existing project keeps its current credential;
   * `config` omitted keeps its current config, `null` clears it to
   * file-based, an object sets it.
   */
  async upsert(input: UpsertManagedProjectRequest, publicKey: string): Promise<ManagedProject> {
    const parsed = UpsertManagedProjectRequestSchema.parse(input);
    const existingRow = await this.getRow(parsed.repo);

    if (!existingRow && !parsed.token) {
      throw new Error(`PostgresManagedProjectStore.upsert: a token is required to create a new project ("${parsed.repo}")`);
    }

    const encryptedToken = parsed.token ? encryptForManagedProject(publicKey, parsed.token) : existingRow!.encrypted_token;
    const config = parsed.config === undefined ? (existingRow?.config ?? null) : parsed.config;

    const { rows } = await this.db.query(
      `INSERT INTO managed_projects (project, repo, encrypted_token, config)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (repo) DO UPDATE SET
         project = EXCLUDED.project,
         encrypted_token = EXCLUDED.encrypted_token,
         config = EXCLUDED.config,
         updated_at = now()
       RETURNING *`,
      [parsed.project, parsed.repo, encryptedToken, config],
    );
    return rowToManagedProject(rows[0] as ManagedProjectRow);
  }

  async remove(repo: string): Promise<void> {
    await this.db.query('DELETE FROM managed_projects WHERE repo = $1', [repo]);
  }
}
