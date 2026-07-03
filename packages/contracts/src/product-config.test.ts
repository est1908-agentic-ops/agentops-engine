import { describe, expect, it } from 'vitest';
import { InvalidProductConfigError, parseProductConfig, ProductConfigSchema } from './product-config';

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

  it('accepts a config with no verify commands configured at all', () => {
    expect(() =>
      ProductConfigSchema.parse({
        stages: {},
        routing: {},
        brakes: { maxIterations: 1, maxTokens: 1, maxBabysitRounds: 1 },
      }),
    ).not.toThrow();
  });

  it('still validates fastVerifyCommands/fullVerifyCommands as string arrays when present', () => {
    expect(() =>
      ProductConfigSchema.parse({
        fastVerifyCommands: ['pnpm lint'],
        fullVerifyCommands: 'not-an-array',
        stages: {},
        routing: {},
        brakes: { maxIterations: 1, maxTokens: 1, maxBabysitRounds: 1 },
      }),
    ).toThrow();
  });
});

describe('parseProductConfig', () => {
  it('fully defaults an empty config', () => {
    const config = parseProductConfig({});
    expect(config.fastVerifyCommands).toBeUndefined();
    expect(config.fullVerifyCommands).toBeUndefined();
    expect(config.routing.implement).toEqual({ backend: 'claude', model: 'claude-sonnet-5', effort: 'high' });
    expect(config.brakes).toEqual({ maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 });
    expect(config.escalation).toBeUndefined();
  });

  it('passes verify commands through untouched when supplied', () => {
    const config = parseProductConfig({ fastVerifyCommands: ['pnpm lint'], fullVerifyCommands: ['pnpm test'] });
    expect(config.fastVerifyCommands).toEqual(['pnpm lint']);
    expect(config.fullVerifyCommands).toEqual(['pnpm test']);
  });

  it('deep-merges a partial routing override, keeping other stages at default', () => {
    const config = parseProductConfig({ routing: { implement: { backend: 'pi', model: 'pi-default' } } });
    expect(config.routing.implement).toEqual({ backend: 'pi', model: 'pi-default' });
    expect(config.routing.context).toEqual({ backend: 'claude', model: 'claude-sonnet-5', effort: 'medium' });
  });

  it('deep-merges a partial brakes override, keeping other brake numbers at default', () => {
    const config = parseProductConfig({ brakes: { maxTokens: 50_000 } });
    expect(config.brakes.maxTokens).toBe(50_000);
    expect(config.brakes.maxIterations).toBe(6);
  });

  it('throws InvalidProductConfigError when a field has the wrong type', () => {
    expect(() => parseProductConfig({ brakes: { maxTokens: 'not-a-number' } })).toThrow(InvalidProductConfigError);
  });

  it('throws InvalidProductConfigError when raw is not an object', () => {
    expect(() => parseProductConfig('not-an-object')).toThrow(InvalidProductConfigError);
    expect(() => parseProductConfig(null)).toThrow(InvalidProductConfigError);
    expect(() => parseProductConfig([])).toThrow(InvalidProductConfigError);
  });

  it('never deep-merges fastVerifyCommands/fullVerifyCommands — they replace wholesale or stay absent', () => {
    const config = parseProductConfig({ fastVerifyCommands: ['only-this'] });
    expect(config.fastVerifyCommands).toEqual(['only-this']);
    expect(config.fullVerifyCommands).toBeUndefined();
  });
});
