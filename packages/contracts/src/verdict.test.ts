import { describe, expect, it } from 'vitest';
import { VerdictSchema } from './verdict';

describe('VerdictSchema', () => {
  it('parses a pass verdict without findings', () => {
    expect(VerdictSchema.parse({ kind: 'pass' })).toEqual({ kind: 'pass' });
  });

  it('parses a fail verdict with findings', () => {
    const parsed = VerdictSchema.parse({ kind: 'fail', findings: ['lint error on line 3'] });
    expect(parsed.findings).toEqual(['lint error on line 3']);
  });

  it('rejects an invented kind', () => {
    expect(() => VerdictSchema.parse({ kind: 'maybe' })).toThrow();
  });
});
