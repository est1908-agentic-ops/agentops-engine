import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GitCommandRunner } from '@agentops/ports';

export interface WorkspaceManagerOptions {
  git: GitCommandRunner;
  cacheDir?: string;
  workspacesDir?: string;
  cloneUrl: (repo: string) => string;
}

export interface PreparedWorkspace {
  workspaceRef: string;
  branch: string;
  baseBranch: string;
}

export interface Workspaces {
  prepare(taskId: string, repo: string): Promise<PreparedWorkspace>;
  cleanup(workspaceRef: string, repo: string): Promise<void>;
}

export class WorkspaceError extends Error {}

function sanitizeRepoSlug(repo: string): string {
  return repo.replace(/[^a-zA-Z0-9-]/g, '-');
}

export class WorkspaceManager implements Workspaces {
  private readonly git: GitCommandRunner;
  private readonly cacheDir: string;
  private readonly workspacesDir: string;
  private readonly cloneUrl: (repo: string) => string;

  constructor(opts: WorkspaceManagerOptions) {
    this.git = opts.git;
    this.cacheDir = opts.cacheDir ?? join(homedir(), '.agentops', 'cache');
    this.workspacesDir = opts.workspacesDir ?? join(homedir(), '.agentops', 'workspaces');
    this.cloneUrl = opts.cloneUrl;
  }

  async prepare(taskId: string, repo: string): Promise<PreparedWorkspace> {
    await mkdir(this.cacheDir, { recursive: true });
    await mkdir(this.workspacesDir, { recursive: true });
    const cachePath = join(this.cacheDir, sanitizeRepoSlug(repo));
    await this.ensureBaseClone(cachePath, repo);
    const baseBranch = await this.detectDefaultBranch(cachePath);
    const branch = `agentops/${taskId}`;
    const workspacePath = join(this.workspacesDir, taskId);

    const addResult = await this.git.run(
      ['worktree', 'add', workspacePath, '-b', branch, `origin/${baseBranch}`],
      { cwd: cachePath },
    );
    if (addResult.exitCode !== 0) {
      throw new WorkspaceError(`git worktree add failed for ${repo}: ${addResult.stderr}`);
    }

    return { workspaceRef: workspacePath, branch, baseBranch };
  }

  async cleanup(workspaceRef: string, repo: string): Promise<void> {
    // Run the removal from the base clone, not from inside workspaceRef itself — a
    // worktree removing its own cwd out from under the running process is fragile and
    // git-version-dependent. The base clone is the stable, always-present "main" worktree.
    const cachePath = join(this.cacheDir, sanitizeRepoSlug(repo));
    const result = await this.git.run(['worktree', 'remove', workspaceRef, '--force'], {
      cwd: cachePath,
    });
    if (result.exitCode !== 0) {
      throw new WorkspaceError(`git worktree remove failed for ${workspaceRef}: ${result.stderr}`);
    }
  }

  private async ensureBaseClone(cachePath: string, repo: string): Promise<void> {
    // Check with a plain fs call, not a git invocation with `cwd: cachePath` — spawning
    // git with a cwd that doesn't exist yet (the "not cloned yet" case, which is exactly
    // what we're distinguishing here) fails at the OS level, not as a normal git error.
    if (existsSync(cachePath)) {
      const fetchResult = await this.git.run(['fetch', 'origin'], { cwd: cachePath });
      if (fetchResult.exitCode !== 0) {
        throw new WorkspaceError(`git fetch failed for ${repo}: ${fetchResult.stderr}`);
      }
      return;
    }
    const cloneResult = await this.git.run(['clone', this.cloneUrl(repo), cachePath], { cwd: this.cacheDir });
    if (cloneResult.exitCode !== 0) {
      throw new WorkspaceError(`git clone failed for ${repo}: ${cloneResult.stderr}`);
    }
  }

  private async detectDefaultBranch(cachePath: string): Promise<string> {
    const result = await this.git.run(['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: cachePath });
    if (result.exitCode !== 0) {
      throw new WorkspaceError(`could not detect default branch in ${cachePath}: ${result.stderr}`);
    }
    const ref = result.stdout.trim();
    const branch = ref.split('/').pop();
    if (!branch) {
      throw new WorkspaceError(`unexpected symbolic-ref output: "${ref}"`);
    }
    return branch;
  }
}
