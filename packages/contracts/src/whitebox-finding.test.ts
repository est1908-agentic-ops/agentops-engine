import { describe, it, expect } from 'vitest';
import { WhiteboxFindingSchema } from './whitebox-finding';
import { StageSchema } from './stage';

describe('WhiteboxFinding + bughunt stage', () => {
  it('parses a finding', () => {
    const f = WhiteboxFindingSchema.parse({
      title: 'SQLi',
      detail: '...',
      severity: 'high',
      location: 'src/db.ts:42',
    });
    expect(f.severity).toBe('high');
  });
  it('bughunt is a valid stage', () => {
    expect(StageSchema.parse('bughunt')).toBe('bughunt');
  });
});
