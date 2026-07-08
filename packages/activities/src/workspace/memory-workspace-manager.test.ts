import { describe, expect, it } from 'vitest';
import { MemoryWorkspaceManager } from './memory-workspace-manager';

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
    await expect(manager.cleanup('memory://never/prepared', 'owner/repo')).rejects.toThrow(/never prepared/);
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

    await expect(manager.cleanupScratch('memory://scratch/never-prepared')).rejects.toThrow(/never prepared/);
  });
});
