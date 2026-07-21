import { describe, expect, it } from 'vitest';
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

  it('accepts optional headBranch for PR repair workspace', () => {
    const input = {
      taskId: 't2',
      project: 'p',
      repo: 'o/r',
      prRef: 'o/r#99',
      headBranch: 'feature/fix-review',
    };
    const parsed = DevCyclePrRepairInputSchema.parse(input);
    expect(parsed.headBranch).toBe('feature/fix-review');
  });

  it('rejects invalid headBranch names', () => {
    expect(
      DevCyclePrRepairInputSchema.safeParse({
        taskId: 't3',
        project: 'p',
        repo: 'o/r',
        prRef: 'o/r#1',
        headBranch: '--upload-pack=/tmp/x',
      }).success,
    ).toBe(false);
    expect(
      DevCyclePrRepairInputSchema.safeParse({
        taskId: 't4',
        project: 'p',
        repo: 'o/r',
        prRef: 'o/r#2',
        headBranch: '-x',
      }).success,
    ).toBe(false);
  });
});
