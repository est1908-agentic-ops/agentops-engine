import { describe, expect, it } from 'vitest';
import { normalizeRepo, parseRef, parseRepoSlug } from './parse-ref';

describe('normalizeRepo', () => {
  it('leaves a short owner/repo unchanged (idempotent)', () => {
    expect(normalizeRepo('acme/webapp')).toBe('acme/webapp');
  });

  it('strips an https browser/clone URL down to owner/repo', () => {
    expect(normalizeRepo('https://github.com/acme/webapp')).toBe('acme/webapp');
    expect(normalizeRepo('https://github.com/acme/webapp.git')).toBe('acme/webapp');
    expect(normalizeRepo('https://github.com/acme/webapp/')).toBe('acme/webapp');
  });

  it('strips an SSH clone URL down to owner/repo', () => {
    expect(normalizeRepo('git@github.com:acme/webapp.git')).toBe('acme/webapp');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeRepo('  acme/webapp  ')).toBe('acme/webapp');
  });
});

describe('parseRef', () => {
  it('parses "owner/repo#123"', () => {
    expect(parseRef('octocat/hello-world#42')).toEqual({ owner: 'octocat', repo: 'hello-world', number: 42 });
  });

  it('throws a clear error on malformed input', () => {
    expect(() => parseRef('not-a-ref')).toThrow(/expected "owner\/repo#number"/);
    expect(() => parseRef('owner/repo')).toThrow();
    expect(() => parseRef('owner/repo#not-a-number')).toThrow();
  });
});

describe('parseRepoSlug', () => {
  it('parses "owner/repo"', () => {
    expect(parseRepoSlug('octocat/hello-world')).toEqual({ owner: 'octocat', repo: 'hello-world' });
  });

  it('throws a clear error on malformed input', () => {
    expect(() => parseRepoSlug('octocat/hello-world#42')).toThrow(/expected "owner\/repo"/);
    expect(() => parseRepoSlug('just-a-name')).toThrow();
  });
});
