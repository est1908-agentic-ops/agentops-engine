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
  escalation: [{ backend: 'claude', model: 'opus', effort: 'max' }],
  // The 'platform' role uses a distinct worker backend entry ('platform', not
  // 'claude') carrying its own ServiceAccount/secrets/pod-label -- see
  // platform.ts.
  platform: [
    { backend: 'platform', model: 'claude-sonnet-5', effort: 'high' },
    { backend: 'pi', model: 'openrouter/deepseek-v4-pro' },
  ],
  bughunt: [
    { backend: 'claude', model: 'claude-sonnet-5', effort: 'high' },
    { backend: 'pi', model: 'openrouter/deepseek-v4-pro' },
  ],
  // Zero-cost demo/test tier: routes every stage to the stub backend (always
  // present in buildBackends) so devCycle runs end-to-end without spending
  // tokens. The CLI's seedDemoAgentopsConfig points each stage here.
  stub: [{ backend: 'stub', model: 'stub-v1' }],
};

// Resolve a tier name to its ordered ModelRef[], applying an optional effort
// override. Project-local tiers win over global tiers on name collision.
// `globalTiers` defaults to DEFAULT_TIERS (the hardcoded seed); the worker
// passes its loaded-from-DB map so operator edits take effect without a
// code change. Pure: no I/O, no async. Throws if the tier exists in neither
// source -- the caller (the activity) maps that to a non-retryable
// ApplicationFailure.
export function resolveTier(
  projectTiers: Record<string, ModelRef[]> | undefined,
  tierName: string,
  effortOverride?: 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  globalTiers: Record<string, ModelRef[]> = DEFAULT_TIERS,
): ModelRef[] {
  const entries = projectTiers?.[tierName] ?? globalTiers[tierName];
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
