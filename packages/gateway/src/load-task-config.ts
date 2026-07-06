import { InvalidProductConfigError, parseProductConfig, type ProductConfig } from '@agentops/contracts';
import type { ScmPort } from '@agentops/ports';

// Mirrors packages/cli/src/load-product-config.ts's loadProductConfig — a
// deliberate small duplication rather than an extraction into a shared
// package, since neither existing package is a natural home for it yet.
// Unify once that refactor is worth doing on its own. Takes an
// already-constructed ScmPort (built by the caller from the resolved project
// entry's token) rather than building one itself, so this stays testable
// with a fake ScmPort instead of needing a live GitHub client.
export async function loadTaskConfig(scm: ScmPort, repo: string): Promise<ProductConfig> {
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
