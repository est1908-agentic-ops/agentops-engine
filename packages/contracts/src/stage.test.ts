import { describe, expect, it } from 'vitest';
import { StageSchema, TaskStatusSchema, BlockReasonSchema } from './stage';

describe('StageSchema', () => {
  it('accepts every fixed-vocabulary stage', () => {
    const stages = [
      'context',
      'assess',
      'design',
      'plan',
      'implement',
      'full_verify',
      'review',
      'pr',
      'pr_babysit',
      'done',
      'failed',
    ];
    for (const stage of stages) {
      expect(StageSchema.parse(stage)).toBe(stage);
    }
  });

  it('accepts "platform" as a valid stage', () => {
    expect(StageSchema.parse('platform')).toBe('platform');
  });

  it('rejects an invented stage name', () => {
    expect(() => StageSchema.parse('deploy')).toThrow();
  });
});

describe('TaskStatusSchema', () => {
  it('accepts pending|running|blocked|done|failed', () => {
    for (const status of ['pending', 'running', 'blocked', 'done', 'failed']) {
      expect(TaskStatusSchema.parse(status)).toBe(status);
    }
  });
});

describe('BlockReasonSchema', () => {
  it('accepts every fixed block reason', () => {
    const reasons = [
      'needs-clarification',
      'iteration-brake',
      'token-brake',
      'babysit-brake',
      'max-attempts',
      'hook-required-failed',
      'budget-exceeded',
    ];
    for (const reason of reasons) {
      expect(BlockReasonSchema.parse(reason)).toBe(reason);
    }
  });
});
