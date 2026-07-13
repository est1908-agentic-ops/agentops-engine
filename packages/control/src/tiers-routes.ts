import { ModelRefSchema, z } from '@agentops/contracts';
import type { IncomingMessage } from 'node:http';
import type { PostgresTierStore } from '@agentops/activities';
import { readJsonBody, type HandlerResponse } from './handler-util';

// The full tier table: tier name -> ordered ModelRef[]. PUT replaces it wholesale.
const TiersTableSchema = z.record(z.string().min(1), z.array(ModelRefSchema));

const ALLOWED_BACKENDS = ['claude', 'cursor', 'pi', 'codex', 'stub', 'litellm'] as const;
const ALLOWED_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface TierEntryInput {
  backend: string;
  model: string;
  effort?: string;
}
export type TiersTableInput = Record<string, TierEntryInput[]>;

/**
 * Write-time validation (design §5d). Prevents fleet breakage: a malformed
 * tier (empty, bad enum, duplicate entry, gap in positions) never lands in
 * the DB. Returns an error message string, or null when valid.
 *
 * Zod (TiersTableSchema) already covers: backend enum, effort enum,
 * non-empty model, non-empty tier name. These rules cover the rest.
 */
export function validateTiersTable(tiers: TiersTableInput): string | null {
  const entries = Object.entries(tiers);
  if (entries.length === 0) {
    return 'tiers table must contain at least one tier';
  }
  for (const [tierName, models] of entries) {
    if (models.length === 0) {
      // rule 3: no empty tiers -- a stage routed here would have no primary.
      return `tier "${tierName}" has no entries`;
    }
    const seen = new Set<string>();
    for (let i = 0; i < models.length; i += 1) {
      const entry = models[i];
      // rule 4: positions are contiguous starting at 0 (here: array index is
      // the position, so this is structural -- flagged if a caller ever
      // smuggles gaps via a sparse shape, which Zod rejects, but kept explicit).
      if (!ALLOWED_BACKENDS.includes(entry.backend as (typeof ALLOWED_BACKENDS)[number])) {
        return `tier "${tierName}" position ${i}: invalid backend "${entry.backend}"`;
      }
      if (entry.effort !== undefined && !ALLOWED_EFFORTS.includes(entry.effort as (typeof ALLOWED_EFFORTS)[number])) {
        return `tier "${tierName}" position ${i}: invalid effort "${entry.effort}"`;
      }
      // rule 5: no duplicate (tier_name, backend, model).
      const key = `${entry.backend}/${entry.model}`;
      if (seen.has(key)) {
        return `tier "${tierName}": duplicate entry ${key}`;
      }
      seen.add(key);
    }
  }
  return null;
}

export async function handleListTiers(deps: { tierStore?: PostgresTierStore }): Promise<HandlerResponse> {
  if (!deps.tierStore) {
    return { status: 503, body: { error: 'tier store unavailable (requires ENGINE_DB_HOST)' } };
  }
  const map = await deps.tierStore.loadAll();
  const tiers: Record<string, unknown[]> = {};
  for (const [name, entries] of map.entries()) {
    tiers[name] = entries;
  }
  return { status: 200, body: tiers };
}

export async function handleReplaceTiers(
  deps: { tierStore?: PostgresTierStore },
  req: IncomingMessage,
): Promise<HandlerResponse> {
  if (!deps.tierStore) {
    return { status: 503, body: { error: 'tier store unavailable (requires ENGINE_DB_HOST)' } };
  }
  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: 'invalid JSON body' } };
  }
  const parsed = TiersTableSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') } };
  }
  const validationError = validateTiersTable(parsed.data);
  if (validationError) {
    return { status: 400, body: { error: validationError } };
  }
  await deps.tierStore.replaceAll(parsed.data);
  return { status: 200, body: parsed.data };
}
