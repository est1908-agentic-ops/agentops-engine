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
export type RunDetail = z.infer<typeof RunDetailSchema>;

export const RepoListResponseSchema = z.object({
  repos: z.array(z.string()),
});
export type RepoListResponse = z.infer<typeof RepoListResponseSchema>;
