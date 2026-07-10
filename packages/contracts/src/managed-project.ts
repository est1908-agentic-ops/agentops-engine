import { z } from 'zod';
import { ProjectConfigSchema } from './project-config';

const BaseManagedProjectFields = {
  id: z.string().uuid(),
  project: z.string().min(1),
  repo: z.string().min(1),
  credentialSet: z.boolean(), // GitHub token set? never the token itself
  config: ProjectConfigSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
};

// A discriminated union so consumers (CLI/UI) get real narrowing on
// trackerType -- unlike the write-side schemas below, a stored/read project
// is always exactly one shape, never a partial patch.
export const ManagedProjectSchema = z.discriminatedUnion('trackerType', [
  z.object({ ...BaseManagedProjectFields, trackerType: z.literal('github') }),
  z.object({
    ...BaseManagedProjectFields,
    trackerType: z.literal('linear'),
    linearTeamKey: z.string().min(1),
    linearTriggerLabelId: z.string().min(1),
    linearCredentialSet: z.boolean(), // Linear token set? never the token itself
  }),
]);
export type ManagedProject = z.infer<typeof ManagedProjectSchema>;

// Store-level input (packages/activities' PostgresManagedProjectStore.upsert)
// -- one level below the API-facing Create/Update schemas in
// control-projects-api.ts, which is why trackerType/linear-field
// required-ness isn't enforced here: create vs. update have different rules
// (linear fields required on create, optional-and-kept-if-omitted on
// update), and that distinction only exists once the store knows whether a
// row already exists -- see PostgresManagedProjectStore.upsert.
export const UpsertManagedProjectRequestSchema = z.object({
  project: z.string().min(1),
  repo: z.string().min(1),
  token: z.string().min(1).optional(),
  config: ProjectConfigSchema.nullable().optional(),
  trackerType: z.enum(['github', 'linear']).default('github'),
  linearTeamKey: z.string().min(1).optional(),
  linearTriggerLabelId: z.string().min(1).optional(),
  linearToken: z.string().min(1).optional(),
});
// z.input, not z.infer/z.output: callers construct the pre-default shape
// (trackerType optional, defaulting to 'github' only once .parse() runs
// inside PostgresManagedProjectStore.upsert) -- z.infer would make
// trackerType required in the type, which every existing github-only call
// site (and test) never sets explicitly.
export type UpsertManagedProjectRequest = z.input<typeof UpsertManagedProjectRequestSchema>;
