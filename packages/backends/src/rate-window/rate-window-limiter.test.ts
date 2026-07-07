import { describe, expect, it } from 'vitest';
import { RateWindowLimiter } from './rate-window-limiter';

describe('RateWindowLimiter', () => {
  it('allows calls up to maxCalls within the window', () => {
    let now = 0;
    const limiter = new RateWindowLimiter({ maxCalls: 3, windowMs: 5 * 60 * 60 * 1000 }, () => now);

    expect(limiter.msUntilSlot()).toBe(0);
    limiter.recordCall();
    now += 1000;
    expect(limiter.msUntilSlot()).toBe(0);
    limiter.recordCall();
    now += 1000;
    expect(limiter.msUntilSlot()).toBe(0);
    limiter.recordCall();
  });

  it('reports a positive wait once maxCalls is reached within the window', () => {
    let now = 0;
    const limiter = new RateWindowLimiter({ maxCalls: 2, windowMs: 5 * 60 * 60 * 1000 }, () => now);

    limiter.recordCall();
    now += 1000;
    limiter.recordCall();

    const wait = limiter.msUntilSlot();
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(5 * 60 * 60 * 1000);
  });

  it('frees a slot once the oldest call ages out of the window', () => {
    let now = 0;
    const windowMs = 5 * 60 * 60 * 1000;
    const limiter = new RateWindowLimiter({ maxCalls: 1, windowMs }, () => now);

    limiter.recordCall();
    expect(limiter.msUntilSlot()).toBeGreaterThan(0);

    now += windowMs; // oldest call is now exactly windowMs old -> pruned
    expect(limiter.msUntilSlot()).toBe(0);
  });

  it('does not double-count a call that has already aged out when computing the wait', () => {
    let now = 0;
    const windowMs = 1000;
    const limiter = new RateWindowLimiter({ maxCalls: 1, windowMs }, () => now);

    limiter.recordCall();
    now += 500;
    // still within window, slot taken
    expect(limiter.msUntilSlot()).toBe(500);
    now += 600; // now the first call is 1100ms old, outside the 1000ms window
    expect(limiter.msUntilSlot()).toBe(0);
  });
});
