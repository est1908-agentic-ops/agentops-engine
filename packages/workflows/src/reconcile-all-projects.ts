import { proxyActivities, executeChild } from '@temporalio/workflow';
import { ENGINE_QUEUE } from '@agentops/contracts';
import type { ConfigSyncActivities } from './activities-api';

const acts = proxyActivities<Pick<ConfigSyncActivities, 'listManagedProjects'>>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3 },
});

// Periodic safety reconcile (SP3 §3.2): reconcile every managed project's
// agents.json into Temporal Schedules. Fired by the worker-ensured
// `reconcile:all` Schedule (~15 min); complements the push fast path.
export async function reconcileAllProjects(): Promise<{ reconciled: number }> {
  const projects = await acts.listManagedProjects();
  for (const p of projects) {
    await executeChild('configSync', {
      taskQueue: ENGINE_QUEUE,
      workflowId: `configsync:${p.project}`,
      args: [{ project: p.project, repo: p.repo }],
    });
  }
  return { reconciled: projects.length };
}