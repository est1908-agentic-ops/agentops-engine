import { z, ZodError } from 'zod';

// A 5-field cron, loosely validated (field count + allowed chars). The
// reconciler hands the exact string to Temporal, which does the strict parse;
// this catches obvious typos at PR time.
const CRON_FIELD = String.raw`[\d*/,\-A-Za-z?]+`;
const CRON_RE = new RegExp(`^${CRON_FIELD}(\\s+${CRON_FIELD}){4}$`);
const scheduleSchema = z.union([z.literal('continuous'), z.string().regex(CRON_RE, 'must be a 5-field cron or "continuous"')]);

export const AgentSpecSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'name must be kebab-case DNS-safe'),
    workflow: z.string().min(1),
    schedule: scheduleSchema,
    input: z.record(z.string(), z.unknown()).default({}),
    enabled: z.boolean().default(true),
    timezone: z.string().default('UTC'),
    overlap: z.enum(['skip', 'bufferOne', 'allow']).default('skip'),
    // Task queue the reconciler starts this agent on. Built-in workflows omit
    // it (they run on ENGINE_QUEUE); a continuous Tier-2 agent sets it to its
    // project worker's queue so the reconciler can start it by name there.
    taskQueue: z.string().min(1).optional(),
  })
  .strict();
export type AgentSpec = z.infer<typeof AgentSpecSchema>;

export const AgentsManifestSchema = z.object({ agents: z.array(AgentSpecSchema) }).strict();
export type AgentsManifest = z.infer<typeof AgentsManifestSchema>;

// Manifest-facing input schemas for built-ins (the reconciler injects `repo`).
export const WhiteboxBugHuntManifestInputSchema = z.object({ focus: z.string().optional() }).strict();
export const BUILTIN_WORKFLOW_INPUTS: Record<string, z.ZodTypeAny> = {
  whiteboxBugHunt: WhiteboxBugHuntManifestInputSchema,
};

export class InvalidAgentsManifestError extends Error {
  constructor(message: string, public readonly issues?: unknown) {
    super(message);
  }
}

function fmt(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

export function parseAgentsManifest(
  raw: unknown,
  opts: { workflowInputs: Record<string, z.ZodTypeAny> },
): AgentsManifest {
  let manifest: AgentsManifest;
  try {
    manifest = AgentsManifestSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) throw new InvalidAgentsManifestError(fmt(err), err.issues);
    throw err;
  }
  const seen = new Set<string>();
  for (const agent of manifest.agents) {
    if (seen.has(agent.name)) throw new InvalidAgentsManifestError(`duplicate agent name "${agent.name}"`);
    seen.add(agent.name);
    const inputSchema = opts.workflowInputs[agent.workflow];
    if (inputSchema) {
      const res = inputSchema.safeParse(agent.input);
      if (!res.success) throw new InvalidAgentsManifestError(`agent "${agent.name}" input: ${fmt(res.error)}`);
    }
  }
  return manifest;
}
