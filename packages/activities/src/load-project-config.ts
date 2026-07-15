import type { ScmPort } from '@agentops/ports';
import {
  InvalidProjectConfigError,
  parseProjectConfig,
  type ProjectConfig,
} from '@agentops/contracts';

// Checked in this order; first one present wins. `agentops.json` stays first for
// backward compatibility with every project configured before the alternates existed.
const CONFIG_CANDIDATE_PATHS = [
  'agentops.json',
  '.agentops.json',
  '.agentops/settings.json',
  '.agentops/agentops.json',
];

async function findConfigFile(
  scm: ScmPort,
  repo: string,
): Promise<{ path: string; raw: string } | null> {
  for (const path of CONFIG_CANDIDATE_PATHS) {
    const raw = await scm.readFile(repo, path);
    if (raw !== null) {
      return { path, raw };
    }
  }
  return null;
}

export async function loadProjectConfig(scm: ScmPort, repo: string): Promise<ProjectConfig> {
  const found = await findConfigFile(scm, repo);
  if (found === null) {
    return parseProjectConfig({});
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(found.raw);
  } catch (err) {
    throw new InvalidProjectConfigError(
      `${repo}/${found.path} is not valid JSON: ${(err as Error).message}`,
    );
  }

  return parseProjectConfig(parsed);
}
