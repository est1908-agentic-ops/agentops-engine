import type { ResolvedProjectEntry } from '@agentops/contracts';
import { decryptForManagedProject } from './credential-crypto';
import type { PostgresManagedProjectStore } from './postgres-managed-project-store';

// ResolvedProjectEntry.tokenEnvVar only ever mattered during the static
// PROJECT_REGISTRY_JSON load (to look up the real env var name) -- nothing
// downstream reads it after resolution. This sentinel makes a DB-sourced
// entry visually distinct in logs/debugging without adding an optional
// field that would need updating at every existing call site.
const MANAGED_PROJECT_TOKEN_ENV_VAR_SENTINEL = '(managed-project, not env-backed)';

export interface ManagedProjectRegistryDeps {
  store: PostgresManagedProjectStore;
  /** Base64 PKCS8 DER private key -- decrypts credentials this process is allowed to use. */
  privateKey: string;
}

async function resolveOne(deps: ManagedProjectRegistryDeps, repo: string): Promise<ResolvedProjectEntry | null> {
  const managedProject = await deps.store.get(repo);
  if (!managedProject) {
    return null;
  }
  const encryptedToken = await deps.store.getEncryptedToken(repo);
  if (!encryptedToken) {
    return null; // shouldn't happen (get() and getEncryptedToken() query the same row) -- fall through to the static registry rather than throw
  }
  return {
    project: managedProject.project,
    repo: managedProject.repo,
    trackerType: 'github',
    tokenEnvVar: MANAGED_PROJECT_TOKEN_ENV_VAR_SENTINEL,
    token: decryptForManagedProject(deps.privateKey, encryptedToken),
  };
}

/**
 * DB-first lookup for one repo, falling back to `staticRegistry`. `deps`
 * is undefined when no DB is configured at all (ENGINE_DB_HOST/private key
 * unset) -- falls straight through to the static registry, same as today.
 */
export async function resolveManagedProjectEntry(
  deps: ManagedProjectRegistryDeps | undefined,
  staticRegistry: ResolvedProjectEntry[],
  repo: string,
): Promise<ResolvedProjectEntry | null> {
  if (deps) {
    const resolved = await resolveOne(deps, repo);
    if (resolved) {
      return resolved;
    }
  }
  return staticRegistry.find((entry) => entry.repo === repo) ?? null;
}

/**
 * All DB-managed projects, decrypted -- used once at worker boot to merge
 * into the same registry array it builds ports from (worker pre-builds
 * ports for every registered repo at startup rather than per request, so
 * DB entries need to be present in that same list; see the data-layer
 * plan's Task 6 for why this is boot-time rather than fully dynamic).
 */
export async function loadManagedProjectRegistry(deps: ManagedProjectRegistryDeps): Promise<ResolvedProjectEntry[]> {
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
