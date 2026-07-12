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
  it('fingerprint is stable and location-derived', () => {
    const f = { title: 'X', detail: 'd', severity: 'high' as const, location: 'src/a.ts:1' };
    expect(findingFingerprint(f)).toBe(findingFingerprint({ ...f, detail: 'different' }));
  });
});
