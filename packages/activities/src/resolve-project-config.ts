import type { ProjectConfig } from '@agentops/contracts';
import type { ScmPort } from '@agentops/ports';
import { loadProjectConfig } from './load-project-config';
import type { ManagedProjectRegistryDeps } from './resolve-managed-projects';

/**
 * Design §6 config branch: if a managed project exists for `repo` with a
 * non-null `config`, use it directly (no repo file read at all); otherwise
 * fall back to the existing in-repo `loadProjectConfig`. `deps` undefined =>
 * straight to the file-based path, same as before this branch existed.
 *
 * This is a SECOND store.get(repo) on top of resolveManagedProjectEntry's --
 * one extra indexed SELECT per webhook/start, accepted to keep
 * resolveManagedProjectEntry's signature (and its existing data-layer tests)
 * untouched. config is not encrypted, so this needs no private key.
 */
export async function resolveProjectConfig(
  deps: ManagedProjectRegistryDeps | undefined,
  scm: ScmPort,
  repo: string,
): Promise<ProjectConfig> {
  if (deps) {
    const managedProject = await deps.store.get(repo);
    if (managedProject && managedProject.config !== null) {
      return managedProject.config;
    }
  }
  return loadProjectConfig(scm, repo);
}
