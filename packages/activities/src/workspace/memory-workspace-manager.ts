import type { PreparedWorkspace, Workspaces } from './workspace-manager';

export class MemoryWorkspaceManager implements Workspaces {
  private readonly prepared = new Set<string>();
  private readonly cleanedUp = new Set<string>();
  private readonly initCommands = new Map<string, string[] | undefined>();

  async prepare(taskId: string, repo: string, initCommands?: string[]): Promise<PreparedWorkspace> {
    const workspaceRef = `memory://${repo}/${taskId}`;
    this.prepared.add(workspaceRef);
    this.initCommands.set(workspaceRef, initCommands);
    return { workspaceRef, branch: `agentops/${taskId}`, baseBranch: 'main' };
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
}
