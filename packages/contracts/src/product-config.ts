import { z, ZodError } from 'zod';
import { ModelRefSchema, BrakesSchema, RoutingSchema, StageToggleSchema } from './model';

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

export const ProductConfigSchema = z.object({
  image: z.string().min(1).optional(),
  services: z.array(VerifyServiceSchema).optional(),
  fastVerifyCommands: z.array(z.string()).optional(),
  fullVerifyCommands: z.array(z.string()).optional(),
  stages: StageToggleSchema,
  routing: RoutingSchema,
  escalation: ModelRefSchema.optional(),
  brakes: BrakesSchema,
});
export type ProductConfig = z.infer<typeof ProductConfigSchema>;

export const DEFAULT_PRODUCT_CONFIG: Omit<
  ProductConfig,
  'fastVerifyCommands' | 'fullVerifyCommands' | 'image' | 'services'
> = {
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
