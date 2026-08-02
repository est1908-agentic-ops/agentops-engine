import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { GitCommandRunner } from '@agentops/ports';
import { slugifyProject } from '@agentops/policies';
import { isValidGitRefName } from '@agentops/contracts';
import {
  RepositorySessionSchema,
  type CreateRepositorySessionRequest,
  type RepositorySession,
} from '@agentops/contracts';
import { SpawnCommandRunner, type CommandRunner } from './spawn-command-runner';
import { WorkspaceError } from './workspace-error';
import {
  LocalRepositorySessionCoordinator,
  type RepositorySessionCoordinator,
} from './repository-session-coordinator';

export { WorkspaceError } from './workspace-error';

export interface WorkspaceManagerOptions {
  resolveGit: (repo: string) => GitCommandRunner;
  resolveGitForProject?: (project: string) => GitCommandRunner;
  cacheDir?: string;
  workspacesDir?: string;
  cloneUrl: (repo: string) => string;
  commandRunner?: CommandRunner;
  now?: () => number;
  repositorySessionIdleMs?: number;
  repositorySessionStagingIdleMs?: number;
  repositorySessionCoordinator?: RepositorySessionCoordinator;
  getAbortSignal?: () => AbortSignal | undefined;
}

export interface PreparedWorkspace {
  workspaceRef: string;
  branch: string;
  baseBranch: string;
}

export interface Workspaces {
  prepare(
    taskId: string,
    repo: string,
    initCommands?: string[],
    headBranch?: string,
    headRef?: string,
  ): Promise<PreparedWorkspace>;
  cleanup(workspaceRef: string, repo: string): Promise<void>;
  prepareScratch(taskId: string): Promise<{ workspaceRef: string }>;
  cleanupScratch(workspaceRef: string): Promise<void>;
  prepareRepositorySession(
    ownerProject: string,
    req: CreateRepositorySessionRequest,
  ): Promise<RepositorySession>;
  cleanupRepositorySession(ownerProject: string, workspaceRef: string): Promise<void>;
  touchRepositorySession(ownerProject: string, workspaceRef: string): Promise<void>;
  pruneOrphans(liveRepos: string[], liveProjects?: string[]): Promise<{ removed: string[] }>;
  readFile(workspaceRef: string, relativePath: string): Promise<string | null>;
}

interface RepositorySessionMetadata {
  ownerProject: string;
  taskId: string;
  createdAt: number;
  lastUsedAt: number;
  repositories: RepositorySession['repositories'];
  requestIdentity: string;
}

interface RepositorySessionStagingMetadata {
  ownerProject: string;
  taskId: string;
  requestIdentity: string;
  createdAt: number;
  workspaceRef: string;
}

const REPOSITORY_SESSION_IDLE_MS = 86_400_000;
const SESSION_METADATA_FILE = '.agentops-session.json';
const STAGING_METADATA_FILE = '.agentops-staging.json';

function sanitizeRepoSlug(repo: string): string {
  return repo.replace(/[^a-zA-Z0-9-]/g, '-');
}

// taskId is caller-supplied (a Tier-2 project workflow's own Temporal
// workflow ID) -- unlike sanitizeRepoSlug's input, it was never confined to
// filesystem-safe characters, so a crafted taskId (e.g. containing `../`)
// could otherwise resolve outside the intended scratch/ subtree.
function sanitizeTaskId(taskId: string): string {
  return taskId.replace(/[^a-zA-Z0-9:_-]/g, '-');
}

export function repositorySessionIdentity(value: string): string {
  const prefix =
    value
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'session';
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

export function isRepositorySessionIdentity(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,48}-[0-9a-f]{16}$/.test(value);
}

export function repositorySessionRequestIdentity(req: CreateRepositorySessionRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        taskId: req.taskId,
        repositories: req.repositories.map(({ repo, ref }) =>
          ref === undefined ? { repo } : { repo, ref },
        ),
      }),
    )
    .digest('hex');
}

export class WorkspaceManager implements Workspaces {
  private readonly resolveGit: (repo: string) => GitCommandRunner;
  private readonly cacheDir: string;
  private readonly workspacesDir: string;
  private readonly cloneUrl: (repo: string) => string;
  private readonly commandRunner: CommandRunner;
  private readonly resolveGitForProject?: (project: string) => GitCommandRunner;
  private readonly now: () => number;
  private readonly repositorySessionIdleMs: number;
  private readonly repositorySessionStagingIdleMs: number;
  private readonly repositorySessionCoordinator: RepositorySessionCoordinator;
  private readonly getAbortSignal?: () => AbortSignal | undefined;
  // These paths are engine-owned trusted roots.  We still lstat every mutable
  // component before destructive operations; Node has no portable openat/
  // O_NOFOLLOW API, so this is practical TOCTOU hardening rather than a claim
  // of cross-process race-proof filesystem access.

