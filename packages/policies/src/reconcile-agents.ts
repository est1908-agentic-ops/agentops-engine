import type { AgentSpec } from '@agentops/contracts';
import { ENGINE_QUEUE } from '@agentops/contracts';

export interface ExistingSchedule { id: string; scheduleSpec: string; workflow: string; paused: boolean; taskQueue?: string }
export interface ReconcilePlan { toCreate: AgentSpec[]; toUpdate: AgentSpec[]; toDelete: string[]; toPause: string[]; toResume: string[] }

export function scheduleId(project: string, name: string): string {
  return `agent:${project}:${name}`;
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
    const desiredQueue = spec.taskQueue ?? ENGINE_QUEUE;
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
