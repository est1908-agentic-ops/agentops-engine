import { describe, expect, it } from 'vitest';
import { InvalidProjectConfigError, parseProjectConfig, ProjectConfigSchema } from './project-config';

const validConfig = {
  fastVerifyCommands: ['pnpm lint'],
  fullVerifyCommands: ['pnpm test'],
  stages: { assess: false, triage: false },
  routing: { implement: { backend: 'stub', model: 'stub-v1' } },
  brakes: { maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 },
};

describe('ProjectConfigSchema', () => {
  it('parses a minimal valid config', () => {
    const parsed = ProjectConfigSchema.parse(validConfig);
    expect(parsed.brakes.maxImplementAttempts).toBe(3);
    expect(parsed.escalation).toBeUndefined();
  });

  it('accepts an optional escalation model', () => {
    const parsed = ProjectConfigSchema.parse({
      ...validConfig,
      escalation: { backend: 'claude', model: 'opus' },
    });
    expect(parsed.escalation?.model).toBe('opus');
  });

  it('rejects a config missing brakes', () => {
    const { brakes: _brakes, ...withoutBrakes } = validConfig;
    expect(() => ProjectConfigSchema.parse(withoutBrakes)).toThrow();
  });

  it('accepts a config with no verify commands configured at all', () => {
    expect(() =>
      ProjectConfigSchema.parse({
        stages: {},
        routing: {},
        brakes: { maxIterations: 1, maxTokens: 1, maxBabysitRounds: 1 },
      }),
    ).not.toThrow();
  });

  it('still validates fastVerifyCommands/fullVerifyCommands as string arrays when present', () => {
    expect(() =>
      ProjectConfigSchema.parse({
        fastVerifyCommands: ['pnpm lint'],
        fullVerifyCommands: 'not-an-array',
        stages: {},
        routing: {},
        brakes: { maxIterations: 1, maxTokens: 1, maxBabysitRounds: 1 },
      }),
    ).toThrow();
  });

  it('accepts an optional image and services array', () => {
    const parsed = ProjectConfigSchema.parse({
      ...validConfig,
      image: 'ghcr.io/example/agentops:latest',
      services: [
        {
          name: 'postgres',
          image: 'pgvector/pgvector:pg18',
          env: { POSTGRES_USER: 'app' },
          readiness: { type: 'exec', command: ['pg_isready', '-U', 'app'] },
        },
        { name: 'redis', image: 'redis:7-alpine', readiness: { type: 'tcpSocket', port: 6379 } },
      ],
    });
    expect(parsed.image).toBe('ghcr.io/example/agentops:latest');
    expect(parsed.services).toHaveLength(2);
    expect(parsed.services?.[1]).toEqual({
      name: 'redis',
      image: 'redis:7-alpine',
      readiness: { type: 'tcpSocket', port: 6379 },
    });
  });

  it('rejects a service missing a readiness check', () => {
    expect(() =>
      ProjectConfigSchema.parse({
        ...validConfig,
        services: [{ name: 'postgres', image: 'pgvector/pgvector:pg18' }],
      }),
    ).toThrow();
  });

  it('accepts an optional initCommands string array', () => {
    const parsed = ProjectConfigSchema.parse({ ...validConfig, initCommands: ['pnpm install'] });
    expect(parsed.initCommands).toEqual(['pnpm install']);
  });

  it('rejects initCommands when not a string array', () => {
    expect(() => ProjectConfigSchema.parse({ ...validConfig, initCommands: 'pnpm install' })).toThrow();
  });
});

describe('parseProjectConfig', () => {
  it('fully defaults an empty config', () => {
    const config = parseProjectConfig({});
    expect(config.fastVerifyCommands).toBeUndefined();
    expect(config.fullVerifyCommands).toBeUndefined();
    expect(config.routing.implement).toEqual({ backend: 'pi', model: 'openrouter/deepseek-v4-flash', effort: 'high' });
    expect(config.brakes).toEqual({ maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 });
    expect(config.escalation).toBeUndefined();
  });

  it('passes verify commands through untouched when supplied', () => {
    const config = parseProjectConfig({ fastVerifyCommands: ['pnpm lint'], fullVerifyCommands: ['pnpm test'] });
    expect(config.fastVerifyCommands).toEqual(['pnpm lint']);
    expect(config.fullVerifyCommands).toEqual(['pnpm test']);
  });

  it('deep-merges a partial routing override, keeping other stages at default', () => {
    const config = parseProjectConfig({ routing: { implement: { backend: 'pi', model: 'pi-default' } } });
    expect(config.routing.implement).toEqual({ backend: 'pi', model: 'pi-default' });
    expect(config.routing.context).toEqual({ backend: 'claude', model: 'claude-sonnet-5', effort: 'medium' });
  });

  it('deep-merges a partial brakes override, keeping other brake numbers at default', () => {
    const config = parseProjectConfig({ brakes: { maxTokens: 50_000 } });
    expect(config.brakes.maxTokens).toBe(50_000);
    expect(config.brakes.maxIterations).toBe(6);
  });

  it('throws InvalidProjectConfigError when a field has the wrong type', () => {
    expect(() => parseProjectConfig({ brakes: { maxTokens: 'not-a-number' } })).toThrow(InvalidProjectConfigError);
  });

  it('throws InvalidProjectConfigError when raw is not an object', () => {
    expect(() => parseProjectConfig('not-an-object')).toThrow(InvalidProjectConfigError);
    expect(() => parseProjectConfig(null)).toThrow(InvalidProjectConfigError);
    expect(() => parseProjectConfig([])).toThrow(InvalidProjectConfigError);
  });

  it('never deep-merges fastVerifyCommands/fullVerifyCommands — they replace wholesale or stay absent', () => {
    const config = parseProjectConfig({ fastVerifyCommands: ['only-this'] });
    expect(config.fastVerifyCommands).toEqual(['only-this']);
    expect(config.fullVerifyCommands).toBeUndefined();
  });

  it('leaves image and services undefined when not configured, and passes them through untouched when supplied', () => {
    const empty = parseProjectConfig({});
    expect(empty.image).toBeUndefined();
    expect(empty.services).toBeUndefined();

    const configured = parseProjectConfig({
      image: 'ghcr.io/example/agentops:latest',
      services: [{ name: 'redis', image: 'redis:7-alpine', readiness: { type: 'tcpSocket', port: 6379 } }],
    });
    expect(configured.image).toBe('ghcr.io/example/agentops:latest');
    expect(configured.services).toEqual([
      { name: 'redis', image: 'redis:7-alpine', readiness: { type: 'tcpSocket', port: 6379 } },
    ]);
  });

  it('leaves initCommands undefined when not configured, and passes it through untouched when supplied', () => {
    const empty = parseProjectConfig({});
    expect(empty.initCommands).toBeUndefined();

    const configured = parseProjectConfig({ initCommands: ['pnpm install', 'pnpm worktree-setup'] });
    expect(configured.initCommands).toEqual(['pnpm install', 'pnpm worktree-setup']);
  });
});
