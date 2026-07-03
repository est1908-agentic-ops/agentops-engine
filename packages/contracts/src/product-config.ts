import { z } from 'zod';
import { ModelRefSchema, BrakesSchema, RoutingSchema, StageToggleSchema } from './model';

export const ProductConfigSchema = z.object({
  fastVerifyCommands: z.array(z.string()),
  fullVerifyCommands: z.array(z.string()),
  stages: StageToggleSchema,
  routing: RoutingSchema,
  escalation: ModelRefSchema.optional(),
  brakes: BrakesSchema,
});
export type ProductConfig = z.infer<typeof ProductConfigSchema>;
