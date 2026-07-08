import { describe, expect, it } from 'vitest';
import type { ResolvedProjectEntry } from '@agentops/contracts';
import { encryptForManagedProject, generateManagedProjectKeyPair } from './credential-crypto';
import { loadManagedProjectRegistry, resolveManagedProjectEntry } from './resolve-managed-projects';
import type { PostgresManagedProjectStore } from './postgres-managed-project-store';

function fakeStore(rows: Array<{ project: string; repo: string; encryptedToken: string; config?: unknown }>) {
  return {
    async get(repo: string) {
      const row = rows.find((r) => r.repo === repo);
      return row ? { id: '1', project: row.project, repo: row.repo, credentialSet: true, config: row.config ?? null, createdAt: '', updatedAt: '' } : null;
    },
    async getEncryptedToken(repo: string) {
      return rows.find((r) => r.repo === repo)?.encryptedToken ?? null;
    },
    async list() {
      return rows.map((r) => ({ id: '1', project: r.project, repo: r.repo, credentialSet: true, config: r.config ?? null, createdAt: '', updatedAt: '' }));
    },
  } as unknown as PostgresManagedProjectStore;
}

const staticRegistry: ResolvedProjectEntry[] = [
  { project: 'legacy', repo: 'acme/legacy', trackerType: 'github', tokenEnvVar: 'GITHUB_TOKEN__LEGACY', token: 'static-token' },
];

describe('resolveManagedProjectEntry', () => {
  it('resolves from the DB when the repo is managed there, decrypting the token', async () => {
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const blob = encryptForManagedProject(publicKey, 'db-token');
    const store = fakeStore([{ project: 'acme-web', repo: 'acme/web', encryptedToken: blob }]);

    const resolved = await resolveManagedProjectEntry({ store, privateKey }, staticRegistry, 'acme/web');

    expect(resolved).toEqual({
      project: 'acme-web',
      repo: 'acme/web',
      trackerType: 'github',
      tokenEnvVar: '(managed-project, not env-backed)',
      token: 'db-token',
    });
  });

  it('falls back to the static registry when the repo is not DB-managed', async () => {
    const store = fakeStore([]);
    const resolved = await resolveManagedProjectEntry({ store, privateKey: 'unused' }, staticRegistry, 'acme/legacy');
    expect(resolved).toEqual(staticRegistry[0]);
  });

  it('falls back to the static registry when no DB deps are configured at all', async () => {
    const resolved = await resolveManagedProjectEntry(undefined, staticRegistry, 'acme/legacy');
    expect(resolved).toEqual(staticRegistry[0]);
  });

  it('returns null when neither source has the repo', async () => {
    const store = fakeStore([]);
    const resolved = await resolveManagedProjectEntry({ store, privateKey: 'unused' }, staticRegistry, 'acme/nowhere');
    expect(resolved).toBeNull();
  });

  it('falls back to the static registry for the same repo when DB decrypt fails', async () => {
    const store = fakeStore([{ project: 'acme-web', repo: 'acme/legacy', encryptedToken: 'not-valid-ciphertext' }]);
    const resolved = await resolveManagedProjectEntry({ store, privateKey: 'unused' }, staticRegistry, 'acme/legacy');
    expect(resolved).toEqual(staticRegistry[0]);
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
      { project: 'a', repo: 'acme/a', trackerType: 'github', tokenEnvVar: '(managed-project, not env-backed)', token: 'token-a' },
      { project: 'b', repo: 'acme/b', trackerType: 'github', tokenEnvVar: '(managed-project, not env-backed)', token: 'token-b' },
    ]);
  });

  it('skips managed projects that cannot be decrypted', async () => {
    const { publicKey, privateKey } = generateManagedProjectKeyPair();
    const store = fakeStore([
      { project: 'good', repo: 'acme/good', encryptedToken: encryptForManagedProject(publicKey, 'token-good') },
      { project: 'bad', repo: 'acme/bad', encryptedToken: 'not-valid-ciphertext' },
    ]);

    const entries = await loadManagedProjectRegistry({ store, privateKey });

    expect(entries).toEqual([
      { project: 'good', repo: 'acme/good', trackerType: 'github', tokenEnvVar: '(managed-project, not env-backed)', token: 'token-good' },
    ]);
  });
});
