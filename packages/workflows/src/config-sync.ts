import { proxyActivities } from '@temporalio/workflow';
import { reconcileAgents, type ReconcilePlan } from '@agentops/policies';
import type { ConfigSyncActivities } from './activities-api';

const acts = proxyActivities<ConfigSyncActivities>({ startToCloseTimeout: '2 minutes', retry: { maximumAttempts: 5 } });

export async function configSync(input: { project: string; repo: string }): Promise<ReconcilePlan> {
  const declared = await acts.loadAgentsManifest(input.project, input.repo);
  const existing = await acts.listAgentSchedules(input.project);
  const plan = reconcileAgents(declared, existing, input.project);
  await acts.applyScheduleChanges(input.project, input.repo, plan);
  return plan;
}
