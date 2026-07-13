import { z } from 'zod';
import { sha256Hex } from './sha256';

export const CiStatusSchema = z.enum(['pending', 'green', 'failed', 'unreadable']);
export type CiStatus = z.infer<typeof CiStatusSchema>;

export const PrCommentSchema = z.object({
  id: z.string().min(1),
  body: z.string(),
  resolved: z.boolean(),
});
export type PrComment = z.infer<typeof PrCommentSchema>;

export const PrFeedbackSchema = z.object({
  ciStatus: CiStatusSchema,
  unresolvedThreads: z.number().int().nonnegative(),
  comments: z.array(PrCommentSchema),
});
export type PrFeedback = z.infer<typeof PrFeedbackSchema>;

export function feedbackHash(feedback: PrFeedback): string {
  const unresolvedIds = feedback.comments
    .filter((comment) => !comment.resolved)
    .map((comment) => comment.id)
    .sort();
  const payload = JSON.stringify({
    ciStatus: feedback.ciStatus,
    unresolvedThreads: feedback.unresolvedThreads,
    unresolvedIds,
  });
  return sha256Hex(payload);
}
