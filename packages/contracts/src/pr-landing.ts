import { z } from 'zod';
import { CiStatusSchema, PrCommentSchema } from './pr-feedback';
import { AutoMergeModeSchema, ProjectConfigSchema } from './project-config';

export const AUTO_MERGE_LABEL = 'automerge';
export const AUTO_MERGE_DISABLE_LABEL = 'automerge:disable';
export const AGENTOPS_MANAGED_LABEL = 'agentops:managed';

export const PrSnapshotSchema = z.object({
  prRef: z.string().min(1),
  headSha: z.string().min(1),
  headRepo: z.string().min(1),
  headBranch: z.string().min(1),
  checkoutRef: z.string().min(1),
  labels: z.array(z.string()),
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  mergeable: z.boolean().nullable(),
  mergedHeadSha: z.string().min(1).nullable(),
  ciStatus: CiStatusSchema,
  unresolvedThreads: z.number().int().nonnegative(),
  comments: z.array(PrCommentSchema),
});
export type PrSnapshot = z.infer<typeof PrSnapshotSchema>;

export const MergePrRequestSchema = z.object({
  prRef: z.string().min(1),
  expectedHeadSha: z.string().min(1),
});
export type MergePrRequest = z.infer<typeof MergePrRequestSchema>;

export const MergePrResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('merged'),
    headSha: z.string().min(1),
    mergeCommitSha: z.string().min(1),
  }),
  z.object({ kind: z.literal('already-merged'), headSha: z.string().min(1) }),
  z.object({ kind: z.literal('head-changed') }),
  z.object({ kind: z.literal('not-mergeable'), reason: z.string().min(1) }),
  z.object({ kind: z.literal('forbidden'), reason: z.string().min(1) }),
]);
export type MergePrResult = z.infer<typeof MergePrResultSchema>;

export const PrLandingOutcomeSchema = z.enum([
  'merged',
  'merge-ready-manual',
  'blocked',
  'failed',
  'cancelled',
]);
export type PrLandingOutcome = z.infer<typeof PrLandingOutcomeSchema>;
export const PrLandingPhaseSchema = z.enum([
  'validating',
  'repairing',
  'babysitting',
  'merging',
  'blocked',
  'done',
]);
export const PrLandingBlockReasonSchema = z.enum([
  'repair-brake',
  'babysit-brake',
  'provider-refused',
  'permission-denied',
]);

export const PrLandingInputSchema = z.object({
  taskId: z.string().min(1),
  project: z.string().min(1),
  repo: z.string().min(1),
  prRef: z.string().min(1),
  agentCreated: z.boolean(),
  headBranch: z.string().min(1).optional(),
  workspace: z
    .object({
      workspaceRef: z.string().min(1),
      branch: z.string().min(1),
      validatedHeadSha: z.string().min(1),
    })
    .optional(),
  config: ProjectConfigSchema.optional(),
});
export type PrLandingInput = z.infer<typeof PrLandingInputSchema>;

export const PrLandingStateSchema = z.object({
  taskId: z.string().min(1),
  project: z.string().min(1),
  repo: z.string().min(1),
  phase: PrLandingPhaseSchema,
  outcome: PrLandingOutcomeSchema.nullable(),
  blockReason: PrLandingBlockReasonSchema.nullable(),
  prRef: z.string().min(1),
  agentCreated: z.boolean(),
  autoMergeMode: AutoMergeModeSchema,
  mergeResult: MergePrResultSchema.nullable(),
  workspaceRef: z.string(),
  branch: z.string(),
  currentHeadSha: z.string().nullable(),
  validatedHeadSha: z.string().nullable(),
  implementAttempts: z.number().int().nonnegative(),
  iterations: z.number().int().nonnegative(),
  cumulativeTokens: z.number().int().nonnegative(),
  babysitRounds: z.number().int().nonnegative(),
});
export type PrLandingState = z.infer<typeof PrLandingStateSchema>;
