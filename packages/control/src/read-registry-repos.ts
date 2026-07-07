import { parseProjectRegistry } from '@agentops/contracts';

/**
 * Repo slugs for the hint-repos picker, read directly from
 * PROJECT_REGISTRY_JSON. Deliberately does not resolve tokens the way
 * @agentops/activities' loadProjectRegistry does -- control only needs repo
 * names for a picker, never a credential, so it must not require every
 * registered repo's token env var to be set just to boot.
 */
export function readRegistryRepos(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.PROJECT_REGISTRY_JSON;
  if (!raw) {
    return [];
  }
  const registry = parseProjectRegistry(JSON.parse(raw));
  return registry.map((entry) => entry.repo);
}
