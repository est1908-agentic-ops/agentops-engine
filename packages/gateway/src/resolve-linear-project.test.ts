import { describe, expect, it } from 'vitest';
import type { ResolvedProjectEntry } from '@agentops/contracts';
import { findLinearProjectEntry } from './resolve-linear-project';

const githubEntry: ResolvedProjectEntry = {
  project: 'project-a',
  repo: 'flair-hr/project-a',
  trackerType: 'github',
  tokenEnvVar: 'GITHUB_TOKEN__PROJECT_A',
  token: 'ghp_fake',
};

const linearEntry: ResolvedProjectEntry = {
  project: 'project-linear',
  repo: 'flair-hr/project-linear',
  trackerType: 'linear',
  tokenEnvVar: 'GITHUB_TOKEN__PROJECT_LINEAR',
  linearTeamKey: 'ENG',
  linearTokenEnvVar: 'LINEAR_TOKEN__PROJECT_LINEAR',
  linearTriggerLabelId: 'label-uuid',
  token: 'ghp_fake',
  linearToken: 'lin_fake',
};

describe('findLinearProjectEntry', () => {
  it('finds the linear entry matching the team key', () => {
    expect(findLinearProjectEntry([githubEntry, linearEntry], 'ENG')).toBe(linearEntry);
  });

  it('returns null when no linear entry matches', () => {
    expect(findLinearProjectEntry([githubEntry, linearEntry], 'OTHER')).toBeNull();
  });

  it('never matches a github entry even if it somehow shared a team key value', () => {
    expect(findLinearProjectEntry([githubEntry], 'ENG')).toBeNull();
  });
});
