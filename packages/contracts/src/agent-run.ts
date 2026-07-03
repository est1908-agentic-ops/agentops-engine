import { z } from 'zod';
import { StageSchema } from './stage';

export const AgentRunLimitsSchema = z.object({
  maxTokens: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
});
export type AgentRunLimits = z.infer<typeof AgentRunLimitsSchema>;

export const AgentRunRequestSchema = z.object({
  taskId: z.string().min(1),
  stage: StageSchema,
  attempt: z.number().int().positive(),
  callIndex: z.number().int().positive().default(1),
  backend: z.string().min(1),
  model: z.string().min(1),
  promptRef: z.string().min(1),
  workspaceRef: z.string().min(1),
  limits: AgentRunLimitsSchema,
});
export type AgentRunRequest = z.infer<typeof AgentRunRequestSchema>;

export const AgentRunResultSchema = z.object({
  output: z.string(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  wallMs: z.number().int().nonnegative(),
});
export type AgentRunResult = z.infer<typeof AgentRunResultSchema>;
