import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { FileManagedProjectStore } from './file-managed-project-store';

// A minimal, fully-valid ProjectConfig (per the shared ConfigMap contract,
// `<slug>__agentops.json` is a *verbatim* ProjectConfig, not a partial patch
// merged with defaults -- see resolveProjectConfig, which returns
// managedProject.config straight through with no defaulting step).
const FULL_PROJECT_CONFIG = {
  stages: {},
  routing: {},
  brakes: { maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 },
  autoMerge: 'all',
};

function writeProjectFiles(
  dir: string,
  slug: string,
  fields: { project: string; repo: string; tokenSecret: string },
  config?: unknown,
): void {
  writeFileSync(
    join(dir, `${slug}__project.yaml`),
    `project: ${fields.project}\nrepo: ${fields.repo}\ntokenSecret: ${fields.tokenSecret}\n`,
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
    writeProjectFiles(
      dir,
      'demo',
      { project: 'Demo App', repo: 'https://github.com/acme/demo', tokenSecret: 'github-token' },
      FULL_PROJECT_CONFIG,
    );
    const store = new FileManagedProjectStore(dir);

    const bySlug = await store.get('acme/demo');
    expect(bySlug).toMatchObject({
      project: 'Demo App',
      repo: 'acme/demo',
      trackerType: 'github',
      config: FULL_PROJECT_CONFIG,
    });

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
      { project: 'Broken App', repo: 'https://github.com/acme/broken', tokenSecret: 'github-token' },
      { autoMerge: 'all' }, // missing required stages/routing/brakes
    );
    const store = new FileManagedProjectStore(dir);

    await expect(store.get('acme/broken')).rejects.toThrow(/broken/);
  });
});
