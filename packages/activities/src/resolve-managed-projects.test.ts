import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { FileManagedProjectStore } from './file-managed-project-store';
import { loadManagedProjectRegistry, resolveManagedProjectEntry } from './resolve-managed-projects';

function writeProjectFiles(
  dir: string,
  slug: string,
  fields: {
    project: string;
    repo: string;
    tokenSecret: string;
    readRepositories?: unknown;
    trackerType?: 'github' | 'linear';
    linearTeamKey?: string;
    linearTriggerLabelId?: string;
    linearTokenSecret?: string;
  },
): void {
  const optionalFields = [
    fields.readRepositories === undefined
      ? ''
      : `readRepositories: ${JSON.stringify(fields.readRepositories)}\n`,
    fields.trackerType === undefined ? '' : `trackerType: ${fields.trackerType}\n`,
    fields.linearTeamKey === undefined ? '' : `linearTeamKey: ${fields.linearTeamKey}\n`,
    fields.linearTriggerLabelId === undefined
      ? ''
      : `linearTriggerLabelId: ${fields.linearTriggerLabelId}\n`,
    fields.linearTokenSecret === undefined
      ? ''
      : `linearTokenSecret: ${fields.linearTokenSecret}\n`,
  ].join('');
  writeFileSync(
    join(dir, `${slug}__project.yaml`),
    `project: ${fields.project}\nrepo: ${fields.repo}\ntokenSecret: ${fields.tokenSecret}\n${optionalFields}`,
  );
}

describe('resolveManagedProjectEntry', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('resolves from the store when the repo is managed there, resolving its tokenSecret', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    writeProjectFiles(dir, 'acme-web', {
      project: 'acme-web',
      repo: 'https://github.com/acme/web',
      tokenSecret: 'github-token',
    });
    const store = new FileManagedProjectStore(dir);
    const resolvedRequests: Array<[string, string | undefined]> = [];
    const resolveToken = async (tokenSecret: string, key?: string) => {
      resolvedRequests.push([tokenSecret, key]);
      return tokenSecret === 'github-token' ? 'ghp_x' : 'wrong-secret';
    };

    const resolved = await resolveManagedProjectEntry({ store, resolveToken }, 'acme/web');

    expect(resolved).toEqual({
      project: 'acme-web',
      repo: 'acme/web',
      trackerType: 'github',
      token: 'ghp_x',
      readRepositories: [],
    });
    expect(resolvedRequests).toEqual([['github-token', 'GITHUB_TOKEN']]);
  });

  it('returns null when no deps are configured at all', async () => {
    const resolved = await resolveManagedProjectEntry(undefined, 'acme/anything');
    expect(resolved).toBeNull();
  });

  it('returns null when the repo is not store-managed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    const store = new FileManagedProjectStore(dir);

    const resolved = await resolveManagedProjectEntry(
      { store, resolveToken: async () => 'ghp_x' },
      'acme/nowhere',
    );

    expect(resolved).toBeNull();
  });
});

describe('loadManagedProjectRegistry', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('resolves every managed project via store.list(), resolving each tokenSecret', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    writeProjectFiles(dir, 'a', {
      project: 'a',
      repo: 'https://github.com/acme/a',
      tokenSecret: 'github-token',
    });
    writeProjectFiles(dir, 'b', {
      project: 'b',
      repo: 'https://github.com/acme/b',
      tokenSecret: 'github-token',
    });
    const store = new FileManagedProjectStore(dir);

    const entries = await loadManagedProjectRegistry({ store, resolveToken: async () => 'ghp_x' });

    expect(entries).toEqual([
      { project: 'a', repo: 'acme/a', readRepositories: [], trackerType: 'github', token: 'ghp_x' },
      { project: 'b', repo: 'acme/b', readRepositories: [], trackerType: 'github', token: 'ghp_x' },
    ]);
  });

  it('canonicalizes a full-URL repo to short owner/repo in the resolved entry', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    writeProjectFiles(dir, 'webapp', {
      project: 'webapp',
      repo: 'https://github.com/acme/webapp',
      tokenSecret: 'github-token',
    });
    const store = new FileManagedProjectStore(dir);

    const entries = await loadManagedProjectRegistry({ store, resolveToken: async () => 't' });

    expect(entries[0].repo).toBe('acme/webapp');
  });

  it('propagates normalized read repositories into GitHub and Linear resolved entries without resolving extra tokens', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    writeProjectFiles(dir, 'github', {
      project: 'github-project',
      repo: 'https://github.com/acme/github',
      tokenSecret: 'github-token',
      readRepositories: ['Acme/Shared'],
    });
    writeProjectFiles(dir, 'linear', {
      project: 'linear-project',
      repo: 'https://github.com/acme/linear',
      tokenSecret: 'linear-github-token',
      trackerType: 'linear',
      linearTeamKey: 'ENG',
      linearTokenSecret: 'linear-token',
      readRepositories: ['Acme/Docs'],
    });
    const resolvedSecrets: Array<[string, string | undefined]> = [];

    const entries = await loadManagedProjectRegistry({
      store: new FileManagedProjectStore(dir),
      resolveToken: async (secret, key?: string) => {
        resolvedSecrets.push([secret, key]);
        return `token-for-${secret}`;
      },
    });

    expect(entries).toEqual([
      {
        project: 'github-project',
        repo: 'acme/github',
        trackerType: 'github',
        token: 'token-for-github-token',
        readRepositories: ['acme/shared'],
      },
      {
        project: 'linear-project',
        repo: 'acme/linear',
        trackerType: 'linear',
        token: 'token-for-linear-github-token',
        linearTeamKey: 'ENG',
        linearToken: 'token-for-linear-token',
        readRepositories: ['acme/docs'],
      },
    ]);
    expect(resolvedSecrets).toEqual([
      ['github-token', 'GITHUB_TOKEN'],
      ['linear-github-token', 'GITHUB_TOKEN'],
      ['linear-token', 'LINEAR_API_TOKEN'],
    ]);
  });
});
