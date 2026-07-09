import type { ResolvedProjectEntry } from '@agentops/contracts';
import { decryptForManagedProject } from './credential-crypto';
import type { PostgresManagedProjectStore } from './postgres-managed-project-store';

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
    return null; // shouldn't happen (get() and getEncryptedToken() query the same row) -- treat as unregistered rather than throw
  }
  let token: string;
  try {
    token = decryptForManagedProject(deps.privateKey, encryptedToken);
  } catch (err) {
    console.warn(`resolveManagedProjects: failed to decrypt credential for repo "${repo}" — skipping`, err);
    return null;
  }

  if (managedProject.trackerType !== 'linear') {
    return { trackerType: 'github', project: managedProject.project, repo: managedProject.repo, token };
  }

  const encryptedLinearToken = await deps.store.getEncryptedLinearToken(repo);
  if (!encryptedLinearToken) {
    console.warn(`resolveManagedProjects: linear-tracked repo "${repo}" has no Linear credential set — skipping`);
    return null;
  }
  let linearToken: string;
  try {
    linearToken = decryptForManagedProject(deps.privateKey, encryptedLinearToken);
  } catch (err) {
    console.warn(`resolveManagedProjects: failed to decrypt Linear credential for repo "${repo}" — skipping`, err);
    return null;
  }
  return {
    trackerType: 'linear',
    project: managedProject.project,
    repo: managedProject.repo,
    token,
    linearTeamKey: managedProject.linearTeamKey,
    linearTriggerLabelId: managedProject.linearTriggerLabelId,
    linearToken,
  };
}

/**
 * DB-only lookup for one repo. `deps` is undefined when no DB is configured
 * at all (ENGINE_DB_HOST/private key unset), in which case nothing is
 * registered anywhere -- there is no other registry to fall back to (the
 * static PROJECT_REGISTRY_JSON mechanism was removed; see
 * docs/superpowers/specs/2026-07-09-linear-trigger-design.md's DB-only addendum).
 */
export async function resolveManagedProjectEntry(deps: ManagedProjectRegistryDeps | undefined, repo: string): Promise<ResolvedProjectEntry | null> {
  if (!deps) {
    return null;
  }
  return resolveOne(deps, repo);
}

export type ResolvedLinearProjectEntry = ResolvedProjectEntry & { trackerType: 'linear' };

function isLinearEntry(entry: ResolvedProjectEntry | null): entry is ResolvedLinearProjectEntry {
  return entry !== null && entry.trackerType === 'linear';
}

async function resolveOneByLinearTeamKey(deps: ManagedProjectRegistryDeps, teamKey: string): Promise<ResolvedLinearProjectEntry | null> {
  const managedProject = await deps.store.getByLinearTeamKey(teamKey);
  if (!managedProject || managedProject.trackerType !== 'linear') {
    return null;
  }
  const resolved = await resolveOne(deps, managedProject.repo);
  return isLinearEntry(resolved) ? resolved : null;
}

/**
 * Same DB-only shape as resolveManagedProjectEntry, but keyed by a Linear
 * team key instead of a repo -- how the gateway routes a Linear webhook
 * (which only carries an issue identifier like "ENG-123", not a GitHub repo)
 * to the project it belongs to.
 */
export async function resolveManagedProjectEntryByLinearTeamKey(
  deps: ManagedProjectRegistryDeps | undefined,
  teamKey: string,
): Promise<ResolvedLinearProjectEntry | null> {
  if (!deps) {
    return null;
  }
  return resolveOneByLinearTeamKey(deps, teamKey);
}

/**
 * All DB-managed projects, decrypted -- used once at worker boot to build
 * ports for every registered repo (worker pre-builds ports for every
 * registered repo at startup rather than per request; see the data-layer
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
