import { z } from 'zod';
import { ProductConfigSchema } from './product-config';

export const TaskInputSchema = z.object({
  taskId: z.string().min(1),
  product: z.string().min(1),
  repo: z.string().min(1),
  issueRef: z.string().optional(),
  goal: z.string().min(1),
  config: ProductConfigSchema,
});
export type TaskInput = z.infer<typeof TaskInputSchema>;
