import { proxyActivities, executeChild } from '@temporalio/workflow';
import { ENGINE_QUEUE } from '@agentops/contracts';
import type { ConfigSyncActivities } from './activities-api';

const acts = proxyActivities<
  Pick<ConfigSyncActivities, 'listManagedProjects' | 'pruneOrphanAgentSchedules' | 'pruneOrphanWorkspaces'>
>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3 },
});

// Periodic safety reconcile (SP3 §3.2): reconcile every managed project's
// agents.json into Temporal Schedules. Fired by the worker-ensured
// `reconcile:all` Schedule (~15 min); complements the push fast path.
export async function reconcileAllProjects(): Promise<{
  reconciled: number;
  orphansDeleted: number;
  orphanWorkspacesRemoved: number;
}> {
  const projects = await acts.listManagedProjects();
  for (const p of projects) {
    await executeChild('configSync', {
      taskQueue: ENGINE_QUEUE,
      workflowId: `configsync:${p.project}`,
      args: [{ project: p.project, repo: p.repo }],
    });
  }
  // Sweep away leftovers of projects that are no longer managed. Per-project
  // configSync only reconciles projects that still exist, so a removed project's
  // artifacts would otherwise linger: its `agent:<project>:*` schedules keep
  // firing onto a queue nothing serves, and its base clone + worktrees leave
  // full source readable on the shared PVCs. Runs after the per-project pass so a
  // still-live project has its schedules/clones (re)created before the sweep
  // considers orphans. Keyed by project name for schedules, by repo for clones.
  const { deleted } = await acts.pruneOrphanAgentSchedules(projects.map((p) => p.project));
  const { removed } = await acts.pruneOrphanWorkspaces(projects.map((p) => p.repo));
  return {
    reconciled: projects.length,
    orphansDeleted: deleted.length,
    orphanWorkspacesRemoved: removed.length,
  };
}