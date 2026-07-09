import { describe, expect, it } from 'vitest';
import { encryptForManagedProject, generateManagedProjectKeyPair } from './credential-crypto';
import { loadManagedProjectRegistry, resolveManagedProjectEntry, resolveManagedProjectEntryByLinearTeamKey } from './resolve-managed-projects';
import type { PostgresManagedProjectStore } from './postgres-managed-project-store';

interface FakeRow {
  project: string;
  repo: string;
  encryptedToken: string;
  config?: unknown;
  trackerType?: 'github' | 'linear';
  linearTeamKey?: string;
  linearTriggerLabelId?: string;
  encryptedLinearToken?: string;
}

function fakeStore(rows: FakeRow[]) {
  function toManagedProject(row: FakeRow) {
    const base = { id: '1', project: row.project, repo: row.repo, credentialSet: true, config: row.config ?? null, createdAt: '', updatedAt: '' };
    if (row.trackerType === 'linear') {
      return { ...base, trackerType: 'linear' as const, linearTeamKey: row.linearTeamKey, linearTriggerLabelId: row.linearTriggerLabelId, linearCredentialSet: Boolean(row.encryptedLinearToken) };
    }
    return { ...base, trackerType: 'github' as const };
  }
  return {
    async get(repo: string) {
      const row = rows.find((r) => r.repo === repo);
      return row ? toManagedProject(row) : null;
    },
    async getByLinearTeamKey(teamKey: string) {
      const row = rows.find((r) => r.linearTeamKey === teamKey);
      return row ? toManagedProject(row) : null;
    },
    async getEncryptedToken(repo: string) {
      return rows.find((r) => r.repo === repo)?.encryptedToken ?? null;
    },
    async getEncryptedLinearToken(repo: string) {
      return rows.find((r) => r.repo === repo)?.encryptedLinearToken ?? null;
    },
    async list() {
      return rows.map(toManagedProject);
    },
  } as unknown as PostgresManagedProjectStore;
}

describe('resolveManagedProjectEntry', () => {
  it('resolves from the DB when the repo is managed there, decrypting the token', async () => {
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const blob = encryptForManagedProject(publicKey, 'db-token');
    const store = fakeStore([{ project: 'acme-web', repo: 'acme/web', encryptedToken: blob }]);

    const resolved = await resolveManagedProjectEntry({ store, privateKey }, 'acme/web');

    expect(resolved).toEqual({ project: 'acme-web', repo: 'acme/web', trackerType: 'github', token: 'db-token' });
  });

  it('returns null when no DB deps are configured at all', async () => {
    const resolved = await resolveManagedProjectEntry(undefined, 'acme/anything');
    expect(resolved).toBeNull();
  });

  it('returns null when the repo is not DB-managed', async () => {
    const store = fakeStore([]);
    const resolved = await resolveManagedProjectEntry({ store, privateKey: 'unused' }, 'acme/nowhere');
    expect(resolved).toBeNull();
  });

  it('returns null (not the raw ciphertext) when decrypt fails', async () => {
    const store = fakeStore([{ project: 'acme-web', repo: 'acme/web', encryptedToken: 'not-valid-ciphertext' }]);
    const resolved = await resolveManagedProjectEntry({ store, privateKey: 'unused' }, 'acme/web');
    expect(resolved).toBeNull();
  });

  it('resolves a linear-tracked project, decrypting both credentials', async () => {
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const store = fakeStore([
      {
        project: 'acme-linear',
        repo: 'acme/linear-tracked',
        trackerType: 'linear',
        linearTeamKey: 'ENG',
        linearTriggerLabelId: 'label-uuid',
        encryptedToken: encryptForManagedProject(publicKey, 'ghp_abc'),
        encryptedLinearToken: encryptForManagedProject(publicKey, 'lin_abc'),
      },
    ]);

    const resolved = await resolveManagedProjectEntry({ store, privateKey }, 'acme/linear-tracked');

    expect(resolved).toEqual({
      project: 'acme-linear',
      repo: 'acme/linear-tracked',
      trackerType: 'linear',
      token: 'ghp_abc',
      linearTeamKey: 'ENG',
      linearTriggerLabelId: 'label-uuid',
      linearToken: 'lin_abc',
    });
  });

  it('returns null for a linear-tracked project with no Linear credential set', async () => {
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const store = fakeStore([
      {
        project: 'acme-linear',
        repo: 'acme/linear-tracked',
        trackerType: 'linear',
        linearTeamKey: 'ENG',
        linearTriggerLabelId: 'label-uuid',
        encryptedToken: encryptForManagedProject(publicKey, 'ghp_abc'),
      },
    ]);

    expect(await resolveManagedProjectEntry({ store, privateKey }, 'acme/linear-tracked')).toBeNull();
  });
});

