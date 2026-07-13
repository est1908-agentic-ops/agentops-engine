import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { GitCommandRunner } from '@agentops/ports';
import { SpawnCommandRunner, type CommandRunner } from './spawn-command-runner';

export interface WorkspaceManagerOptions {
  resolveGit: (repo: string) => GitCommandRunner;
  cacheDir?: string;
  workspacesDir?: string;
  cloneUrl: (repo: string) => string;
  commandRunner?: CommandRunner;
}

export interface PreparedWorkspace {
  workspaceRef: string;
  branch: string;
  baseBranch: string;
}

export interface Workspaces {
  prepare(taskId: string, repo: string, initCommands?: string[]): Promise<PreparedWorkspace>;
  cleanup(workspaceRef: string, repo: string): Promise<void>;
  prepareScratch(taskId: string): Promise<{ workspaceRef: string }>;
  cleanupScratch(workspaceRef: string): Promise<void>;
  pruneOrphans(liveRepos: string[]): Promise<{ removed: string[] }>;
}

export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly nonRetryable: boolean = false,
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

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

export class WorkspaceManager implements Workspaces {
  private readonly resolveGit: (repo: string) => GitCommandRunner;
  private readonly cacheDir: string;
  private readonly workspacesDir: string;
  private readonly cloneUrl: (repo: string) => string;
  private readonly commandRunner: CommandRunner;

  constructor(opts: WorkspaceManagerOptions) {
    this.resolveGit = opts.resolveGit;
    this.cacheDir = opts.cacheDir ?? join(homedir(), '.agentops', 'cache');
    this.workspacesDir = opts.workspacesDir ?? join(homedir(), '.agentops', 'workspaces');
    this.cloneUrl = opts.cloneUrl;
    this.commandRunner = opts.commandRunner ?? new SpawnCommandRunner();
  }

  async prepare(taskId: string, repo: string, initCommands?: string[]): Promise<PreparedWorkspace> {
    const git = this.resolveGit(repo);
    await mkdir(this.cacheDir, { recursive: true });
    await mkdir(this.workspacesDir, { recursive: true });
    const cachePath = join(this.cacheDir, sanitizeRepoSlug(repo));
    await this.ensureBaseClone(git, cachePath, repo);
    const baseBranch = await this.detectDefaultBranch(git, cachePath);
    const branch = `agentops/${taskId}`;
    const workspacePath = join(this.workspacesDir, taskId);

    await this.reclaimStaleWorktree(git, cachePath, workspacePath, branch);

    const addResult = await git.run(
      ['worktree', 'add', workspacePath, '-b', branch, `origin/${baseBranch}`],
      { cwd: cachePath },
    );
    if (addResult.exitCode !== 0) {
      throw new WorkspaceError(`git worktree add failed for ${repo}: ${addResult.stderr}`, addResult.spawnFailed === true);
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
      throw new WorkspaceError(`cleanupScratch: refusing to remove path outside scratch root: ${workspaceRef}`, true);
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
      throw new WorkspaceError(`git worktree remove failed for ${workspaceRef}: ${result.stderr}`, result.spawnFailed === true);
    }
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
  async pruneOrphans(liveRepos: string[]): Promise<{ removed: string[] }> {
    const liveSlugs = new Set(liveRepos.map(sanitizeRepoSlug));
    const removed: string[] = [];

    // Worktrees first, so a removed project's checked-out source goes too (not
    // just the base clone it links back to).
    const tasks = await readdir(this.workspacesDir).catch(() => [] as string[]);
    for (const name of tasks) {
      // `scratch` holds platform/chat scratch dirs (not repo worktrees); the
      // pnpm store isn't a worktree either.
      if (name === 'scratch' || name === '.pnpm-store') {
        continue;
      }
      const slug = await this.worktreeCloneSlug(join(this.workspacesDir, name));
      if (slug === undefined || liveSlugs.has(slug)) {
        continue; // not a resolvable worktree, or owned by a live repo -> leave it
      }
      await rm(join(this.workspacesDir, name), { recursive: true, force: true }).catch(() => {});
      removed.push(`tasks/${name}`);
    }

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
      const prefix = this.cacheDir.endsWith('/') ? this.cacheDir : `${this.cacheDir}/`;
      const gitdir = match[1].trim();
      return gitdir.startsWith(prefix) ? gitdir.slice(prefix.length).split('/')[0] || undefined : undefined;
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
      const removeResult = await git.run(['worktree', 'remove', workspacePath, '--force'], { cwd: cachePath });
      if (removeResult.exitCode !== 0) {
        await rm(workspacePath, { recursive: true, force: true });
        await git.run(['worktree', 'prune'], { cwd: cachePath });
      }
    }
    await git.run(['branch', '-D', branch], { cwd: cachePath });
  }

  private async ensureBaseClone(git: GitCommandRunner, cachePath: string, repo: string): Promise<void> {
    // Check with a plain fs call, not a git invocation with `cwd: cachePath` — spawning
    // git with a cwd that doesn't exist yet (the "not cloned yet" case, which is exactly
    // what we're distinguishing here) fails at the OS level, not as a normal git error.
    if (existsSync(cachePath)) {
      const fetchResult = await git.run(['fetch', 'origin'], { cwd: cachePath });
      if (fetchResult.exitCode !== 0) {
        throw new WorkspaceError(`git fetch failed for ${repo}: ${fetchResult.stderr}`, fetchResult.spawnFailed === true);
      }
      return;
    }
    const cloneResult = await git.run(['clone', this.cloneUrl(repo), cachePath], { cwd: this.cacheDir });
    if (cloneResult.exitCode !== 0) {
      throw new WorkspaceError(`git clone failed for ${repo}: ${cloneResult.stderr}`, cloneResult.spawnFailed === true);
    }
  }

  private async detectDefaultBranch(git: GitCommandRunner, cachePath: string): Promise<string> {
    const result = await git.run(['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: cachePath });
    if (result.exitCode !== 0) {
      throw new WorkspaceError(`could not detect default branch in ${cachePath}: ${result.stderr}`, result.spawnFailed === true);
    }
    const ref = result.stdout.trim();
    const branch = ref.split('/').pop();
    if (!branch) {
      throw new WorkspaceError(`unexpected symbolic-ref output: "${ref}"`);
    }
    return branch;
  }
}
