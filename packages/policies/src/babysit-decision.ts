import type { PrFeedback } from '@agentops/contracts';
import { feedbackHash } from '@agentops/contracts';

export type BabysitDecision = 'merge_ready' | 'actionable' | 'waiting' | 'braked';

export function babysitDecision(
  feedback: PrFeedback,
  seenHashes: ReadonlySet<string>,
  rounds: number,
  cap: number,
  // Consecutive no-progress polls so far, and the cap on them. A `waiting` round
  // -- unlike an `actionable` repair round -- never advances `rounds`, so without
  // this bound a PR whose CI never resolves (e.g. GitHub Actions checks the token
  // can't read, so getPrFeedback returns `pending` forever) would babysit-poll
  // indefinitely. Bounded, it becomes `braked` and blocks for a human instead.
  // Defaults keep the old 4-arg behavior (unbounded waiting) for existing callers.
  waitingRounds = 0,
  maxWaitingRounds = Number.POSITIVE_INFINITY,
  // A live `pending` status is CI genuinely still running -- not a stall. The
  // un-pollable case ("the token can't read the Checks API") now surfaces
  // distinctly as `unreadable` (braked immediately, below), so `pending` no
  // longer needs the short stale-feedback cap that once guarded against it.
  // Give it its own, much larger budget so a slow CI *queue* doesn't dead-end
  // into a human-only brake before CI even starts (the devcycle-109 hang: CI
  // queued ~52min, the 20min cap braked at ~20min, nothing re-polled after).
  // Defaults to `maxWaitingRounds` so 6-arg callers keep the old behavior.
  maxPendingWaits = maxWaitingRounds,
): BabysitDecision {
  const isMergeReady = feedback.ciStatus === 'green' && feedback.unresolvedThreads === 0;
  if (isMergeReady) {
    return 'merge_ready';
  }
  // `unreadable` means a source (Checks API, Statuses API, or both) is
  // structurally unreadable with the current credentials -- not "still
  // running." No amount of polling fixes a permission problem, so brake
  // immediately instead of burning through `maxWaitingRounds` worth of
  // no-op polls first.
  if (feedback.ciStatus === 'unreadable') {
    return 'braked';
  }
  if (rounds >= cap) {
    return 'braked';
  }

  const isActionable =
    (feedback.ciStatus === 'failed' || feedback.unresolvedThreads > 0) &&
    !seenHashes.has(feedbackHash(feedback));
  if (isActionable) {
    return 'actionable';
  }

  // Nothing actionable. A live `pending` CI gets its own (larger) budget --
  // it's still running, not stalled -- while stale/already-addressed feedback
  // brakes on the short no-progress cap.
  const budget = feedback.ciStatus === 'pending' ? maxPendingWaits : maxWaitingRounds;
  return waitingRounds >= budget ? 'braked' : 'waiting';
}
