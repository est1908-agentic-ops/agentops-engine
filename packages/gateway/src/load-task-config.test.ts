import { describe, expect, it } from 'vitest';
import { MemoryScmPort } from '@agentops/ports';
import { loadTaskConfig } from './load-task-config';

describe('loadTaskConfig', () => {
  it('fully defaults when agentops.json is absent', async () => {
    const scm = new MemoryScmPort();

    const config = await loadTaskConfig(scm, 'octocat/hello-world');

    expect(config.fastVerifyCommands).toBeUndefined();
    expect(config.routing.implement).toEqual({ backend: 'claude', model: 'claude-sonnet-5', effort: 'high' });
  });

  it('parses and merges a real agentops.json', async () => {
    const scm = new MemoryScmPort();
    scm.seedFile(
      'octocat/hello-world',
      'agentops.json',
      JSON.stringify({ fastVerifyCommands: ['pnpm lint'], routing: { implement: { backend: 'stub', model: 'stub-v1' } } }),
    );

    const config = await loadTaskConfig(scm, 'octocat/hello-world');

    expect(config.fastVerifyCommands).toEqual(['pnpm lint']);
    expect(config.routing.implement).toEqual({ backend: 'stub', model: 'stub-v1' });
  });

  it('throws a clear error on invalid JSON', async () => {
    const scm = new MemoryScmPort();
    scm.seedFile('octocat/hello-world', 'agentops.json', '{not-json');

    await expect(loadTaskConfig(scm, 'octocat/hello-world')).rejects.toThrow(/not valid JSON/);
  });
});
