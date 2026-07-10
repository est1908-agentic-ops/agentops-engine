import { z } from 'zod';
import { RunStatusSchema } from './control-api';
import { DevCycleStateSchema } from './dev-cycle-state';

// List rows reuse RunListItemSchema from ./control-api -- it is already
// workflow-type-agnostic (workflowId, runId, status, startTime, closeTime?,
// promptSnippet?).

export const StartDevCycleRequestSchema = z.object({
  repo: z.string().min(1), // owner/repo -- must resolve to a registered project (422 otherwise)
  prompt: z.string().min(1), // becomes TaskInput.goal verbatim
  taskId: z.string().min(1).optional(), // default: randomUUID() in control
});
export type StartDevCycleRequest = z.infer<typeof StartDevCycleRequestSchema>;

export const StartDevCycleResponseSchema = z.object({
  workflowId: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().min(1),
});
export type StartDevCycleResponse = z.infer<typeof StartDevCycleResponseSchema>;

export const DevCycleRunDetailSchema = z.object({
  workflowId: z.string().min(1),
  runId: z.string().min(1),
  status: RunStatusSchema,
  prompt: z.string().min(1).optional(), // from the Temporal memo; absent for gateway/CLI-started runs
  state: DevCycleStateSchema.optional(), // live 'state' query while RUNNING, workflow result once COMPLETED
  error: z.string().min(1).optional(),
  temporalUrl: z.string().min(1),
});
export type DevCycleRunDetail = z.output<typeof DevCycleRunDetailSchema>;

export const DevCycleTargetSchema = z.object({
  repo: z.string().min(1),
  project: z.string().min(1),
});
export type DevCycleTarget = z.infer<typeof DevCycleTargetSchema>;

export const DevCycleTargetsResponseSchema = z.object({
  targets: z.array(DevCycleTargetSchema),
});
export type DevCycleTargetsResponse = z.infer<typeof DevCycleTargetsResponseSchema>;
