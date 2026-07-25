import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { FileManagedProjectStore } from './file-managed-project-store';
import { loadManagedProjectRegistry, resolveManagedProjectEntry } from './resolve-managed-projects';

function writeProjectFiles(
  dir: string,
  slug: string,
  fields: { project: string; repo: string; tokenSecret: string },
): void {
  writeFileSync(
    join(dir, `${slug}__project.yaml`),
    `project: ${fields.project}\nrepo: ${fields.repo}\ntokenSecret: ${fields.tokenSecret}\n`,
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

  it('resolves from the store when the repo is managed there, using the shared token', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    writeProjectFiles(dir, 'acme-web', {
      project: 'acme-web',
      repo: 'https://github.com/acme/web',
      tokenSecret: 'github-token',
    });
    const store = new FileManagedProjectStore(dir);

    const resolved = await resolveManagedProjectEntry({ store, token: 'ghp_x' }, 'acme/web');

    expect(resolved).toEqual({
      project: 'acme-web',
      repo: 'acme/web',
      trackerType: 'github',
      token: 'ghp_x',
    });
  });

  it('returns null when no deps are configured at all', async () => {
    const resolved = await resolveManagedProjectEntry(undefined, 'acme/anything');
    expect(resolved).toBeNull();
  });

  it('returns null when the repo is not store-managed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    const store = new FileManagedProjectStore(dir);

    const resolved = await resolveManagedProjectEntry({ store, token: 'ghp_x' }, 'acme/nowhere');

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

  it('resolves every managed project via store.list(), using the shared token', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    writeProjectFiles(dir, 'a', { project: 'a', repo: 'https://github.com/acme/a', tokenSecret: 'github-token' });
    writeProjectFiles(dir, 'b', { project: 'b', repo: 'https://github.com/acme/b', tokenSecret: 'github-token' });
    const store = new FileManagedProjectStore(dir);

    const entries = await loadManagedProjectRegistry({ store, token: 'ghp_x' });

    expect(entries).toEqual([
      { project: 'a', repo: 'acme/a', trackerType: 'github', token: 'ghp_x' },
      { project: 'b', repo: 'acme/b', trackerType: 'github', token: 'ghp_x' },
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

    const entries = await loadManagedProjectRegistry({ store, token: 't' });

    expect(entries[0].repo).toBe('acme/webapp');
  });
});
