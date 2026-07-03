import { describe, expect, it } from 'vitest';
import { ModelRefSchema, BrakesSchema, RoutingSchema } from './model';

describe('ModelRefSchema', () => {
  it('accepts a backend + model pair', () => {
    expect(ModelRefSchema.parse({ backend: 'stub', model: 'stub-v1' })).toEqual({
      backend: 'stub',
      model: 'stub-v1',
    });
  });

  it('rejects a blank model name', () => {
    expect(() => ModelRefSchema.parse({ backend: 'stub', model: '' })).toThrow();
  });

  it('accepts an optional effort level', () => {
    expect(() => ModelRefSchema.parse({ backend: 'claude', model: 'claude-sonnet-5', effort: 'high' })).not.toThrow();
  });

  it('accepts a ModelRef with no effort at all', () => {
    expect(() => ModelRefSchema.parse({ backend: 'claude', model: 'claude-sonnet-5' })).not.toThrow();
  });

  it('rejects an invalid effort level', () => {
    expect(() => ModelRefSchema.parse({ backend: 'claude', model: 'claude-sonnet-5', effort: 'extreme' })).toThrow();
  });
});

describe('BrakesSchema', () => {
  it('applies the default maxImplementAttempts of 3', () => {
    const brakes = BrakesSchema.parse({
      maxIterations: 6,
      maxTokens: 200_000,
      maxBabysitRounds: 5,
    });
    expect(brakes.maxImplementAttempts).toBe(3);
  });
});

describe('RoutingSchema', () => {
  it('allows a partial routing table', () => {
    const routing = RoutingSchema.parse({ implement: { backend: 'stub', model: 'stub-v1' } });
    expect(routing.implement).toEqual({ backend: 'stub', model: 'stub-v1' });
    expect(routing.review).toBeUndefined();
  });
});
