import { z, ZodError } from 'zod';

const GithubProjectRegistryEntrySchema = z.object({
  project: z.string().min(1),
  repo: z.string().min(1),
  trackerType: z.literal('github'),
  tokenEnvVar: z.string().min(1),
});

// `repo`/`tokenEnvVar` still mean "the GitHub repo the PR lands in" / "the
// GitHub token for it" even here -- SCM stays GitHub-only regardless of
// tracker. `linearTriggerLabelId` is the label's UUID, not its name: Linear's
// issue webhook payload never carries a label name (only `labelIds`), and
// labels can be team- or workspace-scoped, so there's no safe way to resolve
// a configured name to an ID without a runtime API dependency this gateway
// otherwise doesn't have. See docs/superpowers/specs/2026-07-09-linear-trigger-design.md.
const LinearProjectRegistryEntrySchema = z.object({
  project: z.string().min(1),
  repo: z.string().min(1),
  trackerType: z.literal('linear'),
  tokenEnvVar: z.string().min(1),
  linearTeamKey: z.string().min(1),
  linearTokenEnvVar: z.string().min(1),
  linearTriggerLabelId: z.string().min(1),
});

export const ProjectRegistryEntrySchema = z.discriminatedUnion('trackerType', [
  GithubProjectRegistryEntrySchema,
  LinearProjectRegistryEntrySchema,
]);
export type ProjectRegistryEntry = z.infer<typeof ProjectRegistryEntrySchema>;

export const ProjectRegistrySchema = z.array(ProjectRegistryEntrySchema);
export type ProjectRegistry = z.infer<typeof ProjectRegistrySchema>;

// Not zod-validated (constructed programmatically, never parsed from raw input) — lives
// here, not in packages/activities, so both loadProjectRegistry (activities) and the
// worker/cli wiring layer can share one type without packages/ports depending on
// packages/activities.
// A plain interface can't `extend` ProjectRegistryEntry now that it's a
// discriminated union (a union isn't a single object type) -- intersect instead.
export type ResolvedProjectEntry = ProjectRegistryEntry & {
  token: string;
  // Only set for `trackerType: 'linear'` entries -- resolved from
  // `linearTokenEnvVar` the same way `token` is resolved from `tokenEnvVar`.
  linearToken?: string;
};

export class InvalidProjectRegistryError extends Error {
  constructor(
    message: string,
    public readonly issues?: unknown,
  ) {
    super(message);
  }
}

function formatZodError(err: ZodError): string {
  return err.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

function findDuplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }
  return undefined;
}

export function parseProjectRegistry(raw: unknown): ProjectRegistry {
  let registry: ProjectRegistry;
  try {
    registry = ProjectRegistrySchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new InvalidProjectRegistryError(formatZodError(err), err.issues);
    }
    throw err;
  }

  const duplicateProject = findDuplicate(registry.map((entry) => entry.project));
  if (duplicateProject) {
    throw new InvalidProjectRegistryError(`duplicate project "${duplicateProject}" in project registry`);
  }
  const duplicateRepo = findDuplicate(registry.map((entry) => entry.repo));
  if (duplicateRepo) {
    throw new InvalidProjectRegistryError(`duplicate repo "${duplicateRepo}" in project registry`);
  }
  const duplicateTokenEnvVar = findDuplicate(registry.map((entry) => entry.tokenEnvVar));
  if (duplicateTokenEnvVar) {
    throw new InvalidProjectRegistryError(`duplicate tokenEnvVar "${duplicateTokenEnvVar}" in project registry`);
  }
  const duplicateLinearTeamKey = findDuplicate(
    registry.filter((entry) => entry.trackerType === 'linear').map((entry) => entry.linearTeamKey),
  );
  if (duplicateLinearTeamKey) {
    throw new InvalidProjectRegistryError(`duplicate linearTeamKey "${duplicateLinearTeamKey}" in project registry`);
  }

  return registry;
}
