// Self-clearing provider throttle (minutes): a 429 that names fair-usage /
// rate-limit / request-frequency. The retry-it-out class -- SP2's activity
// layer maps this to a retryable ApplicationFailure with a nextRetryDelay.
export class RateLimitError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

// Account-wide subscription usage cap (hours, not minutes). Examples from the
// Claude Code CLI:
//   "You've hit your session limit · resets 9:30am (UTC)" (issue-broccoli-94)
//   "You've hit your weekly limit · resets Aug 11, 7pm (UTC)" (rollbar-investigation
//    employee-hub failure 2026-08-10)
// A same-backend retry is pointless -- this is the class SP2's
// TierFallbackBackend catches to advance to a different credential domain.
// Narrow on purpose: requires BOTH a usage-window limit phrase and a "reset"
// phrase so a generic outage that happens to mention sessions isn't
// misclassified. Weekly/daily/monthly caps share the same physical timescale
// as the original session limit, so they must walk the tier fallback chain
// rather than burn Temporal's 5x retry budget on the same credential.
export class SessionLimitError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'SessionLimitError';
  }
}

// Thrown by TierFallbackBackend when every entry in the resolved tier chain
// has been exhausted (all hit SessionLimitError). The activity maps this to a
// non-retryable ApplicationFailure -- no point burning Temporal's 5x retry
// budget on an account-wide cap that lasts hours.
export class SessionLimitExhaustedError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'SessionLimitExhaustedError';
  }
}

// Deliberately narrower than "contains 429" alone -- a bare 429 without one
// of these phrases stays a generic backend error, since not every 429 a CLI
// surfaces is this specific throttle-and-recover class of failure. See
// docs/superpowers/specs/2026-07-10-model-tiering-fallback-design.md (Section 4).
export function isRateLimitMessage(message: string): boolean {
  return /\b429\b/.test(message) && /(fair usage policy|rate limit|request frequency)/i.test(message);
}

// Matches Claude subscription usage-window caps that last hours and reset on
// a schedule. Keep the reset phrase required so permanent account blocks
// ("session limit exceeded, contact support") stay generic ProcessCli errors
// rather than walking a fallback chain that cannot help.
export function isSessionLimitMessage(message: string): boolean {
  const usageWindowLimit =
    /\b(session|weekly|daily|monthly)\s+limit\b/i.test(message) ||
    /hit your .* limit/i.test(message);
  return usageWindowLimit && /\breset/i.test(message);
}
