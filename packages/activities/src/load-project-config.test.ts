import { describe, expect, it } from 'vitest';
import { MemoryScmPort } from '@agentops/ports';
import { InvalidProjectConfigError } from '@agentops/contracts';
import { loadProjectConfig } from './load-project-config';

describe('loadProjectConfig', () => {
  it('parses and validates a real agentops.json', async () => {
    const scm = new MemoryScmPort();
    scm.seedFile('octocat/demo', 'agentops.json', JSON.stringify({ fastVerifyCommands: ['pnpm lint'] }));

    const config = await loadProjectConfig(scm, 'octocat/demo');

    expect(config.fastVerifyCommands).toEqual(['pnpm lint']);
    expect(config.routing.implement).toEqual({ tier: 'implementation', effort: 'high' });
  });

  it('falls back to full defaults when agentops.json is missing', async () => {
    const scm = new MemoryScmPort();

    const config = await loadProjectConfig(scm, 'octocat/demo');

    expect(config.fastVerifyCommands).toBeUndefined();
    expect(config.brakes.maxTokens).toBe(200_000);
  });

  it('throws InvalidProjectConfigError on malformed JSON', async () => {
    const scm = new MemoryScmPort();
    scm.seedFile('octocat/demo', 'agentops.json', '{ not valid json');

    await expect(loadProjectConfig(scm, 'octocat/demo')).rejects.toThrow(InvalidProjectConfigError);
    await expect(loadProjectConfig(scm, 'octocat/demo')).rejects.toThrow(/not valid JSON/);
  });

  it('throws InvalidProjectConfigError (not a generic error) when the parsed content fails schema validation', async () => {
    const scm = new MemoryScmPort();
    scm.seedFile('octocat/demo', 'agentops.json', JSON.stringify({ brakes: { maxTokens: 'nope' } }));

    await expect(loadProjectConfig(scm, 'octocat/demo')).rejects.toThrow(InvalidProjectConfigError);
  });

  it('falls back to .agentops.json when agentops.json is absent', async () => {
    const scm = new MemoryScmPort();
    scm.seedFile('octocat/demo', '.agentops.json', JSON.stringify({ fastVerifyCommands: ['pnpm lint'] }));

    const config = await loadProjectConfig(scm, 'octocat/demo');

    expect(config.fastVerifyCommands).toEqual(['pnpm lint']);
  });

  it('falls back to .agentops/settings.json when agentops.json and .agentops.json are absent', async () => {
    const scm = new MemoryScmPort();
    scm.seedFile('octocat/demo', '.agentops/settings.json', JSON.stringify({ fastVerifyCommands: ['pnpm lint'] }));

    const config = await loadProjectConfig(scm, 'octocat/demo');

    expect(config.fastVerifyCommands).toEqual(['pnpm lint']);
  });

  it('falls back to .agentops/agentops.json when every other candidate is absent', async () => {
    const scm = new MemoryScmPort();
    scm.seedFile('octocat/demo', '.agentops/agentops.json', JSON.stringify({ fastVerifyCommands: ['pnpm lint'] }));

    const config = await loadProjectConfig(scm, 'octocat/demo');

    expect(config.fastVerifyCommands).toEqual(['pnpm lint']);
  });

  it('prefers agentops.json over any alternate path when more than one exists', async () => {
    const scm = new MemoryScmPort();
    scm.seedFile('octocat/demo', 'agentops.json', JSON.stringify({ fastVerifyCommands: ['from-canonical'] }));
    scm.seedFile('octocat/demo', '.agentops.json', JSON.stringify({ fastVerifyCommands: ['from-dotfile'] }));
    scm.seedFile('octocat/demo', '.agentops/settings.json', JSON.stringify({ fastVerifyCommands: ['from-settings'] }));

    const config = await loadProjectConfig(scm, 'octocat/demo');

    expect(config.fastVerifyCommands).toEqual(['from-canonical']);
  });

  it('throws InvalidProjectConfigError naming the alternate path that actually matched on malformed JSON', async () => {
    const scm = new MemoryScmPort();
    scm.seedFile('octocat/demo', '.agentops/settings.json', '{ not valid json');

    await expect(loadProjectConfig(scm, 'octocat/demo')).rejects.toThrow(/\.agentops\/settings\.json is not valid JSON/);
  });
});
