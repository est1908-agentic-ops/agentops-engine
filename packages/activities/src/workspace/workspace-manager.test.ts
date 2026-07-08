import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SpawnGitCommandRunner } from './spawn-git-command-runner';
import { WorkspaceManager } from './workspace-manager';

let root: string;
let remoteDir: string;
let cacheDir: string;
let workspacesDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentops-workspace-test-'));
  remoteDir = join(root, 'remote');
  cacheDir = join(root, 'cache');
  workspacesDir = join(root, 'workspaces');

  execFileSync('git', ['init', '-b', 'main', remoteDir]);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: remoteDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: remoteDir });
  writeFileSync(join(remoteDir, 'README.md'), 'hello');
  execFileSync('git', ['add', 'README.md'], { cwd: remoteDir });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: remoteDir });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function buildManager(): { manager: WorkspaceManager; gitCalls: string[][] } {
  const real = new SpawnGitCommandRunner();
  const gitCalls: string[][] = [];
  const recording = {
    run: (args: string[], opts: { cwd: string }) => {
      gitCalls.push(args);
      return real.run(args, opts);
    },
  };
  const manager = new WorkspaceManager({ resolveGit: () => recording, cacheDir, workspacesDir, cloneUrl: () => remoteDir });
  return { manager, gitCalls };
}

describe('WorkspaceManager', () => {
  it('clones on first prepare, detects the default branch, and creates a worktree', async () => {
    const { manager } = buildManager();

    const result = await manager.prepare('task-1', 'owner/repo');

    expect(result.branch).toBe('agentops/task-1');
    expect(result.baseBranch).toBe('main');
    expect(existsSync(result.workspaceRef)).toBe(true);
    expect(existsSync(join(result.workspaceRef, 'README.md'))).toBe(true);
  });

  it('reuses the existing base clone on a second prepare for the same repo (fetch, not clone)', async () => {
    const { manager, gitCalls } = buildManager();
    const first = await manager.prepare('task-1', 'owner/repo');

    const second = await manager.prepare('task-2', 'owner/repo');

    expect(second.workspaceRef).not.toBe(first.workspaceRef);
    const cloneCalls = gitCalls.filter((args) => args[0] === 'clone');
    const fetchCalls = gitCalls.filter((args) => args[0] === 'fetch');
    expect(cloneCalls).toHaveLength(1);
    expect(fetchCalls).toHaveLength(1);
    const cachePath = join(cacheDir, 'owner-repo');
    const worktreeList = execFileSync('git', ['worktree', 'list'], { cwd: cachePath }).toString();
    expect(worktreeList).toContain('task-1');
    expect(worktreeList).toContain('task-2');
  });

  it('cleanup removes the worktree but leaves the base clone intact', async () => {
    const { manager } = buildManager();
    const prepared = await manager.prepare('task-1', 'owner/repo');
    const cachePath = join(cacheDir, 'owner-repo');

    await manager.cleanup(prepared.workspaceRef, 'owner/repo');

    expect(existsSync(prepared.workspaceRef)).toBe(false);
    expect(existsSync(cachePath)).toBe(true);
    const worktreeList = execFileSync('git', ['worktree', 'list'], { cwd: cachePath }).toString();
    expect(worktreeList).not.toContain('task-1');
  });

  it('never writes the auth token into the cached clone config', async () => {
    const git = new SpawnGitCommandRunner({ authToken: () => 'super-secret' });
    const manager = new WorkspaceManager({ resolveGit: () => git, cacheDir, workspacesDir, cloneUrl: () => remoteDir });

    await manager.prepare('task-1', 'owner/repo');

    const config = readFileSync(join(cacheDir, 'owner-repo', '.git', 'config'), 'utf8');
    expect(config).not.toContain('super-secret');
  });

  it('routes each repo to its own resolved git runner', async () => {
    const remoteDirB = join(root, 'remote-b');
    execFileSync('git', ['init', '-b', 'main', remoteDirB]);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: remoteDirB });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: remoteDirB });
    writeFileSync(join(remoteDirB, 'README.md'), 'hello-b');
    execFileSync('git', ['add', 'README.md'], { cwd: remoteDirB });
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: remoteDirB });

    const real = new SpawnGitCommandRunner();
    const callsA: string[][] = [];
    const callsB: string[][] = [];
    const runnerA = {
      run: (args: string[], opts: { cwd: string }) => {
        callsA.push(args);
        return real.run(args, opts);
      },
    };
    const runnerB = {
      run: (args: string[], opts: { cwd: string }) => {
        callsB.push(args);
        return real.run(args, opts);
      },
    };

    const manager = new WorkspaceManager({
      resolveGit: (repo) => (repo === 'owner/repo-a' ? runnerA : runnerB),
      cacheDir,
      workspacesDir,
      cloneUrl: (repo) => (repo === 'owner/repo-a' ? remoteDir : remoteDirB),
    });

    await manager.prepare('task-a', 'owner/repo-a');
    await manager.prepare('task-b', 'owner/repo-b');

    expect(callsA.map((args) => args[0])).toEqual(['clone', 'symbolic-ref', 'branch', 'worktree']);
    expect(callsB.map((args) => args[0])).toEqual(['clone', 'symbolic-ref', 'branch', 'worktree']);
  });
});

describe('WorkspaceManager — stale-state reclaim', () => {
  // Reproduces the issue-broccoli-94 incident: a previous run of the same taskId
  // never reached cleanup() (crashed, was canceled before the workflow's try/catch),
  // leaving its worktree and/or branch behind. `git worktree add -b` isn't
  // transactional with its own path check — it can create the branch even when the
  // path-exists check subsequently fails — so a stale leftover poisons every future
  // attempt with a *different* fatal error each time and never self-recovers.

  it('reclaims a leftover worktree from an incomplete previous run when preparing the same taskId again', async () => {
    const { manager } = buildManager();
    const first = await manager.prepare('task-1', 'owner/repo');

    const second = await manager.prepare('task-1', 'owner/repo');

    expect(second.workspaceRef).toBe(first.workspaceRef);
    expect(existsSync(second.workspaceRef)).toBe(true);
    expect(existsSync(join(second.workspaceRef, 'README.md'))).toBe(true);
  });

  it('reclaims a stale untracked directory sitting at the workspace path', async () => {
    const { manager } = buildManager();
    const workspacePath = join(workspacesDir, 'task-1');
    mkdirSync(workspacePath, { recursive: true });
    writeFileSync(join(workspacePath, 'leftover.txt'), 'stale');

    const result = await manager.prepare('task-1', 'owner/repo');

    expect(existsSync(join(result.workspaceRef, 'leftover.txt'))).toBe(false);
    expect(existsSync(join(result.workspaceRef, 'README.md'))).toBe(true);
  });

  it('reclaims a dangling branch left behind by a previous failed worktree add', async () => {
    const { manager } = buildManager();
    await manager.prepare('task-0', 'owner/repo'); // ensure the base clone exists
    const cachePath = join(cacheDir, 'owner-repo');
    execFileSync('git', ['branch', 'agentops/task-1'], { cwd: cachePath });

    const result = await manager.prepare('task-1', 'owner/repo');

    expect(result.branch).toBe('agentops/task-1');
    expect(existsSync(join(result.workspaceRef, 'README.md'))).toBe(true);
  });
});

