import { describe, expect, it } from 'vitest';
import { InvalidProjectRegistryError, parseProjectRegistry, ProjectRegistrySchema } from './project-registry';

const validEntry = {
  project: 'project-a',
  repo: 'flair-hr/project-a',
  trackerType: 'github',
  tokenEnvVar: 'GITHUB_TOKEN__PROJECT_A',
};

describe('ProjectRegistrySchema', () => {
  it('parses an array of valid entries', () => {
    expect(ProjectRegistrySchema.parse([validEntry])).toEqual([validEntry]);
  });

  it('rejects a trackerType other than github', () => {
    expect(() => ProjectRegistrySchema.parse([{ ...validEntry, trackerType: 'gitea' }])).toThrow();
  });

  it('rejects a non-array', () => {
    expect(() => ProjectRegistrySchema.parse(validEntry)).toThrow();
  });

  it('rejects an entry missing a required field', () => {
    const { tokenEnvVar: _tokenEnvVar, ...withoutTokenEnvVar } = validEntry;
    expect(() => ProjectRegistrySchema.parse([withoutTokenEnvVar])).toThrow();
  });
});

describe('parseProjectRegistry', () => {
  it('returns an empty array for an empty registry', () => {
    expect(parseProjectRegistry([])).toEqual([]);
  });

  it('passes through a valid registry with distinct projects/repos/tokenEnvVars', () => {
    const second = {
      project: 'project-b',
      repo: 'flair-hr/project-b',
      trackerType: 'github',
      tokenEnvVar: 'GITHUB_TOKEN__PROJECT_B',
    };
    expect(parseProjectRegistry([validEntry, second])).toEqual([validEntry, second]);
  });

  it('throws InvalidProjectRegistryError on a schema violation', () => {
    expect(() =>
      parseProjectRegistry([{ project: '', repo: 'x', trackerType: 'github', tokenEnvVar: 'X' }]),
    ).toThrow(InvalidProjectRegistryError);
  });

  it('throws InvalidProjectRegistryError on a non-array', () => {
    expect(() => parseProjectRegistry(validEntry)).toThrow(InvalidProjectRegistryError);
  });

  it('throws naming a duplicate project', () => {
    const duplicate = { ...validEntry, repo: 'flair-hr/other-repo', tokenEnvVar: 'GITHUB_TOKEN__OTHER' };
    expect(() => parseProjectRegistry([validEntry, duplicate])).toThrow(/duplicate project "project-a"/);
  });

  it('throws naming a duplicate repo', () => {
    const duplicate = { ...validEntry, project: 'project-c', tokenEnvVar: 'GITHUB_TOKEN__OTHER' };
    expect(() => parseProjectRegistry([validEntry, duplicate])).toThrow(/duplicate repo "flair-hr\/project-a"/);
  });

  it('throws naming a duplicate tokenEnvVar', () => {
    const duplicate = { ...validEntry, project: 'project-c', repo: 'flair-hr/other-repo' };
    expect(() => parseProjectRegistry([validEntry, duplicate])).toThrow(
      /duplicate tokenEnvVar "GITHUB_TOKEN__PROJECT_A"/,
    );
  });
});
