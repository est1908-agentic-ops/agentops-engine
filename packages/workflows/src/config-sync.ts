import { proxyActivities } from '@temporalio/workflow';
import {
  reconcileAgents,
  reconcileContinuous,
  workerWarnings,
  type ReconcilePlan,
  type ContinuousPlan,
} from '@agentops/policies';
import type { ConfigSyncActivities } from './activities-api';

const acts = proxyActivities<ConfigSyncActivities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 5 },
});

export async function configSync(input: {
  project: string;
  repo: string;
}): Promise<ReconcilePlan & { continuous?: ContinuousPlan; warnings?: string[] }> {
  const manifest = await acts.loadAgentsManifest(input.project, input.repo);
  const declared = manifest.agents;
  // No-silent-misconfig surface (spec §7): a custom workflow scheduled without a
  // `worker` block would run on a queue nothing polls. Warnings ride the result.
  const warnings = workerWarnings(manifest, input.project);
  const existing = await acts.listAgentSchedules(input.project);
  const plan = reconcileAgents(declared, existing, input.project);
  await acts.applyScheduleChanges(input.project, input.repo, plan);

  const runningContinuous = await acts.listContinuousAgents(input.project);
  const contPlan = reconcileContinuous(declared, runningContinuous, input.project);
  for (const spec of contPlan.toStart)
    await acts.startContinuousAgent(input.project, input.repo, spec);
  for (const id of contPlan.toTerminate) await acts.terminateContinuousAgent(id);
  return { ...plan, continuous: contPlan, warnings };
}
