import { z } from 'zod';
import { ProjectConfigSchema } from './project-config';

export const TaskInputSchema = z.object({
  taskId: z.string().min(1),
  project: z.string().min(1),
  repo: z.string().min(1),
  issueRef: z.string().optional(),
  goal: z.string().min(1),
  config: ProjectConfigSchema,
});
export type TaskInput = z.infer<typeof TaskInputSchema>;
