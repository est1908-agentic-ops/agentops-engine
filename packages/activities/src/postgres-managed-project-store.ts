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

// Additive-only schema evolution (docs/superpowers/specs/2026-07-08-managed-project-registry-design.md
// §4.1): each ALTER is its own idempotent, unconditional statement run right
// after CREATE TABLE on every startup. tracker_type defaults to 'github' so
// every row written before this column existed stays valid unchanged. The
// partial unique index only constrains linear-tracked rows -- NULL
// linear_team_key values (every github-tracked row) are never compared for
// uniqueness by Postgres, so github rows don't collide with each other on
// this column.
const ALTER_TABLE_STATEMENTS = [
  `ALTER TABLE managed_projects ADD COLUMN IF NOT EXISTS tracker_type TEXT NOT NULL DEFAULT 'github'`,
  `ALTER TABLE managed_projects ADD COLUMN IF NOT EXISTS encrypted_linear_token TEXT`,
  `ALTER TABLE managed_projects ADD COLUMN IF NOT EXISTS linear_team_key TEXT`,
  `ALTER TABLE managed_projects ADD COLUMN IF NOT EXISTS linear_trigger_label_id TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS managed_projects_linear_team_key_key ON managed_projects (linear_team_key) WHERE linear_team_key IS NOT NULL`,
];

interface ManagedProjectRow {
  id: string;
  project: string;
  repo: string;
  encrypted_token: string;
  tracker_type: string;
  encrypted_linear_token: string | null;
  linear_team_key: string | null;
  linear_trigger_label_id: string | null;
  config: unknown;
  created_at: Date;
  updated_at: Date;
}

function rowToManagedProject(row: ManagedProjectRow): ManagedProject {
  const base = {
    id: row.id,
    project: row.project,
    repo: row.repo,
    credentialSet: true,
    config: row.config ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
  if (row.tracker_type === 'linear') {
    return ManagedProjectSchema.parse({
      ...base,
      trackerType: 'linear',
      linearTeamKey: row.linear_team_key,
      linearTriggerLabelId: row.linear_trigger_label_id,
      linearCredentialSet: Boolean(row.encrypted_linear_token),
    });
  }
  return ManagedProjectSchema.parse({ ...base, trackerType: 'github' });
}

export class PostgresManagedProjectStore {
  constructor(private readonly db: Queryable) {}

  /** Idempotent -- safe to call every time a process starts, same as PostgresStatsStore. */
  async ensureSchema(): Promise<void> {
    await this.db.query(CREATE_TABLE_SQL);
    for (const statement of ALTER_TABLE_STATEMENTS) {
      await this.db.query(statement);
    }
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

  /** Lookup by the unique `linear_team_key` -- how the gateway routes a Linear webhook to a project. */
  async getByLinearTeamKey(teamKey: string): Promise<ManagedProject | null> {
    const { rows } = await this.db.query('SELECT * FROM managed_projects WHERE linear_team_key = $1', [teamKey]);
    const row = rows[0] as ManagedProjectRow | undefined;
    return row ? rowToManagedProject(row) : null;
  }

  /** Raw encrypted blob, or null if unregistered. Decrypt with credential-crypto's decryptForManagedProject -- this class never touches a private key. */
  async getEncryptedToken(repo: string): Promise<string | null> {
    const row = await this.getRow(repo);
    return row?.encrypted_token ?? null;
  }

  /** Raw encrypted Linear-token blob, or null if unregistered / not linear-tracked / never set. */
  async getEncryptedLinearToken(repo: string): Promise<string | null> {
    const row = await this.getRow(repo);
    return row?.encrypted_linear_token ?? null;
  }

  async list(): Promise<ManagedProject[]> {
    const { rows } = await this.db.query('SELECT * FROM managed_projects ORDER BY project');
    return (rows as ManagedProjectRow[]).map(rowToManagedProject);
  }

  /**
   * Encrypts with `publicKey` -- this class never accepts or needs a private
   * key. `token`/`linearToken` omitted on an existing project keep their
   * current credential; `config` omitted keeps its current config, `null`
   * clears it to file-based, an object sets it. `trackerType` is immutable
   * once a row exists (like `project`/`repo`) -- always taken from the
   * existing row on update, never from `input`, so a caller can't silently
   * flip a project's tracker by omitting the field.
   */
  async upsert(input: UpsertManagedProjectRequest, publicKey: string): Promise<ManagedProject> {
    const parsed = UpsertManagedProjectRequestSchema.parse(input);
    const existingRow = await this.getRow(parsed.repo);
    const trackerType = existingRow?.tracker_type ?? parsed.trackerType;

    if (!existingRow && !parsed.token) {
      throw new Error(`PostgresManagedProjectStore.upsert: a token is required to create a new project ("${parsed.repo}")`);
    }
    if (!existingRow && trackerType === 'linear' && (!parsed.linearTeamKey || !parsed.linearTriggerLabelId || !parsed.linearToken)) {
      throw new Error(
        `PostgresManagedProjectStore.upsert: linearTeamKey, linearTriggerLabelId, and linearToken are all required to create a new linear-tracked project ("${parsed.repo}")`,
      );
    }
    if (existingRow && trackerType !== 'linear' && (parsed.linearTeamKey || parsed.linearTriggerLabelId || parsed.linearToken)) {
      throw new Error(`PostgresManagedProjectStore.upsert: project "${parsed.repo}" is not linear-tracked -- cannot set linear fields on it`);
    }

    const encryptedToken = parsed.token ? encryptForManagedProject(publicKey, parsed.token) : existingRow!.encrypted_token;
    const config = parsed.config === undefined ? (existingRow?.config ?? null) : parsed.config;
    const linearTeamKey = trackerType === 'linear' ? parsed.linearTeamKey ?? existingRow?.linear_team_key ?? null : null;
    const linearTriggerLabelId = trackerType === 'linear' ? parsed.linearTriggerLabelId ?? existingRow?.linear_trigger_label_id ?? null : null;
    const encryptedLinearToken =
      trackerType === 'linear'
        ? parsed.linearToken
          ? encryptForManagedProject(publicKey, parsed.linearToken)
          : existingRow?.encrypted_linear_token ?? null
        : null;

    const { rows } = await this.db.query(
      `INSERT INTO managed_projects (project, repo, encrypted_token, config, tracker_type, encrypted_linear_token, linear_team_key, linear_trigger_label_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (repo) DO UPDATE SET
         project = EXCLUDED.project,
         encrypted_token = EXCLUDED.encrypted_token,
         config = EXCLUDED.config,
         encrypted_linear_token = EXCLUDED.encrypted_linear_token,
         linear_team_key = EXCLUDED.linear_team_key,
         linear_trigger_label_id = EXCLUDED.linear_trigger_label_id,
         updated_at = now()
       RETURNING *`,
      [parsed.project, parsed.repo, encryptedToken, config, trackerType, encryptedLinearToken, linearTeamKey, linearTriggerLabelId],
    );
    return rowToManagedProject(rows[0] as ManagedProjectRow);
  }

  async remove(repo: string): Promise<void> {
    await this.db.query('DELETE FROM managed_projects WHERE repo = $1', [repo]);
  }
}
