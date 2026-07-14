import { DevCyclePrRepairInputSchema } from './dev-cycle-pr-repair';

describe('DevCyclePrRepairInputSchema', () => {
  it('parses minimal valid input', () => {
    const parsed = DevCyclePrRepairInputSchema.parse({
      taskId: 'pr-repair-foo-bar-123',
      project: 'myproj',
      repo: 'owner/repo',
      prRef: 'owner/repo#42',
    });
    expect(parsed.prRef).toBe('owner/repo#42');
    expect(parsed.prReviewFeedback).toBeUndefined();
  });

  it('accepts optional prReviewFeedback and config', () => {
    const input = {
      taskId: 't1',
      project: 'p',
      repo: 'o/r',
      prRef: 'o/r#7',
      prReviewFeedback: 'please fix the foo',
    };
    expect(() => DevCyclePrRepairInputSchema.parse(input)).not.toThrow();
  });
});
