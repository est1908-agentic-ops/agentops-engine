import type { ScmPort } from '@agentops/ports';
import { InvalidProductConfigError, parseProductConfig, type ProductConfig } from '@agentops/contracts';

export async function loadProductConfig(scm: ScmPort, repo: string): Promise<ProductConfig> {
  const raw = await scm.readFile(repo, 'agentops.json');
  if (raw === null) {
    return parseProductConfig({});
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new InvalidProductConfigError(`${repo}/agentops.json is not valid JSON: ${(err as Error).message}`);
  }

  return parseProductConfig(parsed);
}
