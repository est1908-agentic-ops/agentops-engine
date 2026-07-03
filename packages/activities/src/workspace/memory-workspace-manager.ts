import type { PreparedWorkspace, Workspaces } from './workspace-manager';

export class MemoryWorkspaceManager implements Workspaces {
  private readonly prepared = new Set<string>();
  private readonly cleanedUp = new Set<string>();

  async prepare(taskId: string, repo: string): Promise<PreparedWorkspace> {
    const workspaceRef = `memory://${repo}/${taskId}`;
    this.prepared.add(workspaceRef);
    return { workspaceRef, branch: `agentops/${taskId}`, baseBranch: 'main' };
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
