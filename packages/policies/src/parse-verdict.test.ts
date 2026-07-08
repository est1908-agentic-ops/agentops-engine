import { describe, expect, it } from 'vitest';
import { parseVerdict } from './parse-verdict';

describe('parseVerdict', () => {
  it('parses a clean PASS', () => {
    expect(parseVerdict('all good\nVERDICT: PASS', 'VERDICT:')).toEqual({ kind: 'pass' });
  });

  it('parses a FAIL with findings text', () => {
    expect(parseVerdict('VERDICT: FAIL missing null check', 'VERDICT:')).toEqual({
      kind: 'fail',
      findings: ['missing null check'],
    });
  });

  it('returns unparseable when the sentinel is missing entirely', () => {
    expect(parseVerdict('looks fine to me', 'VERDICT:')).toEqual({ kind: 'unparseable' });
  });

  it('returns unparseable when the sentinel value is garbled', () => {
    expect(parseVerdict('VERDICT: MAYBE', 'VERDICT:')).toEqual({ kind: 'unparseable' });
  });

  it('the last sentinel match wins when the agent restates its verdict', () => {
    const text = 'VERDICT: FAIL nope\nactually wait\nVERDICT: PASS';
    expect(parseVerdict(text, 'VERDICT:')).toEqual({ kind: 'pass' });
  });

  it('supports a different sentinel prefix (full_verify uses FULL:)', () => {
    expect(parseVerdict('FULL: FAIL 2 tests failed', 'FULL:')).toEqual({
      kind: 'fail',
      findings: ['2 tests failed'],
    });
  });

  it('never matches a sentinel prefix that only appears mid-line', () => {
    expect(parseVerdict('not a VERDICT: PASS really', 'VERDICT:')).toEqual({ kind: 'unparseable' });
  });

  it('tolerates a bold-wrapped sentinel line', () => {
    expect(parseVerdict('Looks good.\n**FULL: PASS**', 'FULL:')).toEqual({ kind: 'pass' });
  });

  it('tolerates a bullet-prefixed sentinel line', () => {
    expect(parseVerdict('- FULL: PASS', 'FULL:')).toEqual({ kind: 'pass' });
  });

  it('tolerates a blockquote-prefixed sentinel line', () => {
    expect(parseVerdict('> FULL: FAIL missing tests', 'FULL:')).toEqual({
      kind: 'fail',
      findings: ['missing tests'],
    });
  });

  it('tolerates a heading-prefixed sentinel line', () => {
    expect(parseVerdict('#### FULL: PASS', 'FULL:')).toEqual({ kind: 'pass' });
  });

  it('still never matches a sentinel that only appears after real words on the line', () => {
    expect(parseVerdict('Summary: FULL: PASS', 'FULL:')).toEqual({ kind: 'unparseable' });
  });
});