  constructor(opts: WorkspaceManagerOptions) {
    this.resolveGit = opts.resolveGit;
    this.cacheDir = opts.cacheDir ?? join(homedir(), '.agentops', 'cache');
    this.workspacesDir = opts.workspacesDir ?? join(homedir(), '.agentops', 'workspaces');
    this.cloneUrl = opts.cloneUrl;
    this.commandRunner = opts.commandRunner ?? new SpawnCommandRunner();
    this.resolveGitForProject = opts.resolveGitForProject;
    this.now = opts.now ?? Date.now;
    this.repositorySessionIdleMs = opts.repositorySessionIdleMs ?? REPOSITORY_SESSION_IDLE_MS;
    this.repositorySessionStagingIdleMs =
      opts.repositorySessionStagingIdleMs ?? REPOSITORY_SESSION_IDLE_MS;
    this.repositorySessionCoordinator =
      opts.repositorySessionCoordinator ?? new LocalRepositorySessionCoordinator();
    this.getAbortSignal = opts.getAbortSignal;
  }

  async prepare(
    taskId: string,
    repo: string,
    initCommands?: string[],
    headBranch?: string,
    headRef?: string,
  ): Promise<PreparedWorkspace> {
    if (headBranch !== undefined && !isValidGitRefName(headBranch)) {
      throw new WorkspaceError(`invalid headBranch: does not conform to git ref format`, true);
    }
    if (headRef !== undefined && !isValidGitRefName(headRef)) {
      throw new WorkspaceError(`invalid headRef: does not conform to git ref format`, true);
    }

    const git = this.resolveGit(repo);
    await mkdir(this.cacheDir, { recursive: true });
    await mkdir(this.workspacesDir, { recursive: true });
    const cachePath = join(this.cacheDir, sanitizeRepoSlug(repo));
    await this.ensureBaseClone(git, cachePath, repo);
    const baseBranch = await this.detectDefaultBranch(git, cachePath);
    const safeId = slugifyProject(taskId);
    const branch = headBranch ? headBranch : `agentops/${safeId}`;
    const workspacePath = join(this.workspacesDir, safeId);

    await this.reclaimStaleWorktree(git, cachePath, workspacePath, branch);

    let addResult;
    if (headRef) {
      const fetchResult = await git.run(['fetch', 'origin', headRef], { cwd: cachePath });
      if (fetchResult.exitCode !== 0) {
        throw new WorkspaceError(
          `git fetch origin ${headRef} failed for ${repo}: ${fetchResult.stderr}`,
          fetchResult.spawnFailed === true,
        );
      }
      addResult = await git.run(['worktree', 'add', workspacePath, '-B', branch, 'FETCH_HEAD'], {
        cwd: cachePath,
      });
    } else if (headBranch) {
      await git.run(['fetch', 'origin', branch], { cwd: cachePath });
      addResult = await git.run(
        ['worktree', 'add', workspacePath, '-B', branch, `origin/${branch}`],
        { cwd: cachePath },
      );
      if (addResult.exitCode !== 0) {
        addResult = await git.run(
          ['worktree', 'add', workspacePath, '-b', branch, `origin/${baseBranch}`],
          { cwd: cachePath },
        );
      }
    } else {
      addResult = await git.run(
        ['worktree', 'add', workspacePath, '-b', branch, `origin/${baseBranch}`],
        { cwd: cachePath },
      );
    }
    if (addResult.exitCode !== 0) {
      throw new WorkspaceError(
        `git worktree add failed for ${repo}: ${addResult.stderr}`,
        addResult.spawnFailed === true,
      );
    }

    for (const command of initCommands ?? []) {
      const result = await this.commandRunner.run(command, { cwd: workspacePath });
      if (result.exitCode !== 0) {
        throw new WorkspaceError(
          `init command "${command}" failed for ${repo}: ${result.stderr}`,
          result.spawnFailed === true,
        );
      }
    }

    return { workspaceRef: workspacePath, branch, baseBranch };
  }

  async readFile(workspaceRef: string, relativePath: string): Promise<string | null> {
    const full = resolve(workspaceRef, relativePath);
    const root = resolve(workspaceRef) + sep;
    if (!full.startsWith(root)) {
      return null; // attempted path escape
    }
    try {
      return await readFile(full, 'utf8');
    } catch (e: unknown) {
      if ((e as { code?: string }).code === 'ENOENT') return null;
      throw e;
    }
  }

  async prepareScratch(taskId: string): Promise<{ workspaceRef: string }> {
    const workspaceRef = join(this.workspacesDir, 'scratch', sanitizeTaskId(taskId));
    await mkdir(workspaceRef, { recursive: true });
    return { workspaceRef };
  }

