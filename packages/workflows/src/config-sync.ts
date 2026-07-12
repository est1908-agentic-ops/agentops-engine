import { proxyActivities } from '@temporalio/workflow';
import { reconcileAgents, reconcileContinuous, type ReconcilePlan, type ContinuousPlan } from '@agentops/policies';
import type { ConfigSyncActivities } from './activities-api';
import type { AgentSpec } from '@agentops/contracts';

const acts = proxyActivities<ConfigSyncActivities>({ startToCloseTimeout: '2 minutes', retry: { maximumAttempts: 5 } });

export async function configSync(input: { project: string; repo: string }): Promise<ReconcilePlan & { continuous?: ContinuousPlan }> {
  const declared = await acts.loadAgentsManifest(input.project, input.repo);
  const existing = await acts.listAgentSchedules(input.project);
  const plan = reconcileAgents(declared, existing, input.project);
  await acts.applyScheduleChanges(input.project, input.repo, plan);

  const runningContinuous = await acts.listContinuousAgents(input.project);
  const contPlan = reconcileContinuous(declared, runningContinuous, input.project);
  for (const spec of contPlan.toStart) await acts.startContinuousAgent(input.project, input.repo, spec);
  for (const id of contPlan.toTerminate) await acts.terminateContinuousAgent(id);
  return { ...plan, continuous: contPlan };
}
