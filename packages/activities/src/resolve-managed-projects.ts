import type { ManagedProjectStore, ResolvedProjectEntry } from '@agentops/contracts';
import { normalizeRepo } from '@agentops/ports';

export interface ManagedProjectRegistryDeps {
  store: ManagedProjectStore;
  /**
   * Resolves a project's `tokenSecret` (a Kubernetes Secret NAME) to the
   * actual token value -- per-project, not a single shared `GITHUB_TOKEN`
   * (that design was superseded). The real implementation is
   * `KubeTokenResolver.get`, bound to a namespace; the cli's local-dev path
   * (no in-cluster API available) reads the same requested key from the
   * environment instead (see packages/cli/src/main.ts).
   */
  resolveToken: (
    tokenSecret: string,
    key: 'GITHUB_TOKEN' | 'LINEAR_API_TOKEN',
  ) => Promise<string>;
}

async function buildResolvedEntry(
  deps: ManagedProjectRegistryDeps,
  managedProject: Awaited<ReturnType<ManagedProjectStore['get']>>,
): Promise<ResolvedProjectEntry | null> {
  if (!managedProject) {
    return null;
  }

  const normalizedRepo = normalizeRepo(managedProject.repo);

  if (managedProject.trackerType === 'linear') {
    if (!managedProject.linearTokenSecret) {
      throw new Error(
        `resolveManagedProjectEntry: managed project "${managedProject.project}" (Linear team "${managedProject.linearTeamKey}") has no linearTokenSecret configured`,
      );
    }
    if (!managedProject.tokenSecret) {
      throw new Error(
        `resolveManagedProjectEntry: managed project "${managedProject.project}" (Linear team "${managedProject.linearTeamKey}") has no tokenSecret configured`,
      );
    }

    const token = await deps.resolveToken(managedProject.tokenSecret, 'GITHUB_TOKEN');
    const linearToken = await deps.resolveToken(managedProject.linearTokenSecret, 'LINEAR_API_TOKEN');

    return {
      trackerType: 'linear',
      project: managedProject.project,
      repo: normalizedRepo,
      readRepositories: managedProject.readRepositories ?? [],
      token,
      linearTeamKey: managedProject.linearTeamKey,
      ...(managedProject.linearTriggerLabelId
        ? { linearTriggerLabelId: managedProject.linearTriggerLabelId }
        : {}),
      linearToken,
    };
  } else {
    // GitHub tracker
    if (!managedProject.tokenSecret) {
      throw new Error(
        `resolveManagedProjectEntry: managed project "${managedProject.project}" (repo "${normalizedRepo}") has no tokenSecret configured`,
      );
    }

    const token = await deps.resolveToken(managedProject.tokenSecret, 'GITHUB_TOKEN');

    return {
      trackerType: 'github',
      project: managedProject.project,
      repo: normalizedRepo,
      readRepositories: managedProject.readRepositories ?? [],
      token,
    };
  }
}

async function resolveOne(
  deps: ManagedProjectRegistryDeps,
  repo: string,
): Promise<ResolvedProjectEntry | null> {
  const managedProject = await deps.store.get(repo);
  return buildResolvedEntry(deps, managedProject);
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
 * Linear-tracked project lookup by team key. `deps` is undefined when no
 * store is configured at all.
 */
export async function resolveManagedProjectEntryByLinearTeamKey(
  deps: ManagedProjectRegistryDeps | undefined,
  teamKey: string,
): Promise<ResolvedProjectEntry | null> {
  if (!deps) {
    return null;
  }
  const managedProject = await deps.store.getByLinearTeamKey(teamKey);
  return buildResolvedEntry(deps, managedProject);
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
    try {
      const resolved = await buildResolvedEntry(deps, project);
      if (resolved) {
        entries.push(resolved);
      } else {
        console.warn(
          `loadManagedProjectRegistry: skipping "${project.project}" (${project.repo}): resolved entry is null`,
        );
      }
    } catch (err) {
      console.warn(
        `loadManagedProjectRegistry: skipping "${project.project}" (${project.repo}): ${(err as Error).message}`,
      );
    }
  }
  return entries;
}
