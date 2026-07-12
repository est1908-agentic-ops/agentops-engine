import type { ModelRef } from '@agentops/contracts';

// System-default tiers. These are the hardcoded seed values SP3 will promote
// into a Postgres table editable from Mission Control. The order is BOTH the
// primary preference (entries[0] is the primary) AND the session-limit
// fallback chain (SessionLimitError advances to entries[1], [2], ...).
// See docs/superpowers/specs/2026-07-10-model-tiering-fallback-design.md.
export const DEFAULT_TIERS: Record<string, ModelRef[]> = {
  smart: [
    { backend: 'claude', model: 'opus', effort: 'high' },
    { backend: 'pi', model: 'zai/glm-5.2' },
    { backend: 'pi', model: 'openrouter/deepseek-v4-pro' },
  ],
  implementation: [
    { backend: 'claude', model: 'haiku', effort: 'high' },
    { backend: 'pi', model: 'openrouter/deepseek-v4-flash', effort: 'high' },
    { backend: 'pi', model: 'zai/glm-5.2', effort: 'low' },
  ],
  review: [
    { backend: 'claude', model: 'opus', effort: 'high' },
    { backend: 'pi', model: 'zai/glm-5.2' },
  ],
  escalation: [
    { backend: 'claude', model: 'opus', effort: 'max' },
  ],
  // The 'platform' role uses a distinct worker backend entry ('platform', not
  // 'claude') carrying its own ServiceAccount/secrets/pod-label -- see
  // platform.ts. ModelRefSchema.backend's enum doesn't include 'platform'
  // today; the cast bypasses TS enum narrowing for this hardcoded constant.
  // SP3's DB promotion will widen the enum.
  platform: [
    { backend: 'platform' as ModelRef['backend'], model: 'claude-sonnet-5', effort: 'high' },
    { backend: 'pi', model: 'openrouter/deepseek-v4-pro' },
  ],
  bughunt: [
    { backend: 'claude', model: 'claude-sonnet-5', effort: 'high' },
    { backend: 'pi', model: 'openrouter/deepseek-v4-pro' },
  ],
};

// Resolve a tier name to its ordered ModelRef[], applying an optional effort
// override. Project-local tiers win over global defaults on name collision.
// Pure: no I/O, no async. Throws if the tier exists in neither source -- the
// caller (the activity) maps that to a non-retryable ApplicationFailure.
export function resolveTier(
  projectTiers: Record<string, ModelRef[]> | undefined,
  tierName: string,
  effortOverride?: 'low' | 'medium' | 'high' | 'xhigh' | 'max',
): ModelRef[] {
  const entries = projectTiers?.[tierName] ?? DEFAULT_TIERS[tierName];
  if (!entries || entries.length === 0) {
    throw new Error(
      `resolveTier: tier "${tierName}" not found in project-local or global defaults`,
    );
  }
  if (!effortOverride) {
    return entries;
  }
  return entries.map((entry) => ({ ...entry, effort: effortOverride }));
}
