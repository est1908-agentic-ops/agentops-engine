import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_CONFIG } from '@agentops/contracts';
import { FileManagedProjectStore } from './file-managed-project-store';

function writeProjectFiles(
  dir: string,
  slug: string,
  fields: { project: string; repo: string; tokenSecret: string; readRepositories?: unknown },
  config?: unknown,
): void {
  const readRepositories =
    fields.readRepositories === undefined
      ? ''
      : `readRepositories: ${JSON.stringify(fields.readRepositories)}\n`;
  writeFileSync(
    join(dir, `${slug}__project.yaml`),
    `project: ${fields.project}\nrepo: ${fields.repo}\ntokenSecret: ${fields.tokenSecret}\n${readRepositories}`,
  );
  if (config !== undefined) {
    writeFileSync(join(dir, `${slug}__agentops.json`), JSON.stringify(config));
  }
}

describe('FileManagedProjectStore', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('resolves a project by short repo form, by full URL, and lists it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    // A PARTIAL agentops.json, exactly like the real imported files (e.g. the
    // engine's own): no stages/routing/brakes at all.
    writeProjectFiles(
      dir,
      'demo',
      { project: 'Demo App', repo: 'https://github.com/acme/demo', tokenSecret: 'github-token' },
      { autoMerge: 'all' },
    );
    const store = new FileManagedProjectStore(dir);

    const bySlug = await store.get('acme/demo');
    expect(bySlug).toMatchObject({ project: 'Demo App', repo: 'acme/demo', trackerType: 'github' });
    // Proves partial -> complete: the override (autoMerge) survives, and the
    // fields the fixture never mentioned (stages/routing/brakes) come back
    // fully populated from DEFAULT_PROJECT_CONFIG, the same as loadProjectConfig's
    // in-repo fallback -- because resolveProjectConfig returns this config
    // straight through with no further defaulting step.
    expect(bySlug?.config?.autoMerge).toBe('all');
    expect(bySlug?.config?.stages).toEqual(DEFAULT_PROJECT_CONFIG.stages);
    expect(bySlug?.config?.routing).toEqual(DEFAULT_PROJECT_CONFIG.routing);
    expect(bySlug?.config?.brakes).toEqual(DEFAULT_PROJECT_CONFIG.brakes);

    const byUrl = await store.get('https://github.com/acme/demo');
    expect(byUrl).toEqual(bySlug);

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(bySlug);
  });

  it('yields config: null when no __agentops.json file is present', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    writeProjectFiles(dir, 'bare', {
      project: 'Bare App',
      repo: 'https://github.com/acme/bare',
      tokenSecret: 'github-token',
    });
    const store = new FileManagedProjectStore(dir);

    const result = await store.get('acme/bare');

    expect(result?.config).toBeNull();
    expect(result?.readRepositories).toEqual([]);
  });

  it('normalizes configured read repositories to short lowercase owner/name form', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    writeProjectFiles(dir, 'demo', {
      project: 'Demo App',
      repo: 'https://github.com/acme/demo',
      tokenSecret: 'github-token',
      readRepositories: ['Acme/Shared', 'acme/Docs'],
    });

    const managed = await new FileManagedProjectStore(dir).get('acme/demo');

    expect(managed?.readRepositories).toEqual(['acme/shared', 'acme/docs']);
  });

  it.each([
    ['is not an array', 'acme/shared'],
    ['contains a non-string value', ['acme/shared', 42]],
    ['contains an empty value', ['acme/shared', '']],
    ['contains an invalid repository', ['acme/shared', 'acme/shared/extra']],
    ['contains a full URL', ['https://github.com/acme/shared']],
  ])('rejects readRepositories when it %s', async (_description, readRepositories) => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    writeProjectFiles(dir, 'demo', {
      project: 'Demo App',
      repo: 'https://github.com/acme/demo',
      tokenSecret: 'github-token',
      readRepositories,
    });

    await expect(new FileManagedProjectStore(dir).get('acme/demo')).rejects.toThrow(
      /readRepositories/,
    );
  });

  it('rejects duplicate read repositories case-insensitively', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    writeProjectFiles(dir, 'demo', {
      project: 'Demo App',
      repo: 'https://github.com/acme/demo',
      tokenSecret: 'github-token',
      readRepositories: ['Acme/Shared', 'acme/shared'],
    });

    await expect(new FileManagedProjectStore(dir).get('acme/demo')).rejects.toThrow(/duplicate/i);
  });

  it('rejects the primary repository in readRepositories case-insensitively', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    writeProjectFiles(dir, 'demo', {
      project: 'Demo App',
      repo: 'https://github.com/acme/demo',
      tokenSecret: 'github-token',
      readRepositories: ['Acme/Demo'],
    });

    await expect(new FileManagedProjectStore(dir).get('acme/demo')).rejects.toThrow(/primary/i);
  });

  it('finds a project by its project name via getByProject', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    writeProjectFiles(dir, 'demo', {
      project: 'Demo App',
      repo: 'https://github.com/acme/demo',
      tokenSecret: 'github-token',
    });
    const store = new FileManagedProjectStore(dir);

    expect((await store.getByProject('Demo App'))?.repo).toBe('acme/demo');
    expect(await store.getByProject('Nonexistent')).toBeNull();
  });

  it('returns null from get() for an unregistered repo', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    writeProjectFiles(dir, 'demo', {
      project: 'Demo App',
      repo: 'https://github.com/acme/demo',
      tokenSecret: 'github-token',
    });
    const store = new FileManagedProjectStore(dir);

    expect(await store.get('acme/other')).toBeNull();
  });

  it('throws naming the slug when __agentops.json fails ProjectConfig validation', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    writeProjectFiles(
      dir,
      'broken',
      {
        project: 'Broken App',
        repo: 'https://github.com/acme/broken',
        tokenSecret: 'github-token',
      },
      { autoMerge: 'not-a-real-mode' }, // fails AutoMergeModeSchema's enum even after defaulting
    );
    const store = new FileManagedProjectStore(dir);

    await expect(store.get('acme/broken')).rejects.toThrow(/broken/);
  });
});
