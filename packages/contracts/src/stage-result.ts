import { z } from 'zod';
import { StageSchema } from './stage';

export const StageSourceSchema = z.enum(['agent', 'human', 'triage']);
export type StageSource = z.infer<typeof StageSourceSchema>;

export const StageOutcomeSchema = z.enum(['pass', 'fail', 'unparseable', 'skipped']);
export type StageOutcome = z.infer<typeof StageOutcomeSchema>;

export const StageResultSchema = z.object({
  stage: StageSchema,
  source: StageSourceSchema,
  contentHash: z.string().min(1),
  tokens: z.number().int().nonnegative(),
  outcome: StageOutcomeSchema,
});
export type StageResult = z.infer<typeof StageResultSchema>;
