import { describe, expect, it } from 'vitest';
import { linearRef, parseTrackerRef } from './tracker-ref';

describe('parseTrackerRef', () => {
  it('parses a GitHub-shaped ref', () => {
    expect(parseTrackerRef('octocat/hello-world#42')).toEqual({ kind: 'github', repo: 'octocat/hello-world' });
  });

  it('parses a Linear-shaped ref', () => {
    expect(parseTrackerRef('linear:ENG-123')).toEqual({ kind: 'linear', teamKey: 'ENG', identifier: 'ENG-123' });
  });

  it('throws on a malformed linear ref with no team key', () => {
    expect(() => parseTrackerRef('linear:-123')).toThrow(/expected "linear:TEAMKEY-number"/);
  });

  it('throws on a malformed linear ref with no separator', () => {
    expect(() => parseTrackerRef('linear:ENG123')).toThrow(/expected "linear:TEAMKEY-number"/);
  });

  it('throws a clear error on a malformed non-linear ref', () => {
    expect(() => parseTrackerRef('not-a-ref')).toThrow(/expected "owner\/repo#number"/);
  });
});

describe('linearRef', () => {
  it('prefixes an identifier with the linear scheme', () => {
    expect(linearRef('ENG-123')).toBe('linear:ENG-123');
  });
});
