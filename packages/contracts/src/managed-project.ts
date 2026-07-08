import { z } from 'zod';
import { ProjectConfigSchema } from './project-config';

export const ManagedProjectSchema = z.object({
  id: z.string().uuid(),
  project: z.string().min(1),
  repo: z.string().min(1),
  credentialSet: z.boolean(),
  config: ProjectConfigSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ManagedProject = z.infer<typeof ManagedProjectSchema>;

export const UpsertManagedProjectRequestSchema = z.object({
  project: z.string().min(1),
  repo: z.string().min(1),
  token: z.string().min(1).optional(),
  config: ProjectConfigSchema.nullable().optional(),
});
export type UpsertManagedProjectRequest = z.infer<typeof UpsertManagedProjectRequestSchema>;
