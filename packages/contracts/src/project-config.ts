import { z, ZodError } from 'zod';
import { ModelRefSchema, BrakesSchema, RoutingSchema, StageToggleSchema, TimeoutsSchema } from './model';

export const AutoMergeModeSchema = z.enum(['disabled', 'label', 'all']);
export type AutoMergeMode = z.infer<typeof AutoMergeModeSchema>;

export const VerifyServiceReadinessSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('exec'), command: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('tcpSocket'), port: z.number().int().positive() }),
]);
export type VerifyServiceReadiness = z.infer<typeof VerifyServiceReadinessSchema>;

export const VerifyServiceSchema = z.object({
  name: z.string().min(1),
  image: z.string().min(1),
  env: z.record(z.string(), z.string()).optional(),
  readiness: VerifyServiceReadinessSchema,
});
export type VerifyService = z.infer<typeof VerifyServiceSchema>;

export const ProjectConfigSchema = z.object({
  image: z.string().min(1).optional(),
  services: z.array(VerifyServiceSchema).optional(),
  initCommands: z.array(z.string()).optional(),
  fastVerifyCommands: z.array(z.string()).optional(),
  fullVerifyCommands: z.array(z.string()).optional(),
  stages: StageToggleSchema,
  routing: RoutingSchema,
  escalation: z.object({ tier: z.string().min(1) }).optional(),
  // Project-local tier definitions. On a name collision with a global tier
  // (SP3's DB table), the project-local entry wins -- mirrors how
  // DEFAULT_PROJECT_CONFIG merges with per-project overrides.
  tiers: z.record(z.string(), z.array(ModelRefSchema)).optional(),
  brakes: BrakesSchema,
  timeouts: TimeoutsSchema.optional(),
  autoMerge: AutoMergeModeSchema.optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const DEFAULT_PROJECT_CONFIG: Omit<
  ProjectConfig,
  'fastVerifyCommands' | 'fullVerifyCommands' | 'image' | 'services' | 'initCommands'
> = {
  stages: {},
  routing: {
    context: { tier: 'smart' },
    assess: { tier: 'smart' },
    design: { tier: 'smart', effort: 'medium' },
    plan: { tier: 'smart' },
    implement: { tier: 'implementation', effort: 'high' },
    full_verify: { tier: 'smart', effort: 'high' },
    review: { tier: 'review' },
  },
  escalation: { tier: 'escalation' },
  brakes: { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 },
  autoMerge: 'disabled' as const,
};

export class InvalidProjectConfigError extends Error {
  constructor(
    message: string,
    public readonly issues?: unknown,
  ) {
    super(message);
  }
}

function formatZodError(err: ZodError): string {
  return err.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

export function parseProjectConfig(raw: unknown): ProjectConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidProjectConfigError('agentops.json must be a JSON object');
  }
  const rawConfig = raw as Partial<ProjectConfig>;
  const merged = {
    ...DEFAULT_PROJECT_CONFIG,
    ...rawConfig,
    stages: { ...DEFAULT_PROJECT_CONFIG.stages, ...rawConfig.stages },
    routing: { ...DEFAULT_PROJECT_CONFIG.routing, ...rawConfig.routing },
    brakes: { ...DEFAULT_PROJECT_CONFIG.brakes, ...rawConfig.brakes },
  };
  try {
    return ProjectConfigSchema.parse(merged);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new InvalidProjectConfigError(formatZodError(err), err.issues);
    }
    throw err;
  }
}
