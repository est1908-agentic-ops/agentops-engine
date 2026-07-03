import { z } from 'zod';

export const VerdictKindSchema = z.enum(['pass', 'fail', 'unparseable']);
export type VerdictKind = z.infer<typeof VerdictKindSchema>;

export const VerdictSchema = z.object({
  kind: VerdictKindSchema,
  findings: z.array(z.string()).optional(),
});
export type Verdict = z.infer<typeof VerdictSchema>;
