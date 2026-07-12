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

// A stage routes to a named tier (not a concrete model), with an optional
// per-project effort override on top of the global tier. The tier resolves
// to an ordered ModelRef[] (primary + session-limit fallback chain).
export const StageRouteSchema = z.object({
  tier: z.string().min(1),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
});
export type StageRoute = z.infer<typeof StageRouteSchema>;

export const BrakesSchema = z.object({
  maxImplementAttempts: z.number().int().positive().default(3),
  maxIterations: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  maxBabysitRounds: z.number().int().positive(),
});
export type Brakes = z.infer<typeof BrakesSchema>;

export const RoutingSchema = z.object({
  context: StageRouteSchema.optional(),
  assess: StageRouteSchema.optional(),
  design: StageRouteSchema.optional(),
  plan: StageRouteSchema.optional(),
  implement: StageRouteSchema.optional(),
  full_verify: StageRouteSchema.optional(),
  review: StageRouteSchema.optional(),
  pr: StageRouteSchema.optional(),
  pr_babysit: StageRouteSchema.optional(),
  bughunt: StageRouteSchema.optional(),
  agent: StageRouteSchema.optional(),
});
export type Routing = z.infer<typeof RoutingSchema>;

export const StageTimeoutSchema = z.object({
  idleTimeoutMs: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
});
export type StageTimeout = z.infer<typeof StageTimeoutSchema>;

export const TimeoutsSchema = z.object({
  context: StageTimeoutSchema.optional(),
  assess: StageTimeoutSchema.optional(),
  design: StageTimeoutSchema.optional(),
  plan: StageTimeoutSchema.optional(),
  implement: StageTimeoutSchema.optional(),
  full_verify: StageTimeoutSchema.optional(),
  review: StageTimeoutSchema.optional(),
  pr: StageTimeoutSchema.optional(),
  pr_babysit: StageTimeoutSchema.optional(),
  bughunt: StageTimeoutSchema.optional(),
  agent: StageTimeoutSchema.optional(),
});
export type Timeouts = z.infer<typeof TimeoutsSchema>;

export const StageToggleSchema = z.object({
  assess: z.boolean().optional(),
  triage: z.boolean().optional(),
});
export type StageToggle = z.infer<typeof StageToggleSchema>;
