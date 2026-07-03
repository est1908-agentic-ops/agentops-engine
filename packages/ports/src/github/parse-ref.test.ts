import { describe, expect, it } from 'vitest';
import { parseRef, parseRepoSlug } from './parse-ref';

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
