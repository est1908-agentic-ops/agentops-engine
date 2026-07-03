import { describe, expect, it } from 'vitest';
import { StageResultSchema } from './stage-result';

describe('StageResultSchema', () => {
  it('parses a human-authored design stage result', () => {
    const parsed = StageResultSchema.parse({
      stage: 'design',
      source: 'human',
      contentHash: 'abc123',
      tokens: 0,
      outcome: 'pass',
    });
    expect(parsed.source).toBe('human');
  });

  it('rejects a negative token count', () => {
    expect(() =>
      StageResultSchema.parse({
        stage: 'implement',
        source: 'agent',
        contentHash: 'abc',
        tokens: -1,
        outcome: 'pass',
      }),
    ).toThrow();
  });
});
