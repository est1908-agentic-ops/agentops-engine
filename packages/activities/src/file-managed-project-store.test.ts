import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROJECT_CONFIG } from '@agentops/contracts';
import { FileManagedProjectStore } from './file-managed-project-store';

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
  config?: unknown,
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

  it('loads a Linear tracker without enabling webhook-triggered tasks', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    writeProjectFiles(dir, 'linear', {
      project: 'Linear App',
      repo: 'https://github.com/acme/linear',
      tokenSecret: 'github-token',
      trackerType: 'linear',
      linearTeamKey: 'ENG',
      linearTokenSecret: 'linear-token',
    });
    const store = new FileManagedProjectStore(dir);

    const managed = await store.get('acme/linear');

    expect(managed).toMatchObject({
      project: 'Linear App',
      trackerType: 'linear',
      linearTeamKey: 'ENG',
      linearTokenSecret: 'linear-token',
    });
    expect(managed).not.toHaveProperty('linearTriggerLabelId');
    expect(await store.getByLinearTeamKey('ENG')).toEqual(managed);
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
    ['contains a repository query', ['acme/repo?ref=main']],
    ['contains whitespace in a repository segment', ['acme /repo']],
    ['contains surrounding whitespace', [' acme/repo']],
    ['contains a current-directory repository segment', ['./repo']],
    ['contains a parent-directory repository segment', ['acme/..']],
    ['contains a full URL', ['https://github.com/acme/shared']],
  ])('skips readRepositories validation error and returns null: %s', async (_description, readRepositories) => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeProjectFiles(dir, 'demo', {
      project: 'Demo App',
      repo: 'https://github.com/acme/demo',
      tokenSecret: 'github-token',
      readRepositories,
    });

    const result = await new FileManagedProjectStore(dir).get('acme/demo');

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/readRepositories/));

    warnSpy.mockRestore();
  });

  it('skips duplicate read repositories and returns null', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeProjectFiles(dir, 'demo', {
      project: 'Demo App',
      repo: 'https://github.com/acme/demo',
      tokenSecret: 'github-token',
      readRepositories: ['Acme/Shared', 'acme/shared'],
    });

    const result = await new FileManagedProjectStore(dir).get('acme/demo');

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/duplicate/i));

    warnSpy.mockRestore();
  });

  it('skips primary repository in readRepositories and returns null', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeProjectFiles(dir, 'demo', {
      project: 'Demo App',
      repo: 'https://github.com/acme/demo',
      tokenSecret: 'github-token',
      readRepositories: ['Acme/Demo'],
    });

    const result = await new FileManagedProjectStore(dir).get('acme/demo');

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/primary/i));

    warnSpy.mockRestore();
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

  it('observes project files updated after the first lookup', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    writeProjectFiles(dir, 'demo', {
      project: 'Demo App',
      repo: 'https://github.com/acme/demo',
      tokenSecret: 'github-token',
    });
    const store = new FileManagedProjectStore(dir);

    expect((await store.get('acme/demo'))?.trackerType).toBe('github');

    writeProjectFiles(dir, 'demo', {
      project: 'Demo App',
      repo: 'https://github.com/acme/demo',
      tokenSecret: 'github-token',
      trackerType: 'linear',
      linearTeamKey: 'ENG',
      linearTokenSecret: 'linear-token',
    });

    expect(await store.getByLinearTeamKey('ENG')).toMatchObject({
      trackerType: 'linear',
      linearTeamKey: 'ENG',
      linearTokenSecret: 'linear-token',
    });
  });

  it('skips a project with invalid __agentops.json and returns null', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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

    const result = await store.get('acme/broken');

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/broken/));

    warnSpy.mockRestore();
  });

  it('skips a malformed project file and returns only the valid project', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Write a valid project
    writeProjectFiles(dir, 'valid', {
      project: 'Valid App',
      repo: 'https://github.com/acme/valid',
      tokenSecret: 'github-token',
    });

    // Write a malformed project (missing required "repo" field)
    writeFileSync(
      join(dir, 'malformed__project.yaml'),
      'project: Malformed App\ntokenSecret: github-token\n',
    );

    const store = new FileManagedProjectStore(dir);

    // list() should skip the malformed project and return only the valid one
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ project: 'Valid App', repo: 'acme/valid' });

    // get() for the valid project should work
    expect(await store.get('acme/valid')).toMatchObject({ project: 'Valid App' });

    // get() for the bad project should return null
    expect(await store.get('acme/malformed')).toBeNull();

    // Verify console.warn was called for the malformed file
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/FileManagedProjectStore: skipping.*malformed.*slug "malformed"/),
    );

    warnSpy.mockRestore();
  });

  it('skips a project with an invalid __agentops.json and returns the valid project', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-managed-projects-'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Write a valid project without config
    writeProjectFiles(dir, 'valid', {
      project: 'Valid App',
      repo: 'https://github.com/acme/valid',
      tokenSecret: 'github-token',
    });

    // Write a project with valid __project.yaml but invalid __agentops.json
    writeProjectFiles(
      dir,
      'bad-config',
      {
        project: 'Bad Config App',
        repo: 'https://github.com/acme/bad-config',
        tokenSecret: 'github-token',
      },
      { autoMerge: 'not-a-real-mode' }, // fails ProjectConfig validation
    );

    const store = new FileManagedProjectStore(dir);

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ project: 'Valid App', repo: 'acme/valid' });

    expect(await store.get('acme/bad-config')).toBeNull();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/FileManagedProjectStore: skipping.*bad-config.*slug "bad-config"/),
    );

    warnSpy.mockRestore();
  });

  it('still throws when readdir fails (directory not found)', async () => {
    const store = new FileManagedProjectStore('/nonexistent/directory/path');

    await expect(store.list()).rejects.toThrow();
  });
});
