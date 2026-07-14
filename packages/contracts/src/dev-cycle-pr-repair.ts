import { z } from 'zod';
import { ProjectConfigSchema } from './project-config';

export const DevCyclePrRepairInputSchema = z.object({
  taskId: z.string().min(1),
  project: z.string().min(1),
  repo: z.string().min(1),
  prRef: z.string().min(1), // "owner/repo#123"
  prReviewFeedback: z.string().optional(),
  headBranch: z.string().optional(),  // PR head branch name for repair workspace
  // Optional; resolved on worker if absent (same as TaskInput)
  config: ProjectConfigSchema.optional(),
});

export type DevCyclePrRepairInput = z.infer<typeof DevCyclePrRepairInputSchema>;
