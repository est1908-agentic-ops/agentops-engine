import { describe, expect, it } from 'vitest';
import { isProviderRateLimitMessage } from './provider-rate-limit';

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
