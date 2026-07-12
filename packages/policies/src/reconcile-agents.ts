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
    const desiredQueue = ENGINE_QUEUE; // built-in scheduled workflows always run on the engine queue
    if (cur.scheduleSpec !== spec.schedule || cur.workflow !== spec.workflow || (cur.taskQueue !== undefined && cur.taskQueue !== desiredQueue)) {
      plan.toUpdate.push(spec);
    }
    if (spec.enabled && cur.paused) plan.toResume.push(id);
    if (!spec.enabled && !cur.paused) plan.toPause.push(id);
  }
  for (const e of existing) if (!declaredIds.has(e.id)) plan.toDelete.push(e.id);
  return plan;
}
