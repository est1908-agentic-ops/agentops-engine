import type { CreateRepositorySessionRequest, RepositorySession } from '@agentops/contracts';
import type { PreparedWorkspace, Workspaces } from './workspace-manager';

export interface MemoryWorkspaceManagerOptions {
  now?: () => number;
  repositorySessionIdleMs?: number;
}

interface MemoryRepositorySession {
  ownerProject: string;
  taskId: string;
  createdAt: number;
  lastUsedAt: number;
  repositories: RepositorySession['repositories'];
}

const REPOSITORY_SESSION_IDLE_MS = 86_400_000;

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9:_-]/g, '-');
}

export class MemoryWorkspaceManager implements Workspaces {
  private readonly prepared = new Set<string>();
  private readonly cleanedUp = new Set<string>();
  private readonly initCommands = new Map<string, string[] | undefined>();
  private readonly headRefs = new Map<string, string | undefined>();
  private readonly scratchPrepared = new Set<string>();
  private readonly scratchCleanedUp = new Set<string>();
  private readonly files = new Map<string, Map<string, string>>(); // workspaceRef -> relPath -> content
  private readonly repositorySessions = new Map<string, MemoryRepositorySession>();
  private readonly now: () => number;
  private readonly repositorySessionIdleMs: number;

  constructor(opts: MemoryWorkspaceManagerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.repositorySessionIdleMs = opts.repositorySessionIdleMs ?? REPOSITORY_SESSION_IDLE_MS;
  }

  seedFile(workspaceRef: string, relativePath: string, content: string) {
    if (!this.files.has(workspaceRef)) this.files.set(workspaceRef, new Map());
    this.files.get(workspaceRef)!.set(relativePath, content);
  }

  async prepare(
    taskId: string,
    repo: string,
    initCommands?: string[],
    headBranch?: string,
    headRef?: string,
  ): Promise<PreparedWorkspace> {
    const workspaceRef = `memory://${repo}/${taskId}`;
    this.prepared.add(workspaceRef);
    this.initCommands.set(workspaceRef, initCommands);
    this.headRefs.set(workspaceRef, headRef);
    const branch = headBranch || `agentops/${taskId}`;
    return { workspaceRef, branch, baseBranch: 'main' };
  }

  headRefFor(workspaceRef: string): string | undefined {
    return this.headRefs.get(workspaceRef);
  }

  initCommandsFor(workspaceRef: string): string[] | undefined {
    return this.initCommands.get(workspaceRef);
  }

  async cleanup(workspaceRef: string, _repo: string): Promise<void> {
    if (!this.prepared.has(workspaceRef)) {
      throw new Error(
        `MemoryWorkspaceManager: cleanup called on a workspaceRef that was never prepared: "${workspaceRef}"`,
      );
    }
    this.cleanedUp.add(workspaceRef);
  }

  isPrepared(workspaceRef: string): boolean {
    return this.prepared.has(workspaceRef);
  }

  isCleanedUp(workspaceRef: string): boolean {
    return this.cleanedUp.has(workspaceRef);
  }

  async prepareRepositorySession(
    ownerProject: string,
    req: CreateRepositorySessionRequest,
  ): Promise<RepositorySession> {
    const workspaceRef = `memory://repository-session/${sanitizeSegment(ownerProject)}/${sanitizeSegment(req.taskId)}`;
    const now = this.now();
    const repositories = req.repositories.map((input) => ({
      repo: input.repo,
      relativePath: `repositories/${input.repo}`,
      commit: '0'.repeat(40),
    }));
    this.repositorySessions.set(workspaceRef, {
      ownerProject,
      taskId: req.taskId,
      createdAt: now,
      lastUsedAt: now,
      repositories,
    });
    return { workspaceRef, repositories };
  }

  async cleanupRepositorySession(ownerProject: string, workspaceRef: string): Promise<void> {
    const session = this.repositorySessions.get(workspaceRef);
    if (!session) return;
    if (session.ownerProject !== ownerProject)
      throw new Error('repository session belongs to a different owner');
    this.repositorySessions.delete(workspaceRef);
  }

  async touchRepositorySession(ownerProject: string, workspaceRef: string): Promise<void> {
    const session = this.repositorySessions.get(workspaceRef);
    if (!session) return;
    if (session.ownerProject !== ownerProject)
      throw new Error('repository session belongs to a different owner');
    session.lastUsedAt = this.now();
  }

  repositorySessionFor(workspaceRef: string): Readonly<MemoryRepositorySession> | undefined {
    return this.repositorySessions.get(workspaceRef);
  }

  async pruneOrphans(
    _liveRepos: string[],
    liveProjects?: string[],
  ): Promise<{ removed: string[] }> {
    const live = new Set(liveProjects ?? []);
    const removed: string[] = [];
    for (const [workspaceRef, session] of this.repositorySessions) {
      if (
        (liveProjects !== undefined && !live.has(session.ownerProject)) ||
        this.now() - session.lastUsedAt > this.repositorySessionIdleMs
      ) {
        this.repositorySessions.delete(workspaceRef);
        removed.push(workspaceRef);
      }
    }
    return { removed };
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
