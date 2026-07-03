import { z, ZodError } from 'zod';
import { ModelRefSchema, BrakesSchema, RoutingSchema, StageToggleSchema } from './model';

export const ProductConfigSchema = z.object({
  fastVerifyCommands: z.array(z.string()).optional(),
  fullVerifyCommands: z.array(z.string()).optional(),
  stages: StageToggleSchema,
  routing: RoutingSchema,
  escalation: ModelRefSchema.optional(),
  brakes: BrakesSchema,
});
export type ProductConfig = z.infer<typeof ProductConfigSchema>;

export const DEFAULT_PRODUCT_CONFIG: Omit<ProductConfig, 'fastVerifyCommands' | 'fullVerifyCommands'> = {
  stages: {},
  routing: {
    context: { backend: 'claude', model: 'claude-sonnet-5', effort: 'medium' },
    assess: { backend: 'claude', model: 'claude-sonnet-5', effort: 'medium' },
    design: { backend: 'claude', model: 'claude-sonnet-5', effort: 'medium' },
    plan: { backend: 'claude', model: 'claude-sonnet-5', effort: 'medium' },
    implement: { backend: 'claude', model: 'claude-sonnet-5', effort: 'high' },
    full_verify: { backend: 'claude', model: 'claude-sonnet-5', effort: 'high' },
    review: { backend: 'claude', model: 'claude-sonnet-5', effort: 'high' },
  },
  brakes: { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 },
};

export class InvalidProductConfigError extends Error {
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

export function parseProductConfig(raw: unknown): ProductConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidProductConfigError('agentops.json must be a JSON object');
  }
  const rawConfig = raw as Partial<ProductConfig>;
  const merged = {
    ...DEFAULT_PRODUCT_CONFIG,
    ...rawConfig,
    stages: { ...DEFAULT_PRODUCT_CONFIG.stages, ...rawConfig.stages },
    routing: { ...DEFAULT_PRODUCT_CONFIG.routing, ...rawConfig.routing },
    brakes: { ...DEFAULT_PRODUCT_CONFIG.brakes, ...rawConfig.brakes },
  };
  try {
    return ProductConfigSchema.parse(merged);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new InvalidProductConfigError(formatZodError(err), err.issues);
    }
    throw err;
  }
}
