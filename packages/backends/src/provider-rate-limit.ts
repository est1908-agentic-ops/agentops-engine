export class ProviderRateLimitedError extends Error {}

// Account-wide subscription cap (e.g. the Claude Code CLI "You've hit your
// session limit · resets 9:30am (UTC)" from issue-broccoli-94). Lasts hours,
// not minutes, so a same-backend retry is pointless -- this is the class SP2's
// TierFallbackBackend catches to advance to a different credential domain.
// Narrow on purpose: requires BOTH "session limit" and a "reset" phrase so a
// generic outage that happens to mention sessions isn't misclassified.
export class SessionLimitError extends Error {}

// Deliberately narrower than "contains 429" alone -- a bare 429 without one
// of these phrases stays a generic backend error, since not every 429 a CLI
// surfaces is this specific throttle-and-recover class of failure. See
// docs/superpowers/specs/2026-07-08-provider-rate-limit-fallback-design.md.
export function isProviderRateLimitMessage(message: string): boolean {
  return /\b429\b/.test(message) && /(fair usage policy|rate limit|request frequency)/i.test(message);
}

export function isSessionLimitMessage(message: string): boolean {
  return /session limit/i.test(message) && /reset/i.test(message);
}
