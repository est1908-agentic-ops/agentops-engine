import { z } from 'zod';

export const WhiteboxFindingSchema = z.object({
  title: z.string().min(1),
  detail: z.string().min(1),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  location: z.string().min(1), // e.g. "src/db.ts:42"
});
export type WhiteboxFinding = z.infer<typeof WhiteboxFindingSchema>;