  // workspaceRef is a directly Tier-2-callable activity argument (not
  // necessarily one this process itself returned from prepareScratch), so
  // this confines the delete to inside workspacesDir/scratch/ rather than
  // trusting the caller -- otherwise it's an unauthenticated, unconfined
  // recursive-delete primitive reachable by any project workflow.
  async cleanupScratch(workspaceRef: string): Promise<void> {
    const scratchRoot = resolve(this.workspacesDir, 'scratch') + sep;
    const target = resolve(workspaceRef) + sep;
    // Must be a genuine subdirectory of scratchRoot, not scratchRoot itself
    // (which would wipe every project's scratch workspaces in one call).
    if (!target.startsWith(scratchRoot) || target === scratchRoot) {
      throw new WorkspaceError(
        `cleanupScratch: refusing to remove path outside scratch root: ${workspaceRef}`,
        true,
      );
    }
    await rm(resolve(workspaceRef), { recursive: true, force: true });
  }

  async cleanup(workspaceRef: string, repo: string): Promise<void> {
    // Run the removal from the base clone, not from inside workspaceRef itself — a
    // worktree removing its own cwd out from under the running process is fragile and
    // git-version-dependent. The base clone is the stable, always-present "main" worktree.
    const git = this.resolveGit(repo);
    const cachePath = join(this.cacheDir, sanitizeRepoSlug(repo));
    const result = await git.run(['worktree', 'remove', workspaceRef, '--force'], {
      cwd: cachePath,
    });
    if (result.exitCode !== 0) {
      throw new WorkspaceError(
        `git worktree remove failed for ${workspaceRef}: ${result.stderr}`,
        result.spawnFailed === true,
      );
    }
  }

  async prepareRepositorySession(
    ownerProject: string,
    req: CreateRepositorySessionRequest,
  ): Promise<RepositorySession> {
    const workspaceRef = this.repositorySessionPath(ownerProject, req.taskId);
    this.assertSessionPath(workspaceRef);
    return this.withSessionLock(workspaceRef, async (signal) => {
      this.throwIfSessionCancelled(signal);
      await this.assertSessionCreationPath(workspaceRef);
      const existing = existsSync(workspaceRef)
        ? this.readMatchingRepositorySession(workspaceRef, ownerProject, req)
        : undefined;
      if (existing) return await existing;
      if (!this.resolveGitForProject) {
        throw new WorkspaceError('repository sessions require a project Git runner resolver', true);
      }
      let git: GitCommandRunner;
      try {
        git = this.resolveGitForProject(ownerProject);
      } catch (error) {
        if (error instanceof WorkspaceError) throw error;
        throw new WorkspaceError('repository session owner project is not registered', true);
      }
      const requestIdentity = repositorySessionRequestIdentity(req);
      const repositories: RepositorySession['repositories'] = [];
      let stagingPath: string | undefined;
      try {
        this.throwIfSessionCancelled(signal);
        stagingPath = await this.createSessionStagingPath(workspaceRef);
        this.throwIfSessionCancelled(signal);
        await this.writeStagingMetadata(stagingPath, {
          ownerProject,
          taskId: req.taskId,
          requestIdentity,
          createdAt: this.now(),
          workspaceRef,
        });
        for (const input of req.repositories) {
          this.throwIfSessionCancelled(signal);
          const target = join(stagingPath, 'repositories', input.repo);
          this.assertPathInside(stagingPath, target);
          await mkdir(join(target, '..'), { recursive: true });
          const clone = await git.run(['clone', this.cloneUrl(input.repo), target], {
            cwd: stagingPath,
          });
          this.throwIfSessionCancelled(signal);
          this.assertGitSuccess(clone, `git clone failed for ${input.repo}`);
          if (input.ref) {
            const fetch = await git.run(['fetch', 'origin', input.ref], { cwd: target });
            this.throwIfSessionCancelled(signal);
            this.assertGitSuccess(fetch, `git fetch origin ${input.ref} failed for ${input.repo}`);
            const checkout = await git.run(['checkout', '--detach', 'FETCH_HEAD'], { cwd: target });
            this.throwIfSessionCancelled(signal);
            this.assertGitSuccess(checkout, `git checkout failed for ${input.repo}`);
          }
          const head = await git.run(['rev-parse', 'HEAD'], { cwd: target });
          this.throwIfSessionCancelled(signal);
          this.assertGitSuccess(head, `git rev-parse HEAD failed for ${input.repo}`);
          const commit = head.stdout.trim();
          if (!/^[0-9a-f]{40}$/.test(commit)) {
            throw new WorkspaceError(
              `git rev-parse HEAD returned an invalid commit for ${input.repo}`,
              true,
            );
          }
          repositories.push({
            repo: input.repo,
            relativePath: `repositories/${input.repo}`,
            commit,
          });
        }
        const now = this.now();
        this.throwIfSessionCancelled(signal);
        await this.writeSessionMetadata(stagingPath, {
          ownerProject,
          taskId: req.taskId,
          createdAt: now,
          lastUsedAt: now,
          repositories,
          requestIdentity,
        });
        await this.readSessionMetadata(stagingPath, true, workspaceRef);
        await this.assertSessionCreationPath(workspaceRef);
        if (existsSync(workspaceRef))
          return this.readMatchingRepositorySession(workspaceRef, ownerProject, req);
        this.throwIfSessionCancelled(signal);
        await rename(stagingPath, workspaceRef);
        stagingPath = undefined;
        return { workspaceRef, repositories };
      } catch (error) {
        if (stagingPath) await this.removeOwnedStagingPath(stagingPath).catch(() => {});
        throw error;
      }
    });
  }

