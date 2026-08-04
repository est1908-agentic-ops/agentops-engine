import { z } from 'zod';
import { ProjectConfigSchema } from './project-config';

const BaseManagedProjectFields = {
  id: z.string().uuid(),
  project: z.string().min(1),
  repo: z.string().min(1),
  readRepositories: z.array(z.string()).default([]),
  credentialSet: z.boolean(), // GitHub token set? never the token itself
  config: ProjectConfigSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Name of the Kubernetes Secret holding this project's GitHub token (never
  // the token itself) -- populated by FileManagedProjectStore (parsed from
  // <slug>__project.yaml's `tokenSecret` field, per the per-project-token
  // design). Optional in the schema for backward compatibility with older
  // fixtures/tests that predate this field -- see resolveManagedProjectEntry,
  // the only consumer that reads it.
  tokenSecret: z.string().optional(),
};

// A discriminated union so consumers (CLI/UI) get real narrowing on
// trackerType -- a stored/read project is always exactly one shape, never a
// partial patch.
export const ManagedProjectSchema = z.discriminatedUnion('trackerType', [
  z.object({ ...BaseManagedProjectFields, trackerType: z.literal('github') }),
  z.object({
    ...BaseManagedProjectFields,
    trackerType: z.literal('linear'),
    linearTeamKey: z.string().min(1),
    linearTriggerLabelId: z.string().min(1).optional(),
    linearCredentialSet: z.boolean(), // Linear token set? never the token itself
    linearTokenSecret: z.string().optional(), // Name of the Kubernetes Secret holding this project's Linear token
  }),
]);
export type ManagedProject = z.infer<typeof ManagedProjectSchema>;
