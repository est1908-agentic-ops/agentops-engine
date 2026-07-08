export class ProviderRateLimitedError extends Error {}

// Deliberately narrower than "contains 429" alone -- a bare 429 without one
// of these phrases stays a generic backend error, since not every 429 a CLI
// surfaces is this specific throttle-and-recover class of failure. See
// docs/superpowers/specs/2026-07-08-provider-rate-limit-fallback-design.md.
export function isProviderRateLimitMessage(message: string): boolean {
  return /\b429\b/.test(message) && /(fair usage policy|rate limit|request frequency)/i.test(message);
}
