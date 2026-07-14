import type { PreparedWorkspace, Workspaces } from './workspace-manager';

export class MemoryWorkspaceManager implements Workspaces {
  private readonly prepared = new Set<string>();
  private readonly cleanedUp = new Set<string>();
  private readonly initCommands = new Map<string, string[] | undefined>();
  private readonly scratchPrepared = new Set<string>();
  private readonly scratchCleanedUp = new Set<string>();
  private readonly files = new Map<string, Map<string, string>>(); // workspaceRef -> relPath -> content

  seedFile(workspaceRef: string, relativePath: string, content: string) {
    if (!this.files.has(workspaceRef)) this.files.set(workspaceRef, new Map());
    this.files.get(workspaceRef)!.set(relativePath, content);
  }

  async prepare(taskId: string, repo: string, initCommands?: string[], headBranch?: string): Promise<PreparedWorkspace> {
    const workspaceRef = `memory://${repo}/${taskId}`;
    this.prepared.add(workspaceRef);
    this.initCommands.set(workspaceRef, initCommands);
    const branch = headBranch || `agentops/${taskId}`;
    return { workspaceRef, branch, baseBranch: 'main' };
  }

  initCommandsFor(workspaceRef: string): string[] | undefined {
    return this.initCommands.get(workspaceRef);
  }

  async cleanup(workspaceRef: string, _repo: string): Promise<void> {
    if (!this.prepared.has(workspaceRef)) {
      throw new Error(`MemoryWorkspaceManager: cleanup called on a workspaceRef that was never prepared: "${workspaceRef}"`);
    }
    this.cleanedUp.add(workspaceRef);
  }

  isPrepared(workspaceRef: string): boolean {
    return this.prepared.has(workspaceRef);
  }

  isCleanedUp(workspaceRef: string): boolean {
    return this.cleanedUp.has(workspaceRef);
  }

  // No real filesystem in the in-memory manager -- nothing to prune.
  async pruneOrphans(_liveRepos: string[]): Promise<{ removed: string[] }> {
    return { removed: [] };
  }

  async prepareScratch(taskId: string): Promise<{ workspaceRef: string }> {
    const workspaceRef = `memory://scratch/${taskId}`;
    this.scratchPrepared.add(workspaceRef);
    return { workspaceRef };
  }

  async cleanupScratch(workspaceRef: string): Promise<void> {
    if (!this.scratchPrepared.has(workspaceRef)) {
      throw new Error(
        `MemoryWorkspaceManager: cleanupScratch called on a workspaceRef that was never prepared: "${workspaceRef}"`,
      );
    }
    this.scratchCleanedUp.add(workspaceRef);
  }

  isScratchPrepared(workspaceRef: string): boolean {
    return this.scratchPrepared.has(workspaceRef);
  }

  isScratchCleanedUp(workspaceRef: string): boolean {
    return this.scratchCleanedUp.has(workspaceRef);
  }

  async readFile(workspaceRef: string, relativePath: string): Promise<string | null> {
    return this.files.get(workspaceRef)?.get(relativePath) ?? null;
  }
}
