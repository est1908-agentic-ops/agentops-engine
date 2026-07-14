import { describe, it, expect } from 'vitest';
import { parseFindings, findingFingerprint } from './parse-findings';

describe('parseFindings', () => {
  it('parses a FINDINGS: json array', () => {
    const out = 'blah\nFINDINGS: [{"title":"X","detail":"d","severity":"high","location":"src/a.ts:1"}]\n';
    expect(parseFindings(out)).toHaveLength(1);
  });
  it('returns [] on unparseable / missing / bad json (never throws)', () => {
    expect(parseFindings('nothing here')).toEqual([]);
    expect(parseFindings('FINDINGS: not json')).toEqual([]);
    expect(parseFindings('FINDINGS: [{"title":"x"}]')).toEqual([]); // fails schema -> dropped
  });
});

describe('findingFingerprint', () => {
  const baseFind = { title: 'Bug in function', detail: 'some detail', severity: 'high' as const, location: 'src/db.ts:42' };

  it('detail does not affect the fingerprint', () => {
    expect(findingFingerprint(baseFind)).toBe(findingFingerprint({ ...baseFind, detail: 'different detail' }));
  });

  it('line number does not affect the fingerprint (line-number invariance)', () => {
    const fp1 = findingFingerprint({ ...baseFind, location: 'src/db.ts:1' });
    const fp2 = findingFingerprint({ ...baseFind, location: 'src/db.ts:42' });
    const fp3 = findingFingerprint({ ...baseFind, location: 'src/db.ts:999' });
    expect(fp1).toBe(fp2);
    expect(fp2).toBe(fp3);
  });

  it('line:column format does not affect the fingerprint', () => {
    const fp1 = findingFingerprint({ ...baseFind, location: 'src/db.ts:42:7' });
    const fp2 = findingFingerprint({ ...baseFind, location: 'src/db.ts:42' });
    expect(fp1).toBe(fp2);
  });

  it('line range format does not affect the fingerprint', () => {
    const fp1 = findingFingerprint({ ...baseFind, location: 'src/db.ts:42-50' });
    const fp2 = findingFingerprint({ ...baseFind, location: 'src/db.ts:42' });
    expect(fp1).toBe(fp2);
  });

  it('path with no suffix is unchanged', () => {
    const fp1 = findingFingerprint({ ...baseFind, location: 'src/db.ts' });
    const fp2 = findingFingerprint({ ...baseFind, location: 'src/db.ts:42' });
    expect(fp1).toBe(fp2);
  });

  it('different file paths with the same title produce different fingerprints', () => {
    const fp1 = findingFingerprint({ ...baseFind, location: 'src/db.ts:42' });
    const fp2 = findingFingerprint({ ...baseFind, location: 'src/other.ts:42' });
    expect(fp1).not.toBe(fp2);
  });

  it('different titles at the same path produce different fingerprints', () => {
    const fp1 = findingFingerprint({ ...baseFind, title: 'Bug in function' });
    const fp2 = findingFingerprint({ ...baseFind, title: 'Different bug' });
    expect(fp1).not.toBe(fp2);
  });

  it('case and whitespace in title do not affect the fingerprint', () => {
    const fp1 = findingFingerprint({ ...baseFind, title: 'Bug in function' });
    const fp2 = findingFingerprint({ ...baseFind, title: 'BUG IN FUNCTION' });
    const fp3 = findingFingerprint({ ...baseFind, title: 'Bug   in   function' });
    expect(fp1).toBe(fp2);
    expect(fp2).toBe(fp3);
  });

  it('non-numeric trailing segment is left intact', () => {
    const fp1 = findingFingerprint({ ...baseFind, location: 'src/db.ts:foo' });
    const fp2 = findingFingerprint({ ...baseFind, location: 'src/db.ts' });
    expect(fp1).not.toBe(fp2);
  });
});