  async cleanupRepositorySession(ownerProject: string, workspaceRef: string): Promise<void> {
    this.assertSessionPath(workspaceRef);
    this.assertSessionOwnerPath(ownerProject, workspaceRef);
    await this.withSessionLock(workspaceRef, async (signal) => {
      if (!existsSync(workspaceRef)) return;
      await this.assertExistingSessionDirectory(workspaceRef);
      const metadata = await this.readSessionMetadata(workspaceRef, true);
      if (metadata.ownerProject !== ownerProject) {
        throw new WorkspaceError('repository session belongs to a different project', true);
      }
      this.throwIfSessionCancelled(signal);
      await this.removeSessionDirectory(workspaceRef);
    });
  }

  async touchRepositorySession(ownerProject: string, workspaceRef: string): Promise<void> {
    if (!this.isUnderSessionRoot(workspaceRef)) return; // compatibility for ordinary workspaces
    this.assertSessionPath(workspaceRef);
    await this.withSessionLock(workspaceRef, async (signal) => {
      if (!existsSync(workspaceRef)) return;
      await this.assertExistingSessionDirectory(workspaceRef);
      const metadata = await this.readSessionMetadata(workspaceRef, true);
      if (metadata.ownerProject !== ownerProject) {
        throw new WorkspaceError('repository session belongs to a different project', true);
      }
      await this.assertExistingSessionDirectory(workspaceRef);
      this.throwIfSessionCancelled(signal);
      await this.writeSessionMetadata(workspaceRef, { ...metadata, lastUsedAt: this.now() });
    });
  }

  // Remove on-disk artifacts for repos no longer in the managed registry: their
  // base clone under cacheDir and any worktrees under workspacesDir that point at
  // it. A removed project (e.g. one de-registered from the console) otherwise
  // leaves its full source readable on the shared PVCs indefinitely -- nothing
  // ever reconciles it away, since prepare/cleanup only run for repos that still
  // exist. Safe by construction: only base clones/worktrees NOT belonging to a
  // live repo are touched (a live project's in-flight run is never disturbed),
  // and clones are disposable (ARCHITECTURE.md §1) -- a repo mis-flagged here
  // simply re-clones on its next prepare. Best-effort per entry so one failure
  // doesn't abort the sweep.
  async pruneOrphans(liveRepos: string[], liveProjects?: string[]): Promise<{ removed: string[] }> {
    const liveSlugs = new Set(liveRepos.map(sanitizeRepoSlug));
    const removed: string[] = [];

    // Worktrees first, so a removed project's checked-out source goes too (not
    // just the base clone it links back to).
    const tasks = await readdir(this.workspacesDir).catch(() => [] as string[]);
    for (const name of tasks) {
      // `scratch` holds platform/chat scratch dirs (not repo worktrees); the
      // pnpm store isn't a worktree either.
      if (name === 'scratch' || name === '.pnpm-store' || name === 'repository-sessions') {
        continue;
      }
      const slug = await this.worktreeCloneSlug(join(this.workspacesDir, name));
      if (slug === undefined || liveSlugs.has(slug)) {
        continue; // not a resolvable worktree, or owned by a live repo -> leave it
      }
      await rm(join(this.workspacesDir, name), { recursive: true, force: true }).catch(() => {});
      removed.push(`tasks/${name}`);
    }

    const sessionsRoot = join(this.workspacesDir, 'repository-sessions');
    const live = new Set(liveProjects ?? []);
    for (const owner of await readdir(sessionsRoot).catch(() => [] as string[])) {
      if (owner === '.locks') continue;
      for (const task of await readdir(join(sessionsRoot, owner)).catch(() => [] as string[])) {
        const workspaceRef = join(sessionsRoot, owner, task);
        if (!this.isSessionPath(workspaceRef)) continue;
        try {
          const deleted = await this.withSessionLock(workspaceRef, async (signal) => {
            await this.assertExistingSessionDirectory(workspaceRef);
            const metadata = await this.readSessionMetadata(workspaceRef, true);
            if (
              (liveProjects !== undefined && !live.has(metadata.ownerProject)) ||
              this.now() - metadata.lastUsedAt > this.repositorySessionIdleMs
            ) {
              // This is deliberately the metadata read used for the decision:
              // another worker can only touch before or after the kernel lock.
              this.throwIfSessionCancelled(signal);
              await this.removeSessionDirectory(workspaceRef);
              return true;
            }
            return false;
          });
          if (deleted) removed.push(workspaceRef);
        } catch {
          // Invalid metadata is not trusted as authority to delete a path.
        }
      }
    }
    await this.pruneSessionStaging(sessionsRoot, live, liveProjects !== undefined, removed);

    // Base clones: <cacheDir>/<sanitizeRepoSlug(repo)>.
    const cached = await readdir(this.cacheDir).catch(() => [] as string[]);
    for (const name of cached) {
      if (liveSlugs.has(name)) {
        continue;
      }
      await rm(join(this.cacheDir, name), { recursive: true, force: true }).catch(() => {});
      removed.push(`cache/${name}`);
    }

    return { removed };
  }

