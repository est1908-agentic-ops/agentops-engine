import { z } from 'zod';
import { VerifyServiceSchema } from './project-config';
import { StageSchema } from './stage';

export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
export const DEFAULT_BACKSTOP_TIMEOUT_MS = 1_800_000;

export const AgentRunLimitsSchema = z.object({
  maxTokens: z.number().int().positive(),
  idleTimeoutMs: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive(),
});
export type AgentRunLimits = z.infer<typeof AgentRunLimitsSchema>;

const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

export const AgentRunRequestSchema = z.object({
  taskId: z.string().min(1),
  stage: StageSchema,
  attempt: z.number().int().positive(),
  callIndex: z.number().int().positive().default(1),
  backend: z.string().min(1),
  model: z.string().min(1),
  effort: EffortSchema.optional(),
  image: z.string().min(1).optional(),
  services: z.array(VerifyServiceSchema).optional(),
  promptRef: z.string().min(1),
  promptContext: z.record(z.string(), z.unknown()).default({}),
  workspaceRef: z.string().min(1),
  limits: AgentRunLimitsSchema,
});
export type AgentRunRequest = z.infer<typeof AgentRunRequestSchema>;

export const BackendRunRequestSchema = AgentRunRequestSchema.omit({ promptRef: true, promptContext: true }).extend({
  prompt: z.string().min(1),
});
export type BackendRunRequest = z.infer<typeof BackendRunRequestSchema>;

export const AgentRunResultSchema = z.object({
  output: z.string(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  wallMs: z.number().int().nonnegative(),
});
export type AgentRunResult = z.infer<typeof AgentRunResultSchema>;
