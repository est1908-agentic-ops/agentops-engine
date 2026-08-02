import { describe, expect, it } from 'vitest';
import { MemoryWorkspaceManager } from './memory-workspace-manager';
import { repositorySessionIdentity } from './workspace-manager';

describe('MemoryWorkspaceManager', () => {
  it('returns a deterministic fake workspace without touching the filesystem', async () => {
    const manager = new MemoryWorkspaceManager();

    const result = await manager.prepare('task-1', 'owner/repo');

    expect(result).toEqual({
      workspaceRef: 'memory://owner/repo/task-1',
      branch: 'agentops/task-1',
      baseBranch: 'main',
    });
  });

  it('tracks which workspaceRefs have been prepared and cleaned up', async () => {
    const manager = new MemoryWorkspaceManager();
    const { workspaceRef } = await manager.prepare('task-1', 'owner/repo');

    expect(manager.isPrepared(workspaceRef)).toBe(true);
    expect(manager.isCleanedUp(workspaceRef)).toBe(false);

    await manager.cleanup(workspaceRef, 'owner/repo');

    expect(manager.isCleanedUp(workspaceRef)).toBe(true);
  });

  it('throws if cleanup is called on a workspaceRef that was never prepared', async () => {
    const manager = new MemoryWorkspaceManager();
    await expect(manager.cleanup('memory://never/prepared', 'owner/repo')).rejects.toThrow(
      /never prepared/,
    );
  });

  it('records the initCommands it was asked to prepare with, without executing anything', async () => {
    const manager = new MemoryWorkspaceManager();
    const { workspaceRef } = await manager.prepare('task-1', 'owner/repo', ['pnpm install']);

    expect(manager.initCommandsFor(workspaceRef)).toEqual(['pnpm install']);
  });

  it('records initCommands as undefined when none were given', async () => {
    const manager = new MemoryWorkspaceManager();
    const { workspaceRef } = await manager.prepare('task-1', 'owner/repo');

    expect(manager.initCommandsFor(workspaceRef)).toBeUndefined();
  });
});

describe('MemoryWorkspaceManager — scratch workspaces', () => {
  it('prepareScratch returns a workspaceRef and marks it prepared', async () => {
    const manager = new MemoryWorkspaceManager();

    const { workspaceRef } = await manager.prepareScratch('task-1');

    expect(manager.isScratchPrepared(workspaceRef)).toBe(true);
  });

  it('cleanupScratch marks a prepared scratch workspace cleaned up', async () => {
    const manager = new MemoryWorkspaceManager();
    const { workspaceRef } = await manager.prepareScratch('task-1');

    await manager.cleanupScratch(workspaceRef);

    expect(manager.isScratchCleanedUp(workspaceRef)).toBe(true);
  });

  it('throws when cleanupScratch is called on a workspaceRef that was never prepared', async () => {
    const manager = new MemoryWorkspaceManager();

    await expect(manager.cleanupScratch('memory://scratch/never-prepared')).rejects.toThrow(
      /never prepared/,
    );
  });
});

describe('MemoryWorkspaceManager — repository sessions', () => {
  it('uses collision-resistant owner and task identities and rejects duplicate sessions', async () => {
    const manager = new MemoryWorkspaceManager();
    const first = await manager.prepareRepositorySession('a/b', {
      taskId: 'c/d',
      repositories: [{ repo: 'acme/app' }],
    });
    const second = await manager.prepareRepositorySession('a-b', {
      taskId: 'c-d',
      repositories: [{ repo: 'acme/app' }],
    });
    expect(second.workspaceRef).not.toBe(first.workspaceRef);
    await expect(
      manager.prepareRepositorySession('a/b', {
        taskId: 'c/d',
        repositories: [{ repo: 'acme/app' }],
      }),
    ).rejects.toThrow(/already exists/);
    await expect(manager.cleanupRepositorySession('a-b', first.workspaceRef)).rejects.toThrow(
      /different owner/,
    );
    await expect(
      manager.cleanupRepositorySession('a/b', 'memory://repository-session/not-a-valid-key'),
    ).rejects.toThrow(/invalid/);
    const malformed = `memory://repository-session/${repositorySessionIdentity('a/b')}/not-a-session`;
    await expect(manager.cleanupRepositorySession('a/b', malformed)).rejects.toThrow(/invalid/);
    await expect(manager.touchRepositorySession('a/b', malformed)).rejects.toThrow(/invalid/);
  });
  it('tracks deterministic owned sessions, touch, cleanup, and pruning', async () => {
    let time = 0;
    const manager = new MemoryWorkspaceManager({ now: () => time });
    const session = await manager.prepareRepositorySession('hub', {
      taskId: 'task/one',
      repositories: [{ repo: 'acme/app' }, { repo: 'acme/shared', ref: 'main' }],
    });
    expect(session.workspaceRef).toBe(
      `memory://repository-session/${repositorySessionIdentity('hub')}/${repositorySessionIdentity('task/one')}`,
    );
    expect(session.repositories.map((repository) => repository.relativePath)).toEqual([
      'repositories/acme/app',
      'repositories/acme/shared',
    ]);
    time = 2;
    await manager.touchRepositorySession('hub', session.workspaceRef);
    expect(manager.repositorySessionFor(session.workspaceRef)?.lastUsedAt).toBe(2);
    await expect(manager.touchRepositorySession('other', session.workspaceRef)).rejects.toThrow(
      /owner/,
    );
    await expect(manager.cleanupRepositorySession('other', session.workspaceRef)).rejects.toThrow(
      /owner/,
    );
    await manager.cleanupRepositorySession('hub', session.workspaceRef);
    await expect(
      manager.cleanupRepositorySession('hub', session.workspaceRef),
    ).resolves.toBeUndefined();
  });

  it('prunes expired and non-live sessions but not sessions at the TTL boundary', async () => {
    let time = 0;
    const manager = new MemoryWorkspaceManager({ now: () => time });
    const active = await manager.prepareRepositorySession('live', {
      taskId: 'active',
      repositories: [{ repo: 'acme/app' }],
    });
    const gone = await manager.prepareRepositorySession('gone', {
      taskId: 'gone',
      repositories: [{ repo: 'acme/gone' }],
    });
    time = 86_400_000;
    const first = await manager.pruneOrphans([], ['live']);
    expect(first.removed).toContain(gone.workspaceRef);
    expect(manager.repositorySessionFor(active.workspaceRef)).toBeDefined();
    time++;
    await manager.pruneOrphans([], ['live']);
    expect(manager.repositorySessionFor(active.workspaceRef)).toBeUndefined();
  });
});
