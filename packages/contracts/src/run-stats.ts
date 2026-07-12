import { z } from 'zod';
import { StageSchema } from './stage';
import { StageOutcomeSchema } from './stage-result';

export const RunStatsSchema = z.object({
  taskId: z.string().min(1),
  stage: StageSchema,
  backend: z.string().min(1),
  model: z.string().min(1),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  wallMs: z.number().int().nonnegative(),
  outcome: StageOutcomeSchema,
  // provenance + attribution (design §7) — optional so existing call sites compile
  promptHash: z.string().optional(),
  promptSource: z.string().optional(),
  project: z.string().optional(),
  workflowType: z.string().optional(),
});
export type RunStats = z.infer<typeof RunStatsSchema>;
