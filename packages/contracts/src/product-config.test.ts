import { describe, expect, it } from 'vitest';
import { ProductConfigSchema } from './product-config';

const validConfig = {
  fastVerifyCommands: ['pnpm lint'],
  fullVerifyCommands: ['pnpm test'],
  stages: { assess: false, triage: false },
  routing: { implement: { backend: 'stub', model: 'stub-v1' } },
  brakes: { maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 },
};

describe('ProductConfigSchema', () => {
  it('parses a minimal valid config', () => {
    const parsed = ProductConfigSchema.parse(validConfig);
    expect(parsed.brakes.maxImplementAttempts).toBe(3);
    expect(parsed.escalation).toBeUndefined();
  });

  it('accepts an optional escalation model', () => {
    const parsed = ProductConfigSchema.parse({
      ...validConfig,
      escalation: { backend: 'claude', model: 'opus' },
    });
    expect(parsed.escalation?.model).toBe('opus');
  });

  it('rejects a config missing brakes', () => {
    const { brakes: _brakes, ...withoutBrakes } = validConfig;
    expect(() => ProductConfigSchema.parse(withoutBrakes)).toThrow();
  });
});
