import { describe, expect, it } from 'vitest';
import { MemoryScmPort } from '@agentops/ports';
import { InvalidProductConfigError } from '@agentops/contracts';
import { loadProductConfig } from './load-product-config';

describe('loadProductConfig', () => {
  it('parses and validates a real agentops.json', async () => {
    const scm = new MemoryScmPort();
    scm.seedFile('octocat/demo', 'agentops.json', JSON.stringify({ fastVerifyCommands: ['pnpm lint'] }));

    const config = await loadProductConfig(scm, 'octocat/demo');

    expect(config.fastVerifyCommands).toEqual(['pnpm lint']);
    expect(config.routing.implement).toEqual({ backend: 'claude', model: 'claude-sonnet-5', effort: 'high' });
  });

  it('falls back to full defaults when agentops.json is missing', async () => {
    const scm = new MemoryScmPort();

    const config = await loadProductConfig(scm, 'octocat/demo');

    expect(config.fastVerifyCommands).toBeUndefined();
    expect(config.brakes.maxTokens).toBe(200_000);
  });

  it('throws InvalidProductConfigError on malformed JSON', async () => {
    const scm = new MemoryScmPort();
    scm.seedFile('octocat/demo', 'agentops.json', '{ not valid json');

    await expect(loadProductConfig(scm, 'octocat/demo')).rejects.toThrow(InvalidProductConfigError);
    await expect(loadProductConfig(scm, 'octocat/demo')).rejects.toThrow(/not valid JSON/);
  });

  it('throws InvalidProductConfigError (not a generic error) when the parsed content fails schema validation', async () => {
    const scm = new MemoryScmPort();
    scm.seedFile('octocat/demo', 'agentops.json', JSON.stringify({ brakes: { maxTokens: 'nope' } }));

    await expect(loadProductConfig(scm, 'octocat/demo')).rejects.toThrow(InvalidProductConfigError);
  });

  it('falls back to .agentops.json when agentops.json is absent', async () => {
    const scm = new MemoryScmPort();
    scm.seedFile('octocat/demo', '.agentops.json', JSON.stringify({ fastVerifyCommands: ['pnpm lint'] }));

    const config = await loadProductConfig(scm, 'octocat/demo');

    expect(config.fastVerifyCommands).toEqual(['pnpm lint']);
  });

  it('falls back to .agentops/settings.json when agentops.json and .agentops.json are absent', async () => {
    const scm = new MemoryScmPort();
    scm.seedFile('octocat/demo', '.agentops/settings.json', JSON.stringify({ fastVerifyCommands: ['pnpm lint'] }));

    const config = await loadProductConfig(scm, 'octocat/demo');

    expect(config.fastVerifyCommands).toEqual(['pnpm lint']);
  });

  it('falls back to .agentops/agentops.json when every other candidate is absent', async () => {
    const scm = new MemoryScmPort();
    scm.seedFile('octocat/demo', '.agentops/agentops.json', JSON.stringify({ fastVerifyCommands: ['pnpm lint'] }));

    const config = await loadProductConfig(scm, 'octocat/demo');

    expect(config.fastVerifyCommands).toEqual(['pnpm lint']);
  });

  it('prefers agentops.json over any alternate path when more than one exists', async () => {
    const scm = new MemoryScmPort();
    scm.seedFile('octocat/demo', 'agentops.json', JSON.stringify({ fastVerifyCommands: ['from-canonical'] }));
    scm.seedFile('octocat/demo', '.agentops.json', JSON.stringify({ fastVerifyCommands: ['from-dotfile'] }));
    scm.seedFile('octocat/demo', '.agentops/settings.json', JSON.stringify({ fastVerifyCommands: ['from-settings'] }));

    const config = await loadProductConfig(scm, 'octocat/demo');

    expect(config.fastVerifyCommands).toEqual(['from-canonical']);
  });

  it('throws InvalidProductConfigError naming the alternate path that actually matched on malformed JSON', async () => {
    const scm = new MemoryScmPort();
    scm.seedFile('octocat/demo', '.agentops/settings.json', '{ not valid json');

    await expect(loadProductConfig(scm, 'octocat/demo')).rejects.toThrow(/\.agentops\/settings\.json is not valid JSON/);
  });
});
