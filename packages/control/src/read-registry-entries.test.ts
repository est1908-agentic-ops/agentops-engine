import { describe, expect, it } from 'vitest';
import { readRegistryEntries } from './read-registry-entries';

describe('readRegistryEntries', () => {
  it('returns [] when PROJECT_REGISTRY_JSON is unset', () => {
    expect(readRegistryEntries({})).toEqual([]);
  });

  it('returns project/repo pairs without touching token env vars', () => {
    const env = {
      PROJECT_REGISTRY_JSON: JSON.stringify([
        { project: 'demo', repo: 'demo/repo', trackerType: 'github', tokenEnvVar: 'DEMO_TOKEN' },
      ]),
    };
    expect(readRegistryEntries(env)).toEqual([{ project: 'demo', repo: 'demo/repo' }]);
  });
});
