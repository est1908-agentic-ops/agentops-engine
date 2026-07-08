import { describe, expect, it } from 'vitest';
import { readRegistryRepos } from './read-registry-repos';

describe('readRegistryRepos', () => {
  it('returns an empty array when PROJECT_REGISTRY_JSON is unset', () => {
    expect(readRegistryRepos({})).toEqual([]);
  });

  it('returns repo slugs without requiring any token env vars to be set', () => {
    const env = {
      PROJECT_REGISTRY_JSON: JSON.stringify([
        { project: 'project-a', repo: 'flair-hr/project-a', trackerType: 'github', tokenEnvVar: 'GITHUB_TOKEN__PROJECT_A' },
      ]),
    };

    expect(readRegistryRepos(env)).toEqual(['flair-hr/project-a']);
  });

  it('returns multiple repo slugs in registry order', () => {
    const env = {
      PROJECT_REGISTRY_JSON: JSON.stringify([
        { project: 'project-a', repo: 'flair-hr/project-a', trackerType: 'github', tokenEnvVar: 'X' },
        { project: 'project-b', repo: 'flair-hr/project-b', trackerType: 'github', tokenEnvVar: 'Y' },
      ]),
    };

    expect(readRegistryRepos(env)).toEqual(['flair-hr/project-a', 'flair-hr/project-b']);
  });

  it('throws on a malformed PROJECT_REGISTRY_JSON', () => {
    expect(() => readRegistryRepos({ PROJECT_REGISTRY_JSON: '{}' })).toThrow();
  });
});
