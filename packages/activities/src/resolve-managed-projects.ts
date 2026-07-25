import type { ManagedProjectStore, ResolvedProjectEntry } from '@agentops/contracts';
import { normalizeRepo } from '@agentops/ports';

export interface ManagedProjectRegistryDeps {
  store: ManagedProjectStore;
  /**
   * Resolves a project's `tokenSecret` (a Kubernetes Secret NAME) to the
   * actual token value -- per-project, not a single shared `GITHUB_TOKEN`
   * (that design was superseded). The real implementation is
   * `KubeTokenResolver.get`, bound to a namespace; the cli's local-dev path
   * (no in-cluster API available) falls back to reading `GITHUB_TOKEN` from
   * the environment instead (see packages/cli/src/main.ts).
   */
  resolveToken: (tokenSecret: string) => Promise<string>;
}

async function resolveOne(
  deps: ManagedProjectRegistryDeps,
  repo: string,
): Promise<ResolvedProjectEntry | null> {
  const managedProject = await deps.store.get(repo);
  if (!managedProject) {
    return null;
  }
  if (!managedProject.tokenSecret) {
    throw new Error(
      `resolveManagedProjectEntry: managed project "${managedProject.project}" (repo "${repo}") has no tokenSecret configured`,
    );
  }

  // Canonicalize to short `owner/repo`: a project registered through the
  // ConfigMap with a full GitHub URL is stored verbatim, but every downstream
  // consumer (createProjectScopedPorts keys, githubCloneUrl, resolveRepoConfig)
  // assumes the short form.
  const normalizedRepo = normalizeRepo(managedProject.repo);
  const token = await deps.resolveToken(managedProject.tokenSecret);

  return {
    trackerType: 'github',
    project: managedProject.project,
    repo: normalizedRepo,
    token,
  };
}

/**
 * Store-only lookup for one repo. `deps` is undefined when no store is
 * configured at all (no GITHUB_TOKEN/dir), in which case nothing is
 * registered anywhere -- there is no other registry to fall back to (the
 * static PROJECT_REGISTRY_JSON mechanism was removed; see
 * docs/superpowers/specs/2026-07-09-linear-trigger-design.md's DB-only addendum).
 */
export async function resolveManagedProjectEntry(
  deps: ManagedProjectRegistryDeps | undefined,
  repo: string,
): Promise<ResolvedProjectEntry | null> {
  if (!deps) {
    return null;
  }
  return resolveOne(deps, repo);
}

/**
 * All managed projects -- used once at worker boot to build ports for every
 * registered repo (worker pre-builds ports for every registered repo at
 * startup rather than per request; see the data-layer plan's Task 6 for why
 * this is boot-time rather than fully dynamic).
 */
export async function loadManagedProjectRegistry(
  deps: ManagedProjectRegistryDeps,
): Promise<ResolvedProjectEntry[]> {
  const managedProjects = await deps.store.list();
  const entries: ResolvedProjectEntry[] = [];
  for (const project of managedProjects) {
    const resolved = await resolveOne(deps, project.repo);
    if (resolved) {
      entries.push(resolved);
    }
  }
  return entries;
}
