import { z, ZodError } from 'zod';

// A 5-field cron, loosely validated (field count + allowed chars). The
// reconciler hands the exact string to Temporal, which does the strict parse;
// this catches obvious typos at PR time.
const CRON_FIELD = String.raw`[\d*/,\-A-Za-z?]+`;
const CRON_RE = new RegExp(`^${CRON_FIELD}(\\s+${CRON_FIELD}){4}$`);
const scheduleSchema = z.union([
  z.literal('continuous'),
  z.string().regex(CRON_RE, 'must be a 5-field cron or "continuous"'),
]);

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

// The project's Tier-2 worker (spec 2026-07-12-project-worker-onboarding §6.1).
// Its presence marks the project Tier-2: a config-only Tier-1 project has
// `agents` but no `worker` (its agents run on ENGINE_QUEUE). Never carries a
// secret — `externalSecrets` are K8s Secret *names*, not values.
export const ProjectWorkerSchema = z
  .object({
    image: z.string().min(1), // project-built worker image ref (repo:tag or repo@digest)
    taskQueue: z.string().min(1).optional(), // default proj-<project> at resolution time
    replicas: z.number().int().positive().default(1),
    externalSecrets: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type ProjectWorker = z.infer<typeof ProjectWorkerSchema>;

// The reconciler's view of a project's agents: the `agents` and `worker` blocks
// of its `agentops.json`. These fields live on `ProjectConfig` (see
// ./project-config) — there is no separate manifest file anymore.
export type AgentsManifest = { agents: AgentSpec[]; worker?: ProjectWorker };

// The built-in workflows the engine's shared fleet runs (they poll ENGINE_QUEUE).
// Any other `workflow` name in a manifest is a project (Tier-2) workflow, which
// runs on the project's own queue (proj-<project>) — see resolveAgentQueue in
// @agentops/policies. Keep in sync with the workflows registered by the worker
// (packages/workflows). Adding a built-in is a deliberate change here.
export const BUILTIN_WORKFLOWS: ReadonlySet<string> = new Set([
  'devCycle',
  'whiteboxBugHunt',
  'platform',
]);
export function isBuiltinWorkflow(name: string): boolean {
  return BUILTIN_WORKFLOWS.has(name);
}

// Manifest-facing input schemas for built-ins (the reconciler injects `repo`).
export const WhiteboxBugHuntManifestInputSchema = z
  .object({ focus: z.string().optional() })
  .strict();
export const BUILTIN_WORKFLOW_INPUTS: Record<string, z.ZodTypeAny> = {
  whiteboxBugHunt: WhiteboxBugHuntManifestInputSchema,
};

function fmt(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

// Manifest-level validation the per-entry zod schema can't express: unique
// agent names, and per-workflow input validation for known built-ins. Returns
// an error message, or null when the agents are valid. Callers wrap the message
// in their own error type — `parseProjectConfig` throws InvalidProjectConfigError.
export function validateAgentSpecs(
  agents: readonly AgentSpec[],
  workflowInputs: Record<string, z.ZodTypeAny> = BUILTIN_WORKFLOW_INPUTS,
): string | null {
  const seen = new Set<string>();
  for (const agent of agents) {
    if (seen.has(agent.name)) return `duplicate agent name "${agent.name}"`;
    seen.add(agent.name);
    const inputSchema = workflowInputs[agent.workflow];
    if (inputSchema) {
      const res = inputSchema.safeParse(agent.input);
      if (!res.success) return `agent "${agent.name}" input: ${fmt(res.error)}`;
    }
  }
  return null;
}
