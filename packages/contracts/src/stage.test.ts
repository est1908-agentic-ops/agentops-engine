import { describe, expect, it } from 'vitest';
import { StageSchema, TaskStatusSchema, BlockReasonSchema, READ_ONLY_STAGES, isReadOnlyStage } from './stage';

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

  it('accepts the generic agent stage', () => {
    expect(StageSchema.parse('agent')).toBe('agent');
  });

  it('rejects an invented stage name', () => {
    expect(() => StageSchema.parse('deploy')).toThrow();
  });
});

describe('isReadOnlyStage / READ_ONLY_STAGES', () => {
  it('classifies exactly bughunt as read-only, all others as read-write', () => {
    const allStages = StageSchema.options;
    for (const stage of allStages) {
      if (stage === 'bughunt') {
        expect(isReadOnlyStage(stage)).toBe(true);
      } else {
        expect(isReadOnlyStage(stage)).toBe(false);
      }
    }
  });

  it('READ_ONLY_STAGES contains only bughunt', () => {
    expect(READ_ONLY_STAGES.size).toBe(1);
    expect(READ_ONLY_STAGES.has('bughunt')).toBe(true);
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
      'pr-landing-blocked',
    ];
    for (const reason of reasons) {
      expect(BlockReasonSchema.parse(reason)).toBe(reason);
    }
  });
});