describe('resolveManagedProjectEntryByLinearTeamKey', () => {
  it('resolves a linear-tracked project by team key', async () => {
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const store = fakeStore([
      {
        project: 'acme-linear',
        repo: 'acme/linear-tracked',
        trackerType: 'linear',
        linearTeamKey: 'ENG',
        linearTriggerLabelId: 'label-uuid',
        encryptedToken: encryptForManagedProject(publicKey, 'ghp_abc'),
        encryptedLinearToken: encryptForManagedProject(publicKey, 'lin_abc'),
      },
    ]);

    const resolved = await resolveManagedProjectEntryByLinearTeamKey({ store, privateKey }, 'ENG');

    expect(resolved?.trackerType).toBe('linear');
    expect(resolved?.repo).toBe('acme/linear-tracked');
  });

  it('returns null when no DB deps are configured', async () => {
    expect(await resolveManagedProjectEntryByLinearTeamKey(undefined, 'ENG')).toBeNull();
  });

  it('returns null when no project matches the team key', async () => {
    const store = fakeStore([]);
    expect(await resolveManagedProjectEntryByLinearTeamKey({ store, privateKey: 'unused' }, 'ENG')).toBeNull();
  });
});

describe('loadManagedProjectRegistry', () => {
  it('decrypts every managed project into a ResolvedProjectEntry', async () => {
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const store = fakeStore([
      { project: 'a', repo: 'acme/a', encryptedToken: encryptForManagedProject(publicKey, 'token-a') },
      { project: 'b', repo: 'acme/b', encryptedToken: encryptForManagedProject(publicKey, 'token-b') },
    ]);

    const entries = await loadManagedProjectRegistry({ store, privateKey });

    expect(entries).toEqual([
      { project: 'a', repo: 'acme/a', trackerType: 'github', token: 'token-a' },
      { project: 'b', repo: 'acme/b', trackerType: 'github', token: 'token-b' },
    ]);
  });

  it('skips managed projects that cannot be decrypted', async () => {
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const store = fakeStore([
      { project: 'good', repo: 'acme/good', encryptedToken: encryptForManagedProject(publicKey, 'token-good') },
      { project: 'bad', repo: 'acme/bad', encryptedToken: 'not-valid-ciphertext' },
    ]);

    const entries = await loadManagedProjectRegistry({ store, privateKey });

    expect(entries).toEqual([{ project: 'good', repo: 'acme/good', trackerType: 'github', token: 'token-good' }]);
  });

  it('includes linear-tracked projects alongside github ones', async () => {
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const store = fakeStore([
      { project: 'gh-project', repo: 'acme/gh', encryptedToken: encryptForManagedProject(publicKey, 'token-gh') },
      {
        project: 'linear-project',
        repo: 'acme/linear-tracked',
        trackerType: 'linear',
        linearTeamKey: 'ENG',
        linearTriggerLabelId: 'label-uuid',
        encryptedToken: encryptForManagedProject(publicKey, 'ghp_abc'),
        encryptedLinearToken: encryptForManagedProject(publicKey, 'lin_abc'),
      },
    ]);

    const entries = await loadManagedProjectRegistry({ store, privateKey });

    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual({
      project: 'linear-project',
      repo: 'acme/linear-tracked',
      trackerType: 'linear',
      token: 'ghp_abc',
      linearTeamKey: 'ENG',
      linearTriggerLabelId: 'label-uuid',
      linearToken: 'lin_abc',
    });
  });
});
