import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
