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
