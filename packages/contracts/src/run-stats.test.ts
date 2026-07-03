import { describe, expect, it } from 'vitest';
import { RunStatsSchema } from './run-stats';

describe('RunStatsSchema', () => {
  it('parses a full run-stats record', () => {
    const parsed = RunStatsSchema.parse({
      taskId: 'task-1',
      stage: 'implement',
      backend: 'stub',
      model: 'stub-v1',
      tokensIn: 100,
      tokensOut: 50,
      wallMs: 1200,
      outcome: 'pass',
    });
    expect(parsed.outcome).toBe('pass');
  });
});