  // The base-clone slug a worktree belongs to, parsed from its `.git` gitdir
  // pointer (`gitdir: <cacheDir>/<slug>/.git/worktrees/<name>`). undefined if the
  // entry isn't a worktree with a pointer under this cacheDir (e.g. a stray dir,
  // or a `git init` repo whose `.git` is a directory) -> caller leaves it alone.
  private async worktreeCloneSlug(worktreePath: string): Promise<string | undefined> {
    const dotGit = join(worktreePath, '.git');
    try {
      if (!(await stat(dotGit)).isFile()) {
        return undefined;
      }
      const content = await readFile(dotGit, 'utf8');
      const match = content.match(/gitdir:\s*(.+)/);
      if (!match) {
        return undefined;
      }
      const gitdir = match[1].trim();
      // Extract the repo slug (the dir directly under cache) by structure rather than
      // fragile string prefix match. This is robust to macOS /var -> /private/var
      // symlink canonicalization differences between Node's mkdtemp and what git records.
      const m = gitdir.match(/\/([^/]+)\/\.git\/worktrees\//);
      return m ? m[1] : undefined;
    } catch {
      return undefined;
    }
  }

  // A previous run of the same taskId that never reached cleanup() (crashed, or was
  // canceled before the workflow's own try/catch) can leave its worktree directory
  // and/or branch behind. `git worktree add -b` isn't transactional with its own
  // path-exists check -- it creates the branch before checking the path, so a stale
  // leftover fails attempt 1 with "path already exists" and then poisons every
  // subsequent attempt with a *different* fatal error ("branch already exists"),
  // never self-recovering. Reclaim both before creating a fresh worktree; there's
  // nothing durable to lose here (see ARCHITECTURE.md §1: worktrees are disposable,
  // only pushed commits count).
  private async reclaimStaleWorktree(
    git: GitCommandRunner,
    cachePath: string,
    workspacePath: string,
    branch: string,
  ): Promise<void> {
    if (existsSync(workspacePath)) {
      const removeResult = await git.run(['worktree', 'remove', workspacePath, '--force'], {
        cwd: cachePath,
      });
      if (removeResult.exitCode !== 0) {
        await rm(workspacePath, { recursive: true, force: true });
        await git.run(['worktree', 'prune'], { cwd: cachePath });
      }
    }
    // Only force-delete synthetic agentops/* branches (or when no headBranch i.e. normal devCycle flow).
    // For PR repair (headBranch provided) we must not delete a user feature branch ref that happens to exist in the shared cache.
    if (!branch || branch.startsWith('agentops/')) {
      await git.run(['branch', '-D', branch], { cwd: cachePath });
    }
  }

  private async ensureBaseClone(
    git: GitCommandRunner,
    cachePath: string,
    repo: string,
  ): Promise<void> {
    // Check with a plain fs call, not a git invocation with `cwd: cachePath` — spawning
    // git with a cwd that doesn't exist yet (the "not cloned yet" case, which is exactly
    // what we're distinguishing here) fails at the OS level, not as a normal git error.
    if (existsSync(cachePath)) {
      const fetchResult = await git.run(['fetch', 'origin'], { cwd: cachePath });
      if (fetchResult.exitCode !== 0) {
        throw new WorkspaceError(
          `git fetch failed for ${repo}: ${fetchResult.stderr}`,
          fetchResult.spawnFailed === true,
        );
      }
      return;
    }
    const cloneResult = await git.run(['clone', this.cloneUrl(repo), cachePath], {
      cwd: this.cacheDir,
    });
    if (cloneResult.exitCode !== 0) {
      throw new WorkspaceError(
        `git clone failed for ${repo}: ${cloneResult.stderr}`,
        cloneResult.spawnFailed === true,
      );
    }
  }

  private repositorySessionPath(ownerProject: string, taskId: string): string {
    return join(
      this.workspacesDir,
      'repository-sessions',
      repositorySessionIdentity(ownerProject),
      repositorySessionIdentity(taskId),
    );
  }

  private isSessionPath(workspaceRef: string): boolean {
    const root = resolve(this.workspacesDir, 'repository-sessions');
    const target = resolve(workspaceRef);
    const relative = target.slice(root.length + 1).split(sep);
    return (
      this.isUnderSessionRoot(workspaceRef) &&
      relative.length === 2 &&
      relative.every(isRepositorySessionIdentity)
    );
  }

  private isUnderSessionRoot(workspaceRef: string): boolean {
    const root = resolve(this.workspacesDir, 'repository-sessions');
    return resolve(workspaceRef).startsWith(root + sep);
  }

  private assertSessionPath(workspaceRef: string): void {
    if (!this.isSessionPath(workspaceRef)) {
      throw new WorkspaceError(
        `repository session path is outside the configured session root: ${workspaceRef}`,
        true,
      );
    }
  }

  private assertSessionOwnerPath(ownerProject: string, workspaceRef: string): void {
    const expectedOwner = repositorySessionIdentity(ownerProject);
    if (resolve(workspaceRef).split(sep).at(-2) !== expectedOwner) {
      throw new WorkspaceError('repository session path belongs to a different project', true);
    }
  }

  private async assertExistingSessionDirectory(workspaceRef: string): Promise<void> {
    this.assertSessionPath(workspaceRef);
    const root = join(this.workspacesDir, 'repository-sessions');
    const owner = resolve(workspaceRef).split(sep).at(-2)!;
    for (const path of [root, join(root, owner), workspaceRef]) {
      const entry = await lstat(path);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new WorkspaceError(
          `repository session path is not a real directory: ${workspaceRef}`,
          true,
        );
      }
    }
  }

