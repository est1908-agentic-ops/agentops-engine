import type { ResolvedProjectEntry } from '@agentops/contracts';

export type ResolvedLinearProjectEntry = ResolvedProjectEntry & { trackerType: 'linear' };

// Static-registry-only, unlike resolveManagedProjectEntry's DB-first lookup
// for GitHub repos: the Postgres-backed managed-project registry
// (docs/superpowers/specs/2026-07-08-managed-project-registry-design.md)
// hardcodes trackerType 'github' and isn't extended to Linear here (see the
// Linear trigger design doc's non-goals).
export function findLinearProjectEntry(registry: ResolvedProjectEntry[], teamKey: string): ResolvedLinearProjectEntry | null {
  const found = registry.find(
    (entry): entry is ResolvedLinearProjectEntry => entry.trackerType === 'linear' && entry.linearTeamKey === teamKey,
  );
  return found ?? null;
}
