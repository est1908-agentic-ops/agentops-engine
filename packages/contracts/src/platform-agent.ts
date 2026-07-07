import { z } from 'zod';

export const ProposedFixSchema = z.object({
  repo: z.string().min(1),
  goal: z.string().min(1),
});
export type ProposedFix = z.infer<typeof ProposedFixSchema>;

export const PlatformActionSchema = z.object({
  type: z.enum(['terminate', 'signal']),
  workflowId: z.string().min(1),
  reason: z.string().min(1),
});
export type PlatformAction = z.infer<typeof PlatformActionSchema>;

// What the platform-role agent emits after its sentinel line (PLATFORM_RESULT:,
// see packages/policies/src/parse-platform-result.ts). Not the workflow's return
// type -- proposedFixes gets consumed to start child devCycle runs and replaced
// with real childWorkflows (PlatformAgentResultSchema below) before returning.
export const PlatformSentinelSchema = z.object({
  summary: z.string().min(1),
  actionsTaken: z.array(PlatformActionSchema).default([]),
  proposedFixes: z.array(ProposedFixSchema).default([]),
});
export type PlatformSentinelPayload = z.infer<typeof PlatformSentinelSchema>;

export const PlatformAgentInputSchema = z.object({
  prompt: z.string().min(1),
  hintRepos: z.array(z.string()).optional(),
});
export type PlatformAgentInput = z.infer<typeof PlatformAgentInputSchema>;

export const PlatformAgentResultSchema = z.object({
  summary: z.string(),
  actionsTaken: z.array(PlatformActionSchema).default([]),
  childWorkflows: z
    .array(
      z.object({
        workflowId: z.string().min(1),
        repo: z.string().min(1),
        goal: z.string().min(1),
      }),
    )
    .default([]),
});
export type PlatformAgentResult = z.output<typeof PlatformAgentResultSchema>;
