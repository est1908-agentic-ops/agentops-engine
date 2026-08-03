import { z } from 'zod';

export const StageSchema = z.enum([
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
  'platform',
  'bughunt',
  'agent',
]);
export type Stage = z.infer<typeof StageSchema>;

// Read-only stages are those that must not mutate the workspace.
// Only `bughunt` is included today (least privilege for the read-only bughunt stage);
// other effectively read-only stages (`context`, `assess`, `review`) are deferred
// per the design's Assumptions section.
export const READ_ONLY_STAGES = new Set<Stage>(['bughunt']);

export function isReadOnlyStage(stage: Stage): boolean {
  return READ_ONLY_STAGES.has(stage);
}

export const TaskStatusSchema = z.enum(['pending', 'running', 'blocked', 'done', 'failed']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const BlockReasonSchema = z.enum([
  'needs-clarification',
  'iteration-brake',
  'token-brake',
  'babysit-brake',
  'max-attempts',
  'hook-required-failed',
  // A prompt-started devCycle (no pre-resolved config) whose repo isn't in
  // the worker's merged static+managed registry -- set together with
  // status 'failed' as a fail-fast, not a resumable block.
  'unregistered-repo',
  'pr-landing-blocked',
]);
export type BlockReason = z.infer<typeof BlockReasonSchema>;
