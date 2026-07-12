import { z } from 'zod';
import { VerifyServiceSchema } from './project-config';
import { ModelRefSchema } from './model';
import { StageSchema } from './stage';

export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
// Verify stages (full_verify) drive the project's test suite / build as single
// long tool calls that legitimately produce no streamed output for far longer
// than the 5-minute global idle default while one command runs. A larger idle
// default -- still well under the 30-minute backstop -- keeps the runner from
// killing a working agent mid-suite. See resolveStageLimits.
export const DEFAULT_VERIFY_IDLE_TIMEOUT_MS = 900_000;
export const DEFAULT_BACKSTOP_TIMEOUT_MS = 1_800_000;

export const AgentRunLimitsSchema = z.object({
  maxTokens: z.number().int().positive(),
  idleTimeoutMs: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive(),
});
export type AgentRunLimits = z.infer<typeof AgentRunLimitsSchema>;

const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

export const AgentRunRequestSchema = z
  .object({
    taskId: z.string().min(1),
    stage: StageSchema,
    attempt: z.number().int().positive(),
    callIndex: z.number().int().positive().default(1),
    // When tier is set, the activity resolves it to a concrete ModelRef[]
    // (primary + session-limit fallback chain). When unset, backend+model
    // must be provided directly (the concrete-model path).
    tier: z.string().min(1).optional(),
    projectTiers: z.record(z.string(), z.array(ModelRefSchema)).optional(),
    backend: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    effort: EffortSchema.optional(),
    image: z.string().min(1).optional(),
    services: z.array(VerifyServiceSchema).optional(),
    promptRef: z.string().min(1),
    promptContext: z.record(z.string(), z.unknown()).default({}),
    promptSource: z
      .object({ repo: z.string().min(1), commit: z.string().min(1), path: z.string().min(1) })
      .optional(),
    workspaceRef: z.string().min(1),
    limits: AgentRunLimitsSchema,
  })
  .refine((req) => Boolean(req.tier) || (Boolean(req.backend) && Boolean(req.model)), {
    message: 'either tier or (backend + model) must be provided',
  });
export type AgentRunRequest = z.infer<typeof AgentRunRequestSchema>;

// The activity->backend boundary: always CONCRETE backend+model+prompt.
// Defined independently (not via .omit from AgentRunRequest) because the
// workflow->activity request may carry only a tier ref, while the backend
// must always receive a resolved, runnable model. prompt is the rendered
// string; tier/projectTiers/promptRef/promptContext do not cross this line.
export const BackendRunRequestSchema = z.object({
  taskId: z.string().min(1),
  stage: StageSchema,
  attempt: z.number().int().positive(),
  callIndex: z.number().int().positive().default(1),
  backend: z.string().min(1),
  model: z.string().min(1),
  effort: EffortSchema.optional(),
  image: z.string().min(1).optional(),
  services: z.array(VerifyServiceSchema).optional(),
  workspaceRef: z.string().min(1),
  limits: AgentRunLimitsSchema,
  prompt: z.string().min(1),
});
export type BackendRunRequest = z.infer<typeof BackendRunRequestSchema>;

export const AgentRunResultSchema = z.object({
  output: z.string(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  wallMs: z.number().int().nonnegative(),
  // Which backend/model actually ran (may differ from the primary when a
  // session-limit fallback succeeded). Populated by the activity layer; the
  // workflow reads these back for recordRunStats since it no longer holds a
  // concrete ModelRef.
  resolvedBackend: z.string().optional(),
  resolvedModel: z.string().optional(),
});
export type AgentRunResult = z.infer<typeof AgentRunResultSchema>;
