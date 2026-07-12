import { loadManagedProjectRegistry, type ManagedProjectRegistryDeps } from '@agentops/activities';
import { parseAgentsManifest, BUILTIN_WORKFLOW_INPUTS, type ResolvedProjectEntry } from '@agentops/contracts';
import type { ScmPort } from '@agentops/ports';

// One ArgoCD ApplicationSet plugin-generator parameter set = one project worker.
// Fields map 1:1 to the project-worker Helm chart values (project-worker-onboarding
// spec §4). All strings — ArgoCD plugin-generator parameters are string-valued.
export interface ProjectWorkerParam {
  project: string;
  image: string;
  taskQueue: string;
  replicas: string;
}

export interface ProjectWorkerParamsDeps {
  // undefined => no managed-project DB configured; getParams() returns [].
  managedProjectDeps?: ManagedProjectRegistryDeps;
  // Builds a read-capable ScmPort from a resolved (decrypted-token) entry —
  // the same factory the webhook handlers use.
  buildScm: (entry: ResolvedProjectEntry) => ScmPort;
}

export interface ProjectWorkerParamsProvider {
  getParams(): Promise<ProjectWorkerParam[]>;
}

// The ArgoCD generator's data source. Source of truth is the `worker` block in
// each managed project's agents.json; this reads it via the per-project token the
// registry already holds. It lives on the gateway (which already decrypts tokens
// and reads repos) so `control` stays encrypt-only (spec §6, Option A).
export function createProjectWorkerParamsProvider(deps: ProjectWorkerParamsDeps): ProjectWorkerParamsProvider {
  // Last-good cache (spec §6.4): a transient repo-read (or registry) failure
  // serves the prior value and never yields an empty/partial list that would make
  // ArgoCD prune a live worker. A *successful* read with no `worker` block is a
  // real removal — drop it so the worker is torn down.
  const lastGood = new Map<string, ProjectWorkerParam>();

  return {
    async getParams(): Promise<ProjectWorkerParam[]> {
      if (!deps.managedProjectDeps) return [];

      let entries: ResolvedProjectEntry[];
      try {
        entries = await loadManagedProjectRegistry(deps.managedProjectDeps);
      } catch (err) {
        console.warn('gateway: failed to list managed projects for ArgoCD params — serving last-good', err);
        return [...lastGood.values()];
      }

      for (const entry of entries) {
        try {
          const scm = deps.buildScm(entry);
          const raw = await scm.readFile(entry.repo, 'agents.json');
          if (raw === null) {
            lastGood.delete(entry.project);
            continue;
          }
          const manifest = parseAgentsManifest(JSON.parse(raw), { workflowInputs: BUILTIN_WORKFLOW_INPUTS });
          if (!manifest.worker) {
            lastGood.delete(entry.project);
            continue;
          }
          lastGood.set(entry.project, {
            project: entry.project,
            image: manifest.worker.image,
            taskQueue: manifest.worker.taskQueue ?? `proj-${entry.project}`,
            replicas: String(manifest.worker.replicas),
          });
        } catch (err) {
          console.warn(`gateway: failed to read worker block for project "${entry.project}" — serving last-good`, err);
        }
      }

      // Drop cache entries for projects no longer in the registry (deregistered),
      // so a stale entry can't linger past a successful registry read.
      const live = new Set(entries.map((e) => e.project));
      for (const key of [...lastGood.keys()]) if (!live.has(key)) lastGood.delete(key);

      return [...lastGood.values()];
    },
  };
}
