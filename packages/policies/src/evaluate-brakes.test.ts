import { describe, expect, it } from 'vitest';
import { evaluateBrakes } from './evaluate-brakes';

const brakes = { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 };

describe('evaluateBrakes', () => {
  it('returns null when nothing has tripped', () => {
    expect(
      evaluateBrakes({ implementAttempts: 1, iterations: 1, cumulativeTokens: 10, babysitRounds: 0 }, brakes),
    ).toBeNull();
  });

  it('trips token-brake when cumulative tokens reach the ceiling', () => {
    expect(
      evaluateBrakes(
        { implementAttempts: 1, iterations: 1, cumulativeTokens: 200_000, babysitRounds: 0 },
        brakes,
      ),
    ).toBe('token-brake');
  });

  it('trips iteration-brake when iterations reach the ceiling', () => {
    expect(
      evaluateBrakes({ implementAttempts: 1, iterations: 6, cumulativeTokens: 10, babysitRounds: 0 }, brakes),
    ).toBe('iteration-brake');
  });

  it('trips babysit-brake when babysit rounds reach the cap', () => {
    expect(
      evaluateBrakes({ implementAttempts: 1, iterations: 1, cumulativeTokens: 10, babysitRounds: 5 }, brakes),
    ).toBe('babysit-brake');
  });

  it('is deterministic: token-brake takes precedence when multiple brakes trip at once', () => {
    expect(
      evaluateBrakes(
        { implementAttempts: 1, iterations: 6, cumulativeTokens: 200_000, babysitRounds: 5 },
        brakes,
      ),
    ).toBe('token-brake');
  });

  it('is deterministic: iteration-brake takes precedence over babysit-brake', () => {
    expect(
      evaluateBrakes({ implementAttempts: 1, iterations: 6, cumulativeTokens: 10, babysitRounds: 5 }, brakes),
    ).toBe('iteration-brake');
  });
});