  private async assertSessionCreationPath(workspaceRef: string): Promise<void> {
    const root = join(this.workspacesDir, 'repository-sessions');
    const owner = resolve(workspaceRef).split(sep).at(-2)!;
    for (const path of [root, join(root, owner), workspaceRef]) {
      try {
        const entry = await lstat(path);
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          throw new WorkspaceError(
            `repository session path contains a symlink: ${workspaceRef}`,
            true,
          );
        }
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') continue;
        throw error;
      }
    }
  }

  private async createSessionStagingPath(workspaceRef: string): Promise<string> {
    this.assertSessionPath(workspaceRef);
    await this.assertSessionCreationPath(workspaceRef);
    const ownerPath = join(
      this.workspacesDir,
      'repository-sessions',
      resolve(workspaceRef).split(sep).at(-2)!,
    );
    const sessionsRoot = join(this.workspacesDir, 'repository-sessions');
    const stagingRoot = join(ownerPath, '.staging');
    await mkdir(sessionsRoot, { recursive: true, mode: 0o700 });
    await mkdir(ownerPath, { recursive: true, mode: 0o700 });
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    const stagingEntry = await lstat(stagingRoot);
    if (stagingEntry.isSymbolicLink() || !stagingEntry.isDirectory()) {
      throw new WorkspaceError('repository session staging root is not a real directory', true);
    }
    const stagingPath = await mkdtemp(join(stagingRoot, 'session-'));
    this.assertPathInside(stagingRoot, stagingPath);
    return stagingPath;
  }

  private async writeStagingMetadata(
    stagingPath: string,
    metadata: RepositorySessionStagingMetadata,
  ): Promise<void> {
    await this.writeRegularJson(join(stagingPath, STAGING_METADATA_FILE), metadata);
  }

  private async readStagingMetadata(
    stagingPath: string,
  ): Promise<RepositorySessionStagingMetadata> {
    const metadata = await this.readRegularJson<RepositorySessionStagingMetadata>(
      join(stagingPath, STAGING_METADATA_FILE),
    );
    if (
      !metadata ||
      typeof metadata.ownerProject !== 'string' ||
      typeof metadata.taskId !== 'string' ||
      !/^[0-9a-f]{64}$/.test(metadata.requestIdentity) ||
      !Number.isFinite(metadata.createdAt) ||
      typeof metadata.workspaceRef !== 'string' ||
      this.repositorySessionPath(metadata.ownerProject, metadata.taskId) !==
        resolve(metadata.workspaceRef)
    )
      throw new WorkspaceError('repository session staging marker is invalid', true);
    return metadata;
  }

  private async removeOwnedStagingPath(stagingPath: string): Promise<void> {
    const stagingRoot = resolve(stagingPath).split(sep).slice(0, -1).join(sep);
    const ownerPath = resolve(stagingRoot).split(sep).slice(0, -1).join(sep);
    const sessionsRoot = resolve(this.workspacesDir, 'repository-sessions');
    this.assertPathInside(stagingRoot, stagingPath);
    if (
      stagingRoot !== join(ownerPath, '.staging') ||
      !resolve(stagingPath).split(sep).at(-1)!.startsWith('session-')
    ) {
      throw new WorkspaceError('repository session staging path is invalid', true);
    }
    await this.assertTrustedStagingPath(sessionsRoot, ownerPath, stagingRoot, stagingPath);
    const moved = join(ownerPath, `.agentops-removed-${randomUUID()}`);
    await rename(stagingPath, moved);
    const movedEntry = await lstat(moved);
    if (movedEntry.isSymbolicLink() || !movedEntry.isDirectory())
      throw new WorkspaceError(
        'repository session staging quarantine is not a real directory',
        true,
      );
    await rm(moved, { recursive: true, force: true });
  }

  private async assertTrustedStagingPath(
    sessionsRoot: string,
    ownerPath: string,
    stagingRoot: string,
    stagingPath?: string,
  ): Promise<void> {
    const trustedRoot = await realpath(sessionsRoot);
    for (const candidate of [
      sessionsRoot,
      ownerPath,
      stagingRoot,
      ...(stagingPath ? [stagingPath] : []),
    ]) {
      const entry = await lstat(candidate);
      if (entry.isSymbolicLink() || !entry.isDirectory())
        throw new WorkspaceError('repository session staging path is not a real directory', true);
      const canonical = await realpath(candidate);
      if (canonical !== trustedRoot && !canonical.startsWith(trustedRoot + sep))
        throw new WorkspaceError('repository session staging path escapes the trusted root', true);
    }
  }

  private async removeSessionDirectory(workspaceRef: string): Promise<void> {
    await this.assertExistingSessionDirectory(workspaceRef);
    const ownerPath = resolve(workspaceRef).split(sep).slice(0, -1).join(sep);
    // Final sessions never use .staging as a trash location: that directory is
    // intentionally writable during clone creation and must not become a path
    // traversal boundary for a destructive operation.
    const owner = await lstat(ownerPath);
    if (owner.isSymbolicLink() || !owner.isDirectory())
      throw new WorkspaceError('repository session owner is not a real directory', true);
    const moved = join(ownerPath, `.agentops-removed-${randomUUID()}`);
    await rename(workspaceRef, moved);
    await rm(moved, { recursive: true, force: true });
  }

  private async pruneSessionStaging(
    sessionsRoot: string,
    live: Set<string>,
    hasLiveProjects: boolean,
    removed: string[],
  ): Promise<void> {
    for (const owner of await readdir(sessionsRoot).catch(() => [] as string[])) {
      if (!isRepositorySessionIdentity(owner)) continue;
      const ownerPath = join(sessionsRoot, owner);
      const stagingRoot = join(ownerPath, '.staging');
      try {
        await this.assertTrustedStagingPath(resolve(sessionsRoot), ownerPath, stagingRoot);
      } catch {
        continue;
      }
      for (const entry of await readdir(stagingRoot).catch(() => [] as string[])) {
        if (!entry.startsWith('session-')) continue;
        const stagingPath = join(stagingRoot, entry);
        try {
          const directory = await lstat(stagingPath);
          if (directory.isSymbolicLink() || !directory.isDirectory()) continue;
          let metadata: RepositorySessionStagingMetadata;
          try {
            metadata = await this.readStagingMetadata(stagingPath);
          } catch {
            if (
              /^session-[A-Za-z0-9]{6}$/.test(entry) &&
              this.now() - directory.mtimeMs > this.repositorySessionStagingIdleMs &&
              (await readdir(stagingPath)).length === 0
            ) {
              await this.assertTrustedStagingPath(
                resolve(sessionsRoot),
                ownerPath,
                stagingRoot,
                stagingPath,
              );
              await rmdir(stagingPath).catch(() => {});
              if (!existsSync(stagingPath)) removed.push(stagingPath);
            }
            continue;
          }
          try {
            await this.withSessionLock(metadata.workspaceRef, async (signal) => {
              const fresh = await this.readStagingMetadata(stagingPath);
              if (
                (hasLiveProjects && !live.has(fresh.ownerProject)) ||
                this.now() - fresh.createdAt > this.repositorySessionStagingIdleMs
              ) {
                this.throwIfSessionCancelled(signal);
                await this.removeOwnedStagingPath(stagingPath);
                removed.push(stagingPath);
              }
            });
          } catch {
            // A concurrent creator owns the staging directory, or it stopped
            // being a trusted path before the coordinator admitted us.
          }
        } catch {
          // A malformed or symlinked marker is evidence, never delete authority.
        }
      }
    }
  }

  private async readMatchingRepositorySession(
    workspaceRef: string,
    ownerProject: string,
    req: CreateRepositorySessionRequest,
  ): Promise<RepositorySession> {
    await this.assertExistingSessionDirectory(workspaceRef);
    const metadata = await this.readSessionMetadata(workspaceRef, true);
    if (
      metadata.ownerProject !== ownerProject ||
      metadata.taskId !== req.taskId ||
      metadata.requestIdentity !== repositorySessionRequestIdentity(req)
    ) {
      throw new WorkspaceError('repository session request does not match existing session', true);
    }
    return { workspaceRef, repositories: metadata.repositories };
  }

  private assertPathInside(root: string, target: string): void {
    if (!resolve(target).startsWith(resolve(root) + sep)) {
      throw new WorkspaceError(`path escapes repository session root: ${target}`, true);
    }
  }

  private assertGitSuccess(
    result: { exitCode: number; stderr: string; spawnFailed?: boolean },
    message: string,
  ): void {
    if (result.exitCode !== 0)
      throw new WorkspaceError(`${message}: ${result.stderr}`, result.spawnFailed === true);
  }

  private async readSessionMetadata(
    workspaceRef: string,
    required: boolean,
    expectedWorkspaceRef: string = workspaceRef,
  ): Promise<RepositorySessionMetadata> {
    try {
      const metadataPath = join(workspaceRef, SESSION_METADATA_FILE);
      const metadataFile = await lstat(metadataPath);
      if (metadataFile.isSymbolicLink() || !metadataFile.isFile())
        throw new Error('metadata is not a regular file');
      const metadata = JSON.parse(
        await readFile(metadataPath, 'utf8'),
      ) as RepositorySessionMetadata;
      if (
        !metadata ||
        typeof metadata.ownerProject !== 'string' ||
        metadata.ownerProject.length === 0 ||
        typeof metadata.taskId !== 'string' ||
        metadata.taskId.length === 0 ||
        !Number.isFinite(metadata.createdAt) ||
        !Number.isFinite(metadata.lastUsedAt) ||
        !/^[0-9a-f]{64}$/.test(metadata.requestIdentity) ||
        !RepositorySessionSchema.safeParse({
          workspaceRef: expectedWorkspaceRef,
          repositories: metadata.repositories,
        }).success
      )
        throw new Error('invalid metadata');
      if (
        this.repositorySessionPath(metadata.ownerProject, metadata.taskId) !==
        resolve(expectedWorkspaceRef)
      ) {
        throw new Error('metadata does not match session path');
      }
      return metadata;
    } catch (error) {
      if (!required && (error as { code?: string }).code === 'ENOENT') throw error;
      throw new WorkspaceError(`repository session metadata is invalid for ${workspaceRef}`, true);
    }
  }

  private async writeSessionMetadata(
    workspaceRef: string,
    metadata: RepositorySessionMetadata,
  ): Promise<void> {
    const temporary = join(workspaceRef, `.${SESSION_METADATA_FILE}.${randomUUID()}.tmp`);
    let created = false;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, 'wx', 0o600);
      created = true;
      await handle.writeFile(JSON.stringify(metadata), 'utf8');
      await handle.close();
      handle = undefined;
      await rename(temporary, join(workspaceRef, SESSION_METADATA_FILE));
      created = false;
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (created) await rm(temporary, { force: true }).catch(() => {});
    }
  }

  private async withSessionLock<T>(
    workspaceRef: string,
    operation: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    // Validate mutable session-root components before creating anything in the
    // parallel lock namespace. The coordinator owns the stable lock inode and
    // deliberately never removes it.
    await this.assertSessionCreationPath(workspaceRef);
    await this.assertLockCreationPath(workspaceRef);
    return this.repositorySessionCoordinator.withLock(this.lockPath(workspaceRef), operation, {
      signal: this.getAbortSignal?.(),
    });
  }

  private throwIfSessionCancelled(signal?: AbortSignal): void {
    signal?.throwIfAborted();
  }

  private lockPath(workspaceRef: string): string {
    this.assertSessionPath(workspaceRef);
    const [owner, task] = resolve(workspaceRef).split(sep).slice(-2);
    // Lock files are intentionally permanent, tiny safety metadata. Reusing
    // their inode prevents a former holder from ever releasing a successor.
    return join(this.workspacesDir, 'repository-sessions', '.locks', owner!, `${task!}.lock`);
  }

  private async assertLockCreationPath(workspaceRef: string): Promise<void> {
    const lockRoot = join(this.workspacesDir, 'repository-sessions', '.locks');
    const owner = resolve(workspaceRef).split(sep).at(-2)!;
    const ownerLocksPath = join(lockRoot, owner);
    for (const path of [lockRoot, ownerLocksPath]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const entry = await lstat(path);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new WorkspaceError('repository session lock path is not a real directory', true);
      }
    }
  }

  private async writeRegularJson(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value), 'utf8');
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  }

  private async readRegularJson<T>(path: string): Promise<T> {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile())
      throw new WorkspaceError('unsafe regular file', true);
    return JSON.parse(await readFile(path, 'utf8')) as T;
  }

  private async detectDefaultBranch(git: GitCommandRunner, cachePath: string): Promise<string> {
    const result = await git.run(['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: cachePath });
    if (result.exitCode !== 0) {
      throw new WorkspaceError(
        `could not detect default branch in ${cachePath}: ${result.stderr}`,
        result.spawnFailed === true,
      );
    }
    const ref = result.stdout.trim();
    const branch = ref.split('/').pop();
    if (!branch) {
      throw new WorkspaceError(`unexpected symbolic-ref output: "${ref}"`);
    }
    return branch;
  }
}
