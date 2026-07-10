import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { generateManagedProjectKeyPair, decryptForManagedProject } from './credential-crypto';
import { PostgresManagedProjectStore } from './postgres-managed-project-store';
import type { Queryable } from './postgres-stats-store';

interface FakeRow {
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

// A tiny fake Postgres that's just enough to exercise INSERT/SELECT/UPDATE/
// DELETE/ON CONFLICT for this one table -- not a general SQL engine.
function createFakeDb(): Queryable {
  const rows: FakeRow[] = [];

  return {
    async query(sql: string, params: unknown[] = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (normalized.startsWith('CREATE TABLE') || normalized.startsWith('ALTER TABLE') || normalized.startsWith('CREATE UNIQUE INDEX')) {
        return { rows: [] };
      }
      if (normalized.startsWith('SELECT * FROM managed_projects WHERE project')) {
        const [project] = params as [string];
        const found = rows.filter((r) => r.project === project);
        return { rows: found };
      }
      if (normalized.startsWith('SELECT * FROM managed_projects WHERE linear_team_key')) {
        const [teamKey] = params as [string];
        const found = rows.filter((r) => r.linear_team_key === teamKey);
        return { rows: found };
      }
      if (normalized.startsWith('SELECT * FROM managed_projects WHERE repo')) {
        const [repo] = params as [string];
        const found = rows.filter((r) => r.repo === repo);
        return { rows: found };
      }
      if (normalized.startsWith('SELECT * FROM managed_projects ORDER BY project')) {
        return { rows: [...rows].sort((a, b) => a.project.localeCompare(b.project)) };
      }
      if (normalized.startsWith('INSERT INTO managed_projects')) {
        const [project, repo, encryptedToken, config, trackerType, encryptedLinearToken, linearTeamKey, linearTriggerLabelId] = params as [
          string,
          string,
          string,
          unknown,
          string,
          string | null,
          string | null,
          string | null,
        ];
        const existingIndex = rows.findIndex((r) => r.repo === repo);
        const now = new Date();
        const patch = {
          project,
          encrypted_token: encryptedToken,
          config,
          tracker_type: trackerType,
          encrypted_linear_token: encryptedLinearToken,
          linear_team_key: linearTeamKey,
          linear_trigger_label_id: linearTriggerLabelId,
          updated_at: now,
        };
        if (existingIndex >= 0) {
          rows[existingIndex] = { ...rows[existingIndex], ...patch };
          return { rows: [rows[existingIndex]] };
        }
        const row: FakeRow = { id: randomUUID(), repo, created_at: now, ...patch };
        rows.push(row);
        return { rows: [row] };
      }
      if (normalized.startsWith('DELETE FROM managed_projects')) {
        const [repo] = params as [string];
        const index = rows.findIndex((r) => r.repo === repo);
        if (index >= 0) {
          rows.splice(index, 1);
        }
        return { rows: [] };
      }
      throw new Error(`createFakeDb: unhandled query: ${normalized}`);
    },
  };
}

describe('PostgresManagedProjectStore', () => {
  it('returns null for an unregistered repo', async () => {
    const store = new PostgresManagedProjectStore(createFakeDb());
    expect(await store.get('acme/nope')).toBeNull();
    expect(await store.getEncryptedToken('acme/nope')).toBeNull();
  });

  it('creates a new project, requiring a token', async () => {
    const store = new PostgresManagedProjectStore(createFakeDb());
    const { publicKey, privateKey } = generateManagedProjectKeyPair();

    const created = await store.upsert({ project: 'acme-web', repo: 'acme/web', token: 'ghp_abc123' }, publicKey);

    expect(created.project).toBe('acme-web');
    expect(created.credentialSet).toBe(true);
    expect(created.config).toBeNull();

    const encrypted = await store.getEncryptedToken('acme/web');
    expect(encrypted).not.toBeNull();
    expect(decryptForManagedProject(privateKey, encrypted!)).toBe('ghp_abc123');
  });

  it('throws when creating a new project without a token', async () => {
    const store = new PostgresManagedProjectStore(createFakeDb());
    const { publicKey } = generateManagedProjectKeyPair();
    await expect(store.upsert({ project: 'acme-web', repo: 'acme/web' }, publicKey)).rejects.toThrow(/token is required/);
  });

  it('updates config without a new token, preserving the existing credential', async () => {
    const store = new PostgresManagedProjectStore(createFakeDb());
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    await store.upsert({ project: 'acme-web', repo: 'acme/web', token: 'ghp_abc123' }, publicKey);

    const config = { stages: {}, routing: {}, brakes: { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 } };
    const updated = await store.upsert({ project: 'acme-web', repo: 'acme/web', config }, publicKey);

    expect(updated.config).toEqual(config);
    const encrypted = await store.getEncryptedToken('acme/web');
    expect(decryptForManagedProject(privateKey, encrypted!)).toBe('ghp_abc123'); // unchanged
  });

  it('rotates the token, preserving the existing config', async () => {
    const store = new PostgresManagedProjectStore(createFakeDb());
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const config = { stages: {}, routing: {}, brakes: { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 } };
    await store.upsert({ project: 'acme-web', repo: 'acme/web', token: 'ghp_old', config }, publicKey);

    const updated = await store.upsert({ project: 'acme-web', repo: 'acme/web', token: 'ghp_new' }, publicKey);

    expect(updated.config).toEqual(config); // unchanged
    const encrypted = await store.getEncryptedToken('acme/web');
    expect(decryptForManagedProject(privateKey, encrypted!)).toBe('ghp_new');
  });

  it('clears config back to file-based with an explicit null', async () => {
    const store = new PostgresManagedProjectStore(createFakeDb());
    const { publicKey } = generateManagedProjectKeyPair();
    const config = { stages: {}, routing: {}, brakes: { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 } };
    await store.upsert({ project: 'acme-web', repo: 'acme/web', token: 'ghp_abc123', config }, publicKey);

    const updated = await store.upsert({ project: 'acme-web', repo: 'acme/web', config: null }, publicKey);

    expect(updated.config).toBeNull();
  });

  it('lists all projects sorted by project name', async () => {
    const store = new PostgresManagedProjectStore(createFakeDb());
    const { publicKey } = generateManagedProjectKeyPair();
    await store.upsert({ project: 'zebra', repo: 'acme/zebra', token: 't1' }, publicKey);
    await store.upsert({ project: 'apple', repo: 'acme/apple', token: 't2' }, publicKey);

    const list = await store.list();
    expect(list.map((p) => p.project)).toEqual(['apple', 'zebra']);
  });

  it('removes a project', async () => {
    const store = new PostgresManagedProjectStore(createFakeDb());
    const { publicKey } = generateManagedProjectKeyPair();
    await store.upsert({ project: 'acme-web', repo: 'acme/web', token: 't1' }, publicKey);

    await store.remove('acme/web');

    expect(await store.get('acme/web')).toBeNull();
  });

  it('looks up a project by its project slug', async () => {
    const store = new PostgresManagedProjectStore(createFakeDb());
    const { publicKey } = generateManagedProjectKeyPair();
    await store.upsert({ project: 'acme-web', repo: 'acme/web', token: 't1' }, publicKey);

    expect((await store.getByProject('acme-web'))?.repo).toBe('acme/web');
    expect(await store.getByProject('nope')).toBeNull();
  });

  describe('linear-tracked projects', () => {
    it('creates a linear-tracked project with both credentials', async () => {
      const store = new PostgresManagedProjectStore(createFakeDb());
      const { publicKey, privateKey } = generateManagedProjectKeyPair();

      const created = await store.upsert(
        {
          project: 'acme-linear',
          repo: 'acme/linear-tracked',
          token: 'ghp_abc',
          trackerType: 'linear',
          linearTeamKey: 'ENG',
          linearTriggerLabelId: 'label-uuid',
          linearToken: 'lin_abc',
        },
        publicKey,
      );

      expect(created.trackerType).toBe('linear');
      if (created.trackerType === 'linear') {
        expect(created.linearTeamKey).toBe('ENG');
        expect(created.linearCredentialSet).toBe(true);
      }
      const encryptedLinearToken = await store.getEncryptedLinearToken('acme/linear-tracked');
      expect(decryptForManagedProject(privateKey, encryptedLinearToken!)).toBe('lin_abc');
    });

    it('throws when creating a linear-tracked project missing any linear field', async () => {
      const store = new PostgresManagedProjectStore(createFakeDb());
      const { publicKey } = generateManagedProjectKeyPair();
      await expect(
        store.upsert({ project: 'acme-linear', repo: 'acme/linear-tracked', token: 'ghp_abc', trackerType: 'linear' }, publicKey),
      ).rejects.toThrow(/linearTeamKey, linearTriggerLabelId, and linearToken are all required/);
    });

    it('rotates the linear token independently of the github token', async () => {
      const store = new PostgresManagedProjectStore(createFakeDb());
      const { publicKey, privateKey } = generateManagedProjectKeyPair();
      await store.upsert(
        {
          project: 'acme-linear',
          repo: 'acme/linear-tracked',
          token: 'ghp_abc',
          trackerType: 'linear',
          linearTeamKey: 'ENG',
          linearTriggerLabelId: 'label-uuid',
          linearToken: 'lin_old',
        },
        publicKey,
      );

      await store.upsert({ project: 'acme-linear', repo: 'acme/linear-tracked', linearToken: 'lin_new' }, publicKey);

      const encryptedGithubToken = await store.getEncryptedToken('acme/linear-tracked');
      const encryptedLinearToken = await store.getEncryptedLinearToken('acme/linear-tracked');
      expect(decryptForManagedProject(privateKey, encryptedGithubToken!)).toBe('ghp_abc'); // unchanged
      expect(decryptForManagedProject(privateKey, encryptedLinearToken!)).toBe('lin_new');
    });

    it('finds a linear-tracked project by its team key', async () => {
      const store = new PostgresManagedProjectStore(createFakeDb());
      const { publicKey } = generateManagedProjectKeyPair();
      await store.upsert(
        {
          project: 'acme-linear',
          repo: 'acme/linear-tracked',
          token: 'ghp_abc',
          trackerType: 'linear',
          linearTeamKey: 'ENG',
          linearTriggerLabelId: 'label-uuid',
          linearToken: 'lin_abc',
        },
        publicKey,
      );

      expect((await store.getByLinearTeamKey('ENG'))?.repo).toBe('acme/linear-tracked');
      expect(await store.getByLinearTeamKey('OTHER')).toBeNull();
    });

    it('rejects setting linear fields on a github-tracked project', async () => {
      const store = new PostgresManagedProjectStore(createFakeDb());
      const { publicKey } = generateManagedProjectKeyPair();
      await store.upsert({ project: 'acme-web', repo: 'acme/web', token: 'ghp_abc' }, publicKey);

      await expect(store.upsert({ project: 'acme-web', repo: 'acme/web', linearTeamKey: 'ENG' }, publicKey)).rejects.toThrow(
        /is not linear-tracked/,
      );
    });

    it('trackerType is immutable once created, even if input omits/changes it', async () => {
      const store = new PostgresManagedProjectStore(createFakeDb());
      const { publicKey } = generateManagedProjectKeyPair();
      await store.upsert(
        {
          project: 'acme-linear',
          repo: 'acme/linear-tracked',
          token: 'ghp_abc',
          trackerType: 'linear',
          linearTeamKey: 'ENG',
          linearTriggerLabelId: 'label-uuid',
          linearToken: 'lin_abc',
        },
        publicKey,
      );

      // Default trackerType ('github') on this update input must not override the existing row's tracker.
      const updated = await store.upsert({ project: 'acme-linear', repo: 'acme/linear-tracked', config: null }, publicKey);

      expect(updated.trackerType).toBe('linear');
    });
  });
});
