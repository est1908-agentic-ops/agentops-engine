import { z, ZodError } from 'zod';

export const ProjectRegistryEntrySchema = z.object({
  product: z.string().min(1),
  repo: z.string().min(1),
  trackerType: z.literal('github'),
  tokenEnvVar: z.string().min(1),
});
export type ProjectRegistryEntry = z.infer<typeof ProjectRegistryEntrySchema>;

export const ProjectRegistrySchema = z.array(ProjectRegistryEntrySchema);
export type ProjectRegistry = z.infer<typeof ProjectRegistrySchema>;

// Not zod-validated (constructed programmatically, never parsed from raw input) — lives
// here, not in packages/activities, so both loadProjectRegistry (activities) and the
// worker/cli wiring layer can share one type without packages/ports depending on
// packages/activities.
export interface ResolvedProjectEntry extends ProjectRegistryEntry {
  token: string;
}

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

  const duplicateProduct = findDuplicate(registry.map((entry) => entry.product));
  if (duplicateProduct) {
    throw new InvalidProjectRegistryError(`duplicate product "${duplicateProduct}" in project registry`);
  }
  const duplicateRepo = findDuplicate(registry.map((entry) => entry.repo));
  if (duplicateRepo) {
    throw new InvalidProjectRegistryError(`duplicate repo "${duplicateRepo}" in project registry`);
  }
  const duplicateTokenEnvVar = findDuplicate(registry.map((entry) => entry.tokenEnvVar));
  if (duplicateTokenEnvVar) {
    throw new InvalidProjectRegistryError(`duplicate tokenEnvVar "${duplicateTokenEnvVar}" in project registry`);
  }

  return registry;
}
