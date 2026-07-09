import { parseProjectRegistry } from '@agentops/contracts';

export interface RegistryEntrySummary {
  project: string;
  repo: string;
}

/**
 * Project/repo pairs from PROJECT_REGISTRY_JSON. Deliberately does not
 * resolve tokens the way @agentops/activities' loadProjectRegistry does --
 * control needs identity (hint-repos picker, devCycle target picker,
 * project-slug resolution at run start), never a credential, so it must not
 * require every registered repo's token env var to be set just to boot.
 */
export function readRegistryEntries(env: NodeJS.ProcessEnv = process.env): RegistryEntrySummary[] {
  const raw = env.PROJECT_REGISTRY_JSON;
  if (!raw) {
    return [];
  }
  return parseProjectRegistry(JSON.parse(raw)).map((entry) => ({ project: entry.project, repo: entry.repo }));
}
