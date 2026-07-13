import type { AgentSpec, AgentsManifest } from '@agentops/contracts';
import { ENGINE_QUEUE, isBuiltinWorkflow } from '@agentops/contracts';

export interface ExistingSchedule { id: string; scheduleSpec: string; workflow: string; paused: boolean; taskQueue?: string }
export interface ReconcilePlan { toCreate: AgentSpec[]; toUpdate: AgentSpec[]; toDelete: string[]; toPause: string[]; toResume: string[] }

export function scheduleId(project: string, name: string): string {
  return `agent:${project}:${name}`;
}

// Agent schedules are keyed `agent:<project>:<name>`. When a project is removed
// from the managed registry, reconcileAllProjects stops iterating it, so
// reconcileAgents never runs for it and its schedules are never deleted -- they
// linger and keep firing onto a queue nothing serves (proj-<project>) or run a
// removed project's workflow. Given every `agent:*` schedule id and the set of
// still-managed projects, return the orphans to delete: any `agent:` schedule
// not owned by a live project. Matches by `agent:<project>:` PREFIX rather than
// splitting on ':' so project or agent names containing ':' (or spaces) are safe,
// and only ever targets `agent:` ids -- platform schedules (reconcile:all,
// self-heal) can never match.
export function orphanScheduleIds(agentScheduleIds: string[], liveProjects: string[]): string[] {
  const livePrefixes = liveProjects.map((p) => `agent:${p}:`);
  return agentScheduleIds.filter(
    (id) => id.startsWith('agent:') && !livePrefixes.some((prefix) => id.startsWith(prefix)),
  );
}

// A Tier-2 project worker polls this queue (proj-worker chart default). Both the
// worker Deployment and the agent's schedule derive their queue from the project
// slug so they can't drift (spec 2026-07-12-project-worker-onboarding §7).
export function projectQueue(project: string): string {
  return `proj-${project}`;
}

// The task queue the reconciler starts an agent on:
//   explicit `taskQueue` wins; otherwise a built-in workflow runs on the engine
//   fleet (`engineQueue`, default ENGINE_QUEUE) and a project (Tier-2) workflow
//   on proj-<project> (where the project's own worker polls). Before SP-b a
//   project workflow with no taskQueue fell through to ENGINE_QUEUE, where no
//   engine worker has its code — i.e. it never ran; this resolves it correctly.
export function resolveAgentQueue(
  spec: Pick<AgentSpec, 'workflow' | 'taskQueue'>,
  project: string,
  engineQueue: string = ENGINE_QUEUE,
): string {
  if (spec.taskQueue) return spec.taskQueue;
  return isBuiltinWorkflow(spec.workflow) ? engineQueue : projectQueue(project);
}

// No-silent-misconfig check (spec §7): a custom (project) workflow scheduled with
// no `worker` block in the manifest would be started on proj-<project>, a queue
// nothing polls. Returns human-readable warnings the reconcile surfaces.
export function workerWarnings(manifest: AgentsManifest, project: string): string[] {
  if (manifest.worker) return [];
  return manifest.agents
    .filter((a) => !isBuiltinWorkflow(a.workflow))
    .map(
      (a) =>
        `agent "${a.name}" schedules custom workflow "${a.workflow}" on ${projectQueue(project)} but the manifest declares no "worker" to run it`,
    );
}

// `continuous` agents are singleton workflows, not Schedules — the reconciler
// handles them separately, so they are excluded here.
export function reconcileAgents(declared: AgentSpec[], existing: ExistingSchedule[], project = 'p'): ReconcilePlan {
  const scheduled = declared.filter((a) => a.schedule !== 'continuous');
  const byId = new Map(existing.map((e) => [e.id, e]));
  const plan: ReconcilePlan = { toCreate: [], toUpdate: [], toDelete: [], toPause: [], toResume: [] };
  const declaredIds = new Set<string>();

  for (const spec of scheduled) {
    const id = scheduleId(project, spec.name);
    declaredIds.add(id);
    const cur = byId.get(id);
    if (!cur) { plan.toCreate.push(spec); continue; }
    const desiredQueue = resolveAgentQueue(spec, project);
    if (cur.scheduleSpec !== spec.schedule || cur.workflow !== spec.workflow || (cur.taskQueue !== undefined && cur.taskQueue !== desiredQueue)) {
      plan.toUpdate.push(spec);
    }
    if (spec.enabled && cur.paused) plan.toResume.push(id);
    if (!spec.enabled && !cur.paused) plan.toPause.push(id);
  }
  for (const e of existing) if (!declaredIds.has(e.id)) plan.toDelete.push(e.id);
  return plan;
}

export interface ContinuousPlan { toStart: AgentSpec[]; toTerminate: string[] }

// Continuous agents are singleton long-lived workflows keyed by the same
// deterministic id as schedules (agent:<project>:<name>). Enabled + declared
// but not running => start; running but not declared (or disabled) =>
// terminate. SP2 design §8.
export function reconcileContinuous(declared: AgentSpec[], running: string[], project: string): ContinuousPlan {
  const wanted = declared.filter((a) => a.schedule === 'continuous' && a.enabled);
  const runningSet = new Set(running);
  const wantedIds = new Set(wanted.map((a) => scheduleId(project, a.name)));
  return {
    toStart: wanted.filter((a) => !runningSet.has(scheduleId(project, a.name))),
    toTerminate: running.filter((id) => !wantedIds.has(id)),
  };
}
