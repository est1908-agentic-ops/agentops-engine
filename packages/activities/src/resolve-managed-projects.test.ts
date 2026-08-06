import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('skips a project when token resolution fails, continuing with other projects', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    writeProjectFiles(dir, 'good', {
      project: 'Good Project',
      repo: 'https://github.com/acme/good',
      tokenSecret: 'good-token',
    });
    writeProjectFiles(dir, 'bad', {
      project: 'Bad Project',
      repo: 'https://github.com/acme/bad',
      tokenSecret: 'bad-token',
    });

    const resolveToken = async (tokenSecret: string) => {
      if (tokenSecret === 'bad-token') {
        throw new Error('Secret not found in Kubernetes');
      }
      return `token-for-${tokenSecret}`;
    };

    const entries = await loadManagedProjectRegistry({
      store: new FileManagedProjectStore(dir),
      resolveToken,
    });

    // Should only include the good project
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      project: 'Good Project',
      repo: 'acme/good',
    });

    // Verify console.warn was called for the bad project
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/loadManagedProjectRegistry: skipping.*Bad Project.*acme\/bad/),
    );

    warnSpy.mockRestore();
  });

  it('skips a Linear project missing linearTokenSecret during registry load', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    writeProjectFiles(dir, 'good', {
      project: 'Good Project',
      repo: 'https://github.com/acme/good',
      tokenSecret: 'github-token',
    });
    writeProjectFiles(dir, 'bad-linear', {
      project: 'Bad Linear Project',
      repo: 'https://github.com/acme/bad-linear',
      tokenSecret: 'github-token',
      trackerType: 'linear',
      linearTeamKey: 'ENG',
      // Missing linearTokenSecret
    });

    const entries = await loadManagedProjectRegistry({
      store: new FileManagedProjectStore(dir),
      resolveToken: async () => 'token',
    });

    // Should only include the good project
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      project: 'Good Project',
    });

    // Verify console.warn was called
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/loadManagedProjectRegistry: skipping.*Bad Linear Project/),
    );

    warnSpy.mockRestore();
  });

  it('single-lookup resolveManagedProjectEntry still propagates errors', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    writeProjectFiles(dir, 'demo', {
      project: 'Demo Project',
      repo: 'https://github.com/acme/demo',
      tokenSecret: 'demo-token',
    });

    const resolveToken = async () => {
      throw new Error('Token resolution failed');
    };

    // Single-lookup should propagate the error, not skip
    await expect(
      resolveManagedProjectEntry(
        {
          store: new FileManagedProjectStore(dir),
          resolveToken,
        },
        'acme/demo',
      ),
    ).rejects.toThrow('Token resolution failed');
  });
});
