import { describe, expect, it } from 'vitest';
import type { ManagedProjectStore } from '@agentops/contracts';
import { MemoryScmPort } from '@agentops/ports';
import { resolveProjectConfig } from './resolve-project-config';
import type { ManagedProjectRegistryDeps } from './resolve-managed-projects';

function fakeStore(rows: Array<{ project: string; repo: string; config?: unknown }>) {
  return {
    async get(repo: string) {
      const row = rows.find((r) => r.repo === repo);
      return row
        ? {
            id: '1',
            project: row.project,
            repo: row.repo,
            credentialSet: true,
            config: row.config ?? null,
            createdAt: '',
            updatedAt: '',
            trackerType: 'github' as const,
          }
        : null;
    },
  } as unknown as ManagedProjectStore;
}

describe('resolveProjectConfig', () => {
  it('uses the stored DB config directly when non-null (no repo file read)', async () => {
    const config = {
      stages: {},
      routing: {},
      brakes: {
        maxImplementAttempts: 3,
        maxIterations: 6,
        maxTokens: 200_000,
        maxBabysitRounds: 5,
      },
    };
    const deps = {
      store: fakeStore([{ project: 'acme-web', repo: 'acme/web', config }]),
      token: 'unused',
    } as ManagedProjectRegistryDeps;
    const scm = new MemoryScmPort(); // deliberately NOT seeded -- proves the file was never read

    const resolved = await resolveProjectConfig(deps, scm, 'acme/web');

    expect(resolved.brakes.maxTokens).toBe(200_000);
  });

  it('falls back to loadProjectConfig when the DB config is null', async () => {
    const deps = {
      store: fakeStore([{ project: 'acme-web', repo: 'acme/web' }]),
      token: 'unused',
    } as ManagedProjectRegistryDeps;
    const scm = new MemoryScmPort();
    scm.seedFile(
      'acme/web',
      'agentops.json',
      JSON.stringify({ fastVerifyCommands: ['pnpm lint'] }),
    );

    const resolved = await resolveProjectConfig(deps, scm, 'acme/web');

    expect(resolved.fastVerifyCommands).toEqual(['pnpm lint']);
  });

  it('falls back to loadProjectConfig when the repo is not DB-managed', async () => {
    const deps = { store: fakeStore([]), token: 'unused' } as ManagedProjectRegistryDeps;
    const scm = new MemoryScmPort();
    scm.seedFile(
      'acme/legacy',
      'agentops.json',
      JSON.stringify({ fullVerifyCommands: ['pnpm test'] }),
    );

    const resolved = await resolveProjectConfig(deps, scm, 'acme/legacy');

    expect(resolved.fullVerifyCommands).toEqual(['pnpm test']);
  });

  it('falls back to loadProjectConfig when no managed-project deps are configured at all', async () => {
    const scm = new MemoryScmPort();
    scm.seedFile(
      'acme/legacy',
      'agentops.json',
      JSON.stringify({ fastVerifyCommands: ['make test'] }),
    );

    const resolved = await resolveProjectConfig(undefined, scm, 'acme/legacy');

    expect(resolved.fastVerifyCommands).toEqual(['make test']);
  });
});
