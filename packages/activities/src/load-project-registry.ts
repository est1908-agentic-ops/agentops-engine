import { parseProjectRegistry, type ResolvedProjectEntry } from '@agentops/contracts';

export function loadProjectRegistry(env: NodeJS.ProcessEnv = process.env): ResolvedProjectEntry[] {
  const raw = env.PROJECT_REGISTRY_JSON;
  if (!raw) {
    return [];
  }
  const registry = parseProjectRegistry(JSON.parse(raw));
  return registry.map((entry) => {
    const token = env[entry.tokenEnvVar];
    if (!token) {
      throw new Error(`loadProjectRegistry: env var "${entry.tokenEnvVar}" for product "${entry.product}" is not set`);
    }
    return { ...entry, token };
  });
}
