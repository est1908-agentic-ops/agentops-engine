import { describe, expect, it } from 'vitest';
import { loadProjectRegistry } from './load-project-registry';

describe('loadProjectRegistry', () => {
  it('returns an empty array when PROJECT_REGISTRY_JSON is unset', () => {
    expect(loadProjectRegistry({})).toEqual([]);
  });

  it("resolves each entry's token from its tokenEnvVar", () => {
    const env = {
      PROJECT_REGISTRY_JSON: JSON.stringify([
        { project: 'project-a', repo: 'flair-hr/project-a', trackerType: 'github', tokenEnvVar: 'GITHUB_TOKEN__PROJECT_A' },
      ]),
      GITHUB_TOKEN__PROJECT_A: 'ghp_fake',
    };

    expect(loadProjectRegistry(env)).toEqual([
      {
        project: 'project-a',
        repo: 'flair-hr/project-a',
        trackerType: 'github',
        tokenEnvVar: 'GITHUB_TOKEN__PROJECT_A',
        token: 'ghp_fake',
      },
    ]);
  });

  it('throws naming the project and env var when a referenced tokenEnvVar is missing', () => {
    const env = {
      PROJECT_REGISTRY_JSON: JSON.stringify([
        { project: 'project-a', repo: 'flair-hr/project-a', trackerType: 'github', tokenEnvVar: 'GITHUB_TOKEN__PROJECT_A' },
      ]),
    };

    expect(() => loadProjectRegistry(env)).toThrow(/"GITHUB_TOKEN__PROJECT_A".*"project-a"/);
  });

  it('throws on a malformed PROJECT_REGISTRY_JSON', () => {
    expect(() => loadProjectRegistry({ PROJECT_REGISTRY_JSON: '{}' })).toThrow();
  });

  it("resolves a linear entry's linearToken from linearTokenEnvVar, alongside the github token", () => {
    const env = {
      PROJECT_REGISTRY_JSON: JSON.stringify([
        {
          project: 'project-linear',
          repo: 'flair-hr/project-linear',
          trackerType: 'linear',
          tokenEnvVar: 'GITHUB_TOKEN__PROJECT_LINEAR',
          linearTeamKey: 'ENG',
          linearTokenEnvVar: 'LINEAR_TOKEN__PROJECT_LINEAR',
          linearTriggerLabelId: 'label-uuid',
        },
      ]),
      GITHUB_TOKEN__PROJECT_LINEAR: 'ghp_fake',
      LINEAR_TOKEN__PROJECT_LINEAR: 'lin_fake',
    };

    expect(loadProjectRegistry(env)).toEqual([
      {
        project: 'project-linear',
        repo: 'flair-hr/project-linear',
        trackerType: 'linear',
        tokenEnvVar: 'GITHUB_TOKEN__PROJECT_LINEAR',
        linearTeamKey: 'ENG',
        linearTokenEnvVar: 'LINEAR_TOKEN__PROJECT_LINEAR',
        linearTriggerLabelId: 'label-uuid',
        token: 'ghp_fake',
        linearToken: 'lin_fake',
      },
    ]);
  });

  it('throws naming the project and env var when a referenced linearTokenEnvVar is missing', () => {
    const env = {
      PROJECT_REGISTRY_JSON: JSON.stringify([
        {
          project: 'project-linear',
          repo: 'flair-hr/project-linear',
          trackerType: 'linear',
          tokenEnvVar: 'GITHUB_TOKEN__PROJECT_LINEAR',
          linearTeamKey: 'ENG',
          linearTokenEnvVar: 'LINEAR_TOKEN__PROJECT_LINEAR',
          linearTriggerLabelId: 'label-uuid',
        },
      ]),
      GITHUB_TOKEN__PROJECT_LINEAR: 'ghp_fake',
    };

    expect(() => loadProjectRegistry(env)).toThrow(/"LINEAR_TOKEN__PROJECT_LINEAR".*"project-linear"/);
  });

  it('resolves multiple entries independently', () => {
    const env = {
      PROJECT_REGISTRY_JSON: JSON.stringify([
        { project: 'project-a', repo: 'flair-hr/project-a', trackerType: 'github', tokenEnvVar: 'GITHUB_TOKEN__PROJECT_A' },
        { project: 'project-b', repo: 'flair-hr/project-b', trackerType: 'github', tokenEnvVar: 'GITHUB_TOKEN__PROJECT_B' },
      ]),
      GITHUB_TOKEN__PROJECT_A: 'token-a',
      GITHUB_TOKEN__PROJECT_B: 'token-b',
    };

    const resolved = loadProjectRegistry(env);

    expect(resolved.map((entry) => entry.token)).toEqual(['token-a', 'token-b']);
  });
});
