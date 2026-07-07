import type { ScmPort } from '@agentops/ports';
import { InvalidProductConfigError, parseProductConfig, type ProductConfig } from '@agentops/contracts';

// Checked in this order; first one present wins. `agentops.json` stays first for
// backward compatibility with every product configured before the alternates existed.
const CONFIG_CANDIDATE_PATHS = ['agentops.json', '.agentops.json', '.agentops/settings.json', '.agentops/agentops.json'];

export async function loadProductConfig(scm: ScmPort, repo: string): Promise<ProductConfig> {
  let raw: string | null = null;
  let matchedPath: string | undefined;
  for (const path of CONFIG_CANDIDATE_PATHS) {
    raw = await scm.readFile(repo, path);
    if (raw !== null) {
      matchedPath = path;
      break;
    }
  }
  if (raw === null || matchedPath === undefined) {
    return parseProductConfig({});
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new InvalidProductConfigError(`${repo}/${matchedPath} is not valid JSON: ${(err as Error).message}`);
  }

  return parseProductConfig(parsed);
}
