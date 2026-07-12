import { describe, expect, it } from 'vitest';
import { isProviderRateLimitMessage, isSessionLimitMessage } from './provider-rate-limit';

describe('isProviderRateLimitMessage', () => {
  it('matches the real z.ai Fair Usage Policy 429 message', () => {
    expect(
      isProviderRateLimitMessage(
        "429 Your account's current usage pattern does not comply with the Fair Usage Policy, and your request frequency has been limited. For details, please refer to the Subscription Service Agreement. To restore access, please submit a request.",
      ),
    ).toBe(true);
  });

  it('matches a generic 429 that mentions rate limiting', () => {
    expect(isProviderRateLimitMessage('429 Too Many Requests: rate limit exceeded, retry later')).toBe(true);
  });

  it('does not match a 429 with no rate-limit wording', () => {
    expect(isProviderRateLimitMessage('429 payment required to continue using this model')).toBe(false);
  });

  it('does not match rate-limit wording with no 429', () => {
    expect(isProviderRateLimitMessage('the request frequency for this endpoint is limited')).toBe(false);
  });
});

describe('isSessionLimitMessage', () => {
  it('matches the real Claude subscription session-limit phrasing from issue-broccoli-94', () => {
    expect(isSessionLimitMessage("You've hit your session limit · resets 9:30am (UTC)")).toBe(true);
  });

  it('matches a session-limit message with a reset time', () => {
    expect(isSessionLimitMessage('session limit reached. resets at 2026-07-10T09:30:00Z')).toBe(true);
  });

  it('does not match "session limit" without a reset phrase', () => {
    expect(isSessionLimitMessage('session limit exceeded, contact support')).toBe(false);
  });

  it('does not match an unrelated rate-limit message', () => {
    expect(isSessionLimitMessage('429 Too Many Requests: rate limit exceeded')).toBe(false);
  });
});
