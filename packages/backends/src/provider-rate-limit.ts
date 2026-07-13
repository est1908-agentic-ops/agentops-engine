// Self-clearing provider throttle (minutes): a 429 that names fair-usage /
// rate-limit / request-frequency. The retry-it-out class -- SP2's activity
// layer maps this to a retryable ApplicationFailure with a nextRetryDelay.
export class RateLimitError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

// Account-wide subscription cap (e.g. the Claude Code CLI "You've hit your
// session limit · resets 9:30am (UTC)" from issue-broccoli-94). Lasts hours,
// not minutes, so a same-backend retry is pointless -- this is the class SP2's
// TierFallbackBackend catches to advance to a different credential domain.
// Narrow on purpose: requires BOTH "session limit" and a "reset" phrase so a
// generic outage that happens to mention sessions isn't misclassified.
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

export function isSessionLimitMessage(message: string): boolean {
  return /session limit/i.test(message) && /\breset/i.test(message);
}
