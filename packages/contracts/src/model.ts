import { z } from 'zod';

export const ModelRefSchema = z.object({
  // 'litellm' is a transport kind (an HTTP call through the LiteLLM gateway),
  // not a provider -- `model` is the LiteLLM-side model_list alias (e.g.
  // "zai-glm-4.6"), never a raw provider string. See agentops-platform's
  // litellm-deploy-design.md for why that indirection matters.
  backend: z.enum(['claude', 'cursor', 'pi', 'codex', 'stub', 'litellm']),
  model: z.string().min(1),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const BrakesSchema = z.object({
  maxImplementAttempts: z.number().int().positive().default(3),
  maxIterations: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  maxBabysitRounds: z.number().int().positive(),
});
export type Brakes = z.infer<typeof BrakesSchema>;

export const RoutingSchema = z.object({
  context: ModelRefSchema.optional(),
  assess: ModelRefSchema.optional(),
  design: ModelRefSchema.optional(),
  plan: ModelRefSchema.optional(),
  implement: ModelRefSchema.optional(),
  full_verify: ModelRefSchema.optional(),
  review: ModelRefSchema.optional(),
  pr: ModelRefSchema.optional(),
  pr_babysit: ModelRefSchema.optional(),
});
export type Routing = z.infer<typeof RoutingSchema>;

export const StageToggleSchema = z.object({
  assess: z.boolean().optional(),
  triage: z.boolean().optional(),
});
export type StageToggle = z.infer<typeof StageToggleSchema>;
