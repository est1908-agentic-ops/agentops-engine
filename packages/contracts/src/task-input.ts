import { z } from 'zod';
import { ProjectConfigSchema } from './project-config';

export const TaskInputSchema = z.object({
  taskId: z.string().min(1),
  project: z.string().min(1),
  repo: z.string().min(1),
  issueRef: z.string().optional(),
  goal: z.string().min(1),
  // Optional since the prompt-devcycle design (2026-07-09): when absent, the
  // devCycle workflow resolves it on the worker via resolveRepoConfig.
  // Gateway/CLI/platform-children keep pre-resolving and passing it.
  config: ProjectConfigSchema.optional(),
});
export type TaskInput = z.infer<typeof TaskInputSchema>;
