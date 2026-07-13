import { z } from 'zod';
import { PlatformAgentResultSchema } from './platform-agent';

export const StartRunRequestSchema = z.object({
  prompt: z.string().min(1),
  hintRepos: z.array(z.string()).optional(),
  workflowId: z.string().min(1).optional(),
});
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;

export const StartRunResponseSchema = z.object({
  workflowId: z.string().min(1),
  runId: z.string().min(1),
});
export type StartRunResponse = z.infer<typeof StartRunResponseSchema>;

// Matches @temporalio/client's WorkflowExecutionStatusName, minus the values
// ('UNSPECIFIED' | 'PAUSED' | 'UNKNOWN') that don't apply to a Workflow
// Execution that has actually started and been fetched.
export const RunStatusSchema = z.enum([
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TERMINATED',
  'TIMED_OUT',
  'CONTINUED_AS_NEW',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunListItemSchema = z.object({
  workflowId: z.string().min(1),
  runId: z.string().min(1),
  status: RunStatusSchema,
  startTime: z.string().min(1),
  closeTime: z.string().min(1).optional(),
  // Truncated prompt text from the Temporal memo set at start -- NOT
  // PlatformAgentResult.summary, which only exists once a run completes.
  promptSnippet: z.string().min(1).optional(),
});
export type RunListItem = z.infer<typeof RunListItemSchema>;

export const RunDetailSchema = z.object({
  workflowId: z.string().min(1),
  runId: z.string().min(1),
  status: RunStatusSchema,
  prompt: z.string().min(1).optional(),
  result: PlatformAgentResultSchema.optional(),
  error: z.string().min(1).optional(),
  temporalUrl: z.string().min(1),
});
export type RunDetail = z.output<typeof RunDetailSchema>;

export const RepoListResponseSchema = z.object({
  repos: z.array(z.string()),
});
export type RepoListResponse = z.infer<typeof RepoListResponseSchema>;

// --- budgets (simple subscription / spend dashboard, 2026-07-13 simple slice) ---

export const RateWindowViewSchema = z.object({
  maxCalls: z.number().int().nonnegative(),
  windowHours: z.number().nonnegative(),
  configured: z.boolean(),
});
export type RateWindowView = z.infer<typeof RateWindowViewSchema>;

export const OpenRouterSpendSchema = z.object({
  estimatedUsd: z.number(),
  totalTokens: z.number().int().nonnegative(),
  period: z.string(),
  modelBreakdown: z.array(
    z.object({
      model: z.string(),
      tokens: z.number().int().nonnegative(),
      estimatedUsd: z.number(),
    }),
  ),
});
export type OpenRouterSpend = z.infer<typeof OpenRouterSpendSchema>;

export const ClaudeUsageSchema = z.object({
  totalCalls: z.number().int().nonnegative(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  period: z.string(),
  modelBreakdown: z.array(
    z.object({
      model: z.string(),
      calls: z.number().int().nonnegative(),
      tokens: z.number().int().nonnegative(),
    }),
  ),
});
export type ClaudeUsage = z.infer<typeof ClaudeUsageSchema>;

export const BudgetsResponseSchema = z.object({
  rateWindows: z.object({
    claude: RateWindowViewSchema,
    pi: RateWindowViewSchema,
  }),
  claude: ClaudeUsageSchema,
  openRouter: OpenRouterSpendSchema,
});
export type BudgetsResponse = z.infer<typeof BudgetsResponseSchema>;
