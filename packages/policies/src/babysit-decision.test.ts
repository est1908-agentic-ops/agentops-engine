import { describe, expect, it } from 'vitest';
import type { PrFeedback } from '@agentops/contracts';
import { feedbackHash } from '@agentops/contracts';
import { babysitDecision } from './babysit-decision';

const greenFeedback: PrFeedback = { ciStatus: 'green', unresolvedThreads: 0, comments: [] };
const failedFeedback: PrFeedback = {
  ciStatus: 'failed',
  unresolvedThreads: 0,
  comments: [],
};
const pendingFeedback: PrFeedback = { ciStatus: 'pending', unresolvedThreads: 0, comments: [] };

describe('babysitDecision', () => {
  it('is merge_ready when CI is green and there are zero unresolved threads', () => {
    expect(babysitDecision(greenFeedback, new Set(), 0, 5)).toBe('merge_ready');
  });

  it('is waiting when CI is still pending and nothing is actionable', () => {
    expect(babysitDecision(pendingFeedback, new Set(), 0, 5)).toBe('waiting');
  });

  it('is actionable when CI failed and the feedback hash is new', () => {
    expect(babysitDecision(failedFeedback, new Set(), 0, 5)).toBe('actionable');
  });

  it('is waiting when the exact feedback set was already seen (dedupe)', () => {
    const seen = new Set([feedbackHash(failedFeedback)]);
    expect(babysitDecision(failedFeedback, seen, 0, 5)).toBe('waiting');
  });

  it('is actionable when unresolved review threads exist even if CI is green', () => {
    const feedback: PrFeedback = { ciStatus: 'green', unresolvedThreads: 2, comments: [] };
    expect(babysitDecision(feedback, new Set(), 0, 5)).toBe('actionable');
  });

  it('is braked once the round cap is reached, even with actionable feedback', () => {
    expect(babysitDecision(failedFeedback, new Set(), 5, 5)).toBe('braked');
  });

  it('prefers merge_ready over braked when the cap is reached but feedback is clean', () => {
    expect(babysitDecision(greenFeedback, new Set(), 5, 5)).toBe('merge_ready');
  });
});
