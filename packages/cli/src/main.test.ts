import { describe, expect, it } from 'vitest';
import { GithubScmPort, MemoryScmPort } from '@agentops/ports';
import { loadProductConfig } from './load-product-config';
import { buildStartScmPort, parseFlags, seedDemoAgentopsConfig } from './main';

describe('seedDemoAgentopsConfig', () => {
  it('produces a config that keeps every stage on the stub backend', async () => {
    const scm = new MemoryScmPort();
    seedDemoAgentopsConfig(scm, 'demo/repo');

    const config = await loadProductConfig(scm, 'demo/repo');

    expect(config.fastVerifyCommands).toEqual(['pnpm lint']);
    expect(config.fullVerifyCommands).toEqual(['pnpm test']);
    for (const stage of ['context', 'assess', 'design', 'plan', 'implement', 'full_verify', 'review'] as const) {
      expect(config.routing[stage]).toEqual({ backend: 'stub', model: 'stub-v1' });
    }
  });
});

describe('parseFlags', () => {
  it('parses --flag value pairs into an object', () => {
    expect(parseFlags(['--goal', 'do it', '--repo', 'o/r'])).toEqual({ goal: 'do it', repo: 'o/r' });
  });

  it('throws a clear error when a flag has no value', () => {
    expect(() => parseFlags(['--goal'])).toThrow(/missing value for --goal/);
  });

  it('throws when a flag value looks like another flag', () => {
    expect(() => parseFlags(['--goal', '--repo', 'o/r'])).toThrow(/missing value for --goal/);
  });
});

describe('buildStartScmPort', () => {
  it('returns a seeded MemoryScmPort when GITHUB_TOKEN is unset', async () => {
    const scm = buildStartScmPort(undefined, 'demo/repo');

    expect(scm).toBeInstanceOf(MemoryScmPort);
    const config = await loadProductConfig(scm, 'demo/repo');
    expect(config.routing.implement).toEqual({ backend: 'stub', model: 'stub-v1' });
  });

  it('returns a GithubScmPort when GITHUB_TOKEN is set', () => {
    const scm = buildStartScmPort('fake-token', 'octocat/demo');

    expect(scm).toBeInstanceOf(GithubScmPort);
  });
});
