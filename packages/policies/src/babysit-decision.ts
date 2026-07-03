import type { PrFeedback } from '@agentops/contracts';
import { feedbackHash } from '@agentops/contracts';

export type BabysitDecision = 'merge_ready' | 'actionable' | 'waiting' | 'braked';

export function babysitDecision(
  feedback: PrFeedback,
  seenHashes: ReadonlySet<string>,
  rounds: number,
  cap: number,
): BabysitDecision {
  const isMergeReady = feedback.ciStatus === 'green' && feedback.unresolvedThreads === 0;
  if (isMergeReady) {
    return 'merge_ready';
  }
  if (rounds >= cap) {
    return 'braked';
  }

  const isActionable = feedback.ciStatus === 'failed' || feedback.unresolvedThreads > 0;
  if (!isActionable) {
    return 'waiting';
  }

  return seenHashes.has(feedbackHash(feedback)) ? 'waiting' : 'actionable';
}