describe('WorkspaceManager — initCommands', () => {
  function buildManagerWithCommandRunner(commandRunner: {
    run: (command: string, opts: { cwd: string }) => Promise<{ stdout: string; stderr: string; exitCode: number; spawnFailed?: boolean }>;
  }): WorkspaceManager {
    const real = new SpawnGitCommandRunner();
    return new WorkspaceManager({
      resolveGit: () => real,
      cacheDir,
      workspacesDir,
      cloneUrl: () => remoteDir,
      commandRunner,
    });
  }

  it('runs each initCommand in the new worktree, in order, after the worktree is created', async () => {
    const calls: { command: string; cwd: string }[] = [];
    const manager = buildManagerWithCommandRunner({
      run: async (command, opts) => {
        calls.push({ command, cwd: opts.cwd });
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    const result = await manager.prepare('task-1', 'owner/repo', ['pnpm install', 'pnpm build']);

    expect(calls).toEqual([
      { command: 'pnpm install', cwd: result.workspaceRef },
      { command: 'pnpm build', cwd: result.workspaceRef },
    ]);
  });

  it('does not invoke the command runner when initCommands is absent or empty', async () => {
    let called = false;
    const manager = buildManagerWithCommandRunner({
      run: async () => {
        called = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    await manager.prepare('task-1', 'owner/repo');
    await manager.prepare('task-2', 'owner/repo', []);

    expect(called).toBe(false);
  });

  it('stops at the first failing initCommand and does not run the rest', async () => {
    const calls: string[] = [];
    const manager = buildManagerWithCommandRunner({
      run: async (command) => {
        calls.push(command);
        return command === 'pnpm install'
          ? { stdout: '', stderr: 'boom', exitCode: 1 }
          : { stdout: '', stderr: '', exitCode: 0 };
      },
    });

    await expect(manager.prepare('task-1', 'owner/repo', ['pnpm install', 'pnpm build'])).rejects.toThrow(/boom/);
    expect(calls).toEqual(['pnpm install']);
  });

  it('throws a non-retryable WorkspaceError when an initCommand fails to spawn', async () => {
    const manager = buildManagerWithCommandRunner({
      run: async () => ({ stdout: '', stderr: 'spawn sh ENOENT', exitCode: -1, spawnFailed: true }),
    });

    await expect(manager.prepare('task-1', 'owner/repo', ['pnpm install'])).rejects.toMatchObject({
      nonRetryable: true,
    });
  });

  it('throws a retryable WorkspaceError when an initCommand runs but exits non-zero for an ordinary reason', async () => {
    const manager = buildManagerWithCommandRunner({
      run: async () => ({ stdout: '', stderr: 'pnpm: command not found', exitCode: 127 }),
    });

    await expect(manager.prepare('task-1', 'owner/repo', ['pnpm install'])).rejects.toMatchObject({
      nonRetryable: false,
    });
  });
});

describe('WorkspaceManager — spawn failure classification', () => {
  it('throws a non-retryable WorkspaceError when the git binary itself fails to spawn', async () => {
    const fakeGit = {
      run: async () => ({ stdout: '', stderr: 'spawn git ENOENT', exitCode: -1, spawnFailed: true }),
    };
    const manager = new WorkspaceManager({
      resolveGit: () => fakeGit,
      cacheDir,
      workspacesDir,
      cloneUrl: () => remoteDir,
    });

    await expect(manager.prepare('task-1', 'owner/repo')).rejects.toMatchObject({ nonRetryable: true });
  });

  it('throws a retryable WorkspaceError when git runs but exits non-zero for an ordinary reason', async () => {
    const fakeGit = {
      run: async () => ({ stdout: '', stderr: 'fatal: could not read Username', exitCode: 128 }),
    };
    const manager = new WorkspaceManager({
      resolveGit: () => fakeGit,
      cacheDir,
      workspacesDir,
      cloneUrl: () => remoteDir,
    });

    await expect(manager.prepare('task-1', 'owner/repo')).rejects.toMatchObject({ nonRetryable: false });
  });
});

describe('WorkspaceManager — scratch workspaces', () => {
  it('prepareScratch creates an empty directory under workspacesDir', async () => {
    const { manager } = buildManager();

    const { workspaceRef } = await manager.prepareScratch('platform-task-1');

    expect(existsSync(workspaceRef)).toBe(true);
    expect(workspaceRef.startsWith(workspacesDir)).toBe(true);
  });

  it('cleanupScratch removes the directory', async () => {
    const { manager } = buildManager();
    const { workspaceRef } = await manager.prepareScratch('platform-task-2');

    await manager.cleanupScratch(workspaceRef);

    expect(existsSync(workspaceRef)).toBe(false);
  });
});
