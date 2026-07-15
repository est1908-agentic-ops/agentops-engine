import { z } from 'zod';
import { ManagedProjectSchema } from './managed-project';
import { ProjectConfigSchema } from './project-config';

// POST /api/projects — create. `token` is required (you cannot create a
// managed project with no credential). `repo`/`project` are the identity.
// `trackerType` is likewise immutable once created (like repo/project) --
// changing tracker means delete + recreate, so it never appears on update.
export const CreateManagedProjectRequestSchema = z
  .object({
    project: z.string().min(1),
    repo: z.string().min(1),
    token: z.string().min(1),
    config: ProjectConfigSchema.nullable().optional(),
    trackerType: z.enum(['github', 'linear']).default('github'),
    linearTeamKey: z.string().min(1).optional(),
    linearTriggerLabelId: z.string().min(1).optional(),
    linearToken: z.string().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.trackerType !== 'linear') {
      return;
    }
    if (!data.linearTeamKey) {
      ctx.addIssue({
        code: 'custom',
        path: ['linearTeamKey'],
        message: 'linearTeamKey is required when trackerType is "linear"',
      });
    }
    if (!data.linearTriggerLabelId) {
      ctx.addIssue({
        code: 'custom',
        path: ['linearTriggerLabelId'],
        message: 'linearTriggerLabelId is required when trackerType is "linear"',
      });
    }
    if (!data.linearToken) {
      ctx.addIssue({
        code: 'custom',
        path: ['linearToken'],
        message: 'linearToken is required when trackerType is "linear"',
      });
    }
  });
export type CreateManagedProjectRequest = z.infer<typeof CreateManagedProjectRequestSchema>;

// PUT /api/projects/:repo — update. `repo`/`project`/`trackerType` are
// immutable identity, so none appear in the body. A bare `{}` is a valid
// no-op; `token`/`linearToken` rotate, `config: null` clears back to
// file-based, `config: <obj>` sets it, omitted fields keep their current
// value. `linearTeamKey`/`linearTriggerLabelId` only make sense against an
// already-linear-tracked project -- the handler/store reject them otherwise.
export const UpdateManagedProjectRequestSchema = z.object({
  token: z.string().min(1).optional(),
  config: ProjectConfigSchema.nullable().optional(),
  linearTeamKey: z.string().min(1).optional(),
  linearTriggerLabelId: z.string().min(1).optional(),
  linearToken: z.string().min(1).optional(),
});
export type UpdateManagedProjectRequest = z.infer<typeof UpdateManagedProjectRequestSchema>;

// GET /api/projects — list. Reuses ManagedProjectSchema, which carries
// `credentialSet: boolean` and never the token (design §7: no tokens, ever).
export const ManagedProjectListResponseSchema = z.array(ManagedProjectSchema);
export type ManagedProjectListResponse = z.infer<typeof ManagedProjectListResponseSchema>;
