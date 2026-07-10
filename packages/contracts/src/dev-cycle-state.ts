import { z } from 'zod';
import { BlockReasonSchema, StageSchema, TaskStatusSchema } from './stage';

// The state the devCycle workflow maintains, exposes via its 'state' query,
// and returns as its result. Lives in contracts (not packages/workflows)
// because control reads it across a network boundary (AGENTS.md rule 3);
// packages/workflows re-exports the type for its existing importers.
export const DevCycleStateSchema = z.object({
  taskId: z.string().min(1),
  stage: StageSchema,
  status: TaskStatusSchema,
  blockReason: BlockReasonSchema.nullable(),
  implementAttempts: z.number().int().nonnegative(),
  iterations: z.number().int().nonnegative(),
  cumulativeTokens: z.number().int().nonnegative(),
  babysitRounds: z.number().int().nonnegative(),
  prRef: z.string().nullable(),
  workspaceRef: z.string(),
  branch: z.string(),
});
export type DevCycleState = z.infer<typeof DevCycleStateSchema>;
