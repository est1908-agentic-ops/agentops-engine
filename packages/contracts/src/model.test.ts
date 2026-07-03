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
