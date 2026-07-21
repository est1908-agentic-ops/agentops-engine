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
const unreadableFeedback: PrFeedback = {
  ciStatus: 'unreadable',
  unresolvedThreads: 0,
  comments: [],
};

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

  it('keeps waiting on pending CI while under the no-progress cap', () => {
    expect(babysitDecision(pendingFeedback, new Set(), 0, 5, 3, 10)).toBe('waiting');
  });

  it('brakes once the no-progress (waiting) cap is reached, so pending CI cannot spin forever', () => {
    // The regression: CI the token can't read stays `pending` on every poll ->
    // never actionable -> `rounds` never advances -> without this it waits forever.
    expect(babysitDecision(pendingFeedback, new Set(), 0, 5, 10, 10)).toBe('braked');
  });

  it('also brakes on the no-progress cap when actionable feedback was already addressed', () => {
    const seen = new Set([feedbackHash(failedFeedback)]);
    expect(babysitDecision(failedFeedback, seen, 0, 5, 10, 10)).toBe('braked');
  });

  it('still prefers merge_ready / actionable over the no-progress brake', () => {
    expect(babysitDecision(greenFeedback, new Set(), 0, 5, 99, 10)).toBe('merge_ready');
    expect(babysitDecision(failedFeedback, new Set(), 0, 5, 99, 10)).toBe('actionable');
  });

  // A live `pending` status means CI is genuinely still running (the
  // un-pollable permission case is `unreadable`, braked above). A slow CI
  // queue must not dead-end into a human-only brake on the short
  // stale-feedback budget -- the real devcycle-109 hang: CI queued ~52min but
  // the 20min budget braked at ~20min, then nothing re-polled. So `pending`
  // gets its own, much larger `maxPendingWaits` budget.
  it('keeps waiting on pending CI past the stale-feedback cap when the pending budget is larger', () => {
    // waitingRounds (100) is well past maxWaitingRounds (10) but under maxPendingWaits (300).
    expect(babysitDecision(pendingFeedback, new Set(), 0, 5, 100, 10, 300)).toBe('waiting');
  });

  it('brakes pending CI once its own (larger) pending budget is exhausted', () => {
    expect(babysitDecision(pendingFeedback, new Set(), 0, 5, 300, 10, 300)).toBe('braked');
  });

  it('still brakes stale/already-addressed feedback at the short cap even when the pending budget is large', () => {
    // Not pending -> uses maxWaitingRounds (10), not maxPendingWaits (300).
    const seen = new Set([feedbackHash(failedFeedback)]);
    expect(babysitDecision(failedFeedback, seen, 0, 5, 10, 10, 300)).toBe('braked');
  });

  it('defaults maxPendingWaits to maxWaitingRounds (back-compat: pending shares the short cap)', () => {
    // 6-arg callers keep the old behavior: pending brakes at maxWaitingRounds.
    expect(babysitDecision(pendingFeedback, new Set(), 0, 5, 10, 10)).toBe('braked');
  });

  it('still brakes pending CI immediately when unreadable, regardless of the pending budget', () => {
    expect(babysitDecision(unreadableFeedback, new Set(), 0, 5, 0, 10, 300)).toBe('braked');
  });

  it('defaults to unbounded waiting for the legacy 4-arg call', () => {
    expect(babysitDecision(pendingFeedback, new Set(), 0, 5)).toBe('waiting');
  });

  it('brakes immediately when CI is unreadable (permission problem), without waiting on the no-progress cap', () => {
    // Unlike `pending`, `unreadable` means retrying can never resolve it -- no
    // point burning maxWaitingRounds worth of no-op polls first.
    expect(babysitDecision(unreadableFeedback, new Set(), 0, 5)).toBe('braked');
  });

  it('brakes on unreadable CI even on the very first round, before any waiting rounds have accrued', () => {
    expect(babysitDecision(unreadableFeedback, new Set(), 0, 5, 0, 10)).toBe('braked');
  });
});
