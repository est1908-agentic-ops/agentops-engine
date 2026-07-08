import { z } from 'zod';
import { ManagedProjectSchema } from './managed-project';
import { ProjectConfigSchema } from './project-config';

// POST /api/projects — create. `token` is required (you cannot create a
// managed project with no credential). `repo`/`project` are the identity.
export const CreateManagedProjectRequestSchema = z.object({
  project: z.string().min(1),
  repo: z.string().min(1),
  token: z.string().min(1),
  config: ProjectConfigSchema.nullable().optional(),
});
export type CreateManagedProjectRequest = z.infer<typeof CreateManagedProjectRequestSchema>;

// PUT /api/projects/:repo — update. `repo`/`project` are immutable identity
// (renaming either = delete + recreate), so neither appears in the body. A
// bare `{}` is a valid no-op; `token` rotates, `config: null` clears back to
// file-based, `config: <obj>` sets it, omitted `config` keeps it.
export const UpdateManagedProjectRequestSchema = z.object({
  token: z.string().min(1).optional(),
  config: ProjectConfigSchema.nullable().optional(),
});
export type UpdateManagedProjectRequest = z.infer<typeof UpdateManagedProjectRequestSchema>;

// GET /api/projects — list. Reuses ManagedProjectSchema, which carries
// `credentialSet: boolean` and never the token (design §7: no tokens, ever).
export const ManagedProjectListResponseSchema = z.array(ManagedProjectSchema);
export type ManagedProjectListResponse = z.infer<typeof ManagedProjectListResponseSchema>;
