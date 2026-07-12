import type { AgentSpec } from '@agentops/contracts';
import type { ExistingSchedule, ReconcilePlan } from '@agentops/policies';
import { scheduleId } from '@agentops/policies';
import { ENGINE_QUEUE } from '@agentops/contracts';

/* eslint-disable @typescript-eslint/no-explicit-any */
// Minimal surface we use from Temporal's ScheduleClient / ScheduleHandle.
// This lets tests inject a vi.fn() mock without depending on the full SDK shape.
export interface ScheduleHandleLike {
  update?: (opts: any) => Promise<void>;
  pause?: () => Promise<void>;
  unpause?: () => Promise<void>;
  delete?: () => Promise<void>;
}

export interface ScheduleClientLike {
  create?: (opts: any) => Promise<ScheduleHandleLike>;
  getHandle: (id: string) => ScheduleHandleLike;
  list?: () => AsyncIterable<any>;
}

export interface ScheduleOpsDeps {
  scheduleClient?: ScheduleClientLike;
  // The queue the Schedules should target for the built-in workflows
  taskQueue?: string;
}

export async function loadAgentsManifest(
  scm: { readFile: (repo: string, path: string) => Promise<string | null> },
  project: string,
  repo: string,
  parse: (raw: unknown, opts: { workflowInputs: Record<string, unknown> }) => { agents: AgentSpec[] },
  workflowInputs: Record<string, unknown>,
): Promise<AgentSpec[]> {
  const raw = await scm.readFile(repo, 'agents.json');
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Let the manifest parser surface a nice error
    parsed = raw;
  }
  const manifest = parse(parsed, { workflowInputs });
  return manifest.agents;
}

export async function listAgentSchedules(project: string, client?: ScheduleClientLike): Promise<ExistingSchedule[]> {
  if (!client) return [];
  const out: ExistingSchedule[] = [];
  // list() yields schedule summaries
  const lister = client.list;
  if (lister) {
    for await (const s of lister()) {
      const id = (s as any).scheduleId;
      if (!id || !id.startsWith(`agent:${project}:`)) continue;
      // Best-effort extraction; real objects have more structure.
      const spec = (s as any)?.schedule?.spec;
      const scheduleSpec = typeof spec === 'string' ? spec : (spec?.cron?.cronString ?? 'continuous');
      const workflow = (s as any)?.action?.type ?? 'whiteboxBugHunt';
      // paused not directly on list item in all SDK versions; default false and rely on apply
      out.push({ id, scheduleSpec, workflow, paused: false });
    }
  }
  return out;
}

export async function applyScheduleChanges(
  project: string,
  plan: ReconcilePlan,
  deps: ScheduleOpsDeps & { startWorkflow?: (workflowType: string, args: unknown[]) => unknown },
): Promise<void> {
  const client = deps.scheduleClient;
  if (!client) return; // no-op in environments without schedule client (tests often mock at higher level)
  const taskQueue = deps.taskQueue ?? ENGINE_QUEUE;

  for (const spec of plan.toCreate) {
    if (spec.schedule === 'continuous') continue; // SP1: Schedules only
    const id = scheduleId(project, spec.name);
    if (client.create) {
      await client.create({
        scheduleId: id,
        spec: { cron: { cronString: spec.schedule, timezone: spec.timezone } },
        action: {
          type: 'startWorkflow',
          workflowType: spec.workflow,
          args: [{ repo: /* provided by caller context */ '', ...spec.input }],
          taskQueue,
        },
        memo: { project, agentName: spec.name },
      } as any);
    }
  }

  for (const spec of plan.toUpdate) {
    if (spec.schedule === 'continuous') continue;
    const id = scheduleId(project, spec.name);
    const h = client.getHandle(id);
    await h.update?.({
      schedule: {
        spec: { cron: { cronString: spec.schedule, timezone: spec.timezone } },
        action: {
          type: 'startWorkflow',
          workflowType: spec.workflow,
          args: [{ repo: '', ...spec.input }],
          taskQueue,
        },
      },
    } as any);
  }

  for (const id of plan.toPause) {
    const h = client.getHandle(id);
    await h.pause?.();
  }
  for (const id of plan.toResume) {
    const h = client.getHandle(id);
    await h.unpause?.();
  }
  for (const id of plan.toDelete) {
    const h = client.getHandle(id);
    await h.delete?.();
  }
}
