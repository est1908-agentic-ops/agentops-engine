import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  existsSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SpawnGitCommandRunner } from './spawn-git-command-runner';
import { repositorySessionIdentity, WorkspaceManager } from './workspace-manager';

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
  const manager = new WorkspaceManager({
    resolveGit: () => recording,
    resolveGitForProject: () => recording,
    cacheDir,
    workspacesDir,
    cloneUrl: () => remoteDir,
  });
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
    const manager = new WorkspaceManager({
      resolveGit: () => git,
      resolveGitForProject: () => git,
      cacheDir,
      workspacesDir,
      cloneUrl: () => remoteDir,
    });

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
    run: (
      command: string,
      opts: { cwd: string },
    ) => Promise<{ stdout: string; stderr: string; exitCode: number; spawnFailed?: boolean }>;
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

    await expect(
      manager.prepare('task-1', 'owner/repo', ['pnpm install', 'pnpm build']),
    ).rejects.toThrow(/boom/);
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
      run: async () => ({
        stdout: '',
        stderr: 'spawn git ENOENT',
        exitCode: -1,
        spawnFailed: true,
      }),
    };
    const manager = new WorkspaceManager({
      resolveGit: () => fakeGit,
      cacheDir,
      workspacesDir,
      cloneUrl: () => remoteDir,
    });

    await expect(manager.prepare('task-1', 'owner/repo')).rejects.toMatchObject({
      nonRetryable: true,
    });
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

    await expect(manager.prepare('task-1', 'owner/repo')).rejects.toMatchObject({
      nonRetryable: false,
    });
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

  it('prepareScratch sanitizes a taskId containing path-traversal sequences to stay inside workspacesDir/scratch', async () => {
    const { manager } = buildManager();

    const { workspaceRef } = await manager.prepareScratch('../../../etc/evil');

    expect(workspaceRef.startsWith(join(workspacesDir, 'scratch'))).toBe(true);
    expect(existsSync(workspaceRef)).toBe(true);
  });

  it('cleanupScratch refuses to remove a path outside the scratch root', async () => {
    const { manager } = buildManager();
    const outside = join(root, 'not-scratch');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'keep.txt'), 'do not delete me');

    await expect(manager.cleanupScratch(outside)).rejects.toMatchObject({ nonRetryable: true });

    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  });

  it('cleanupScratch refuses to remove the scratch root itself', async () => {
    const { manager } = buildManager();
    await manager.prepareScratch('task-a');
    await manager.prepareScratch('task-b');
    const scratchRoot = join(workspacesDir, 'scratch');

    await expect(manager.cleanupScratch(scratchRoot)).rejects.toMatchObject({ nonRetryable: true });

    expect(existsSync(scratchRoot)).toBe(true);
  });
});

describe('WorkspaceManager.pruneOrphans', () => {
  it('removes base clones + worktrees for repos no longer managed, keeping live ones', async () => {
    const { manager } = buildManager();
    const live = await manager.prepare('task-live', 'owner/live');
    const gone = await manager.prepare('task-gone', 'owner/gone');
    expect(existsSync(join(cacheDir, 'owner-live'))).toBe(true);
    expect(existsSync(join(cacheDir, 'owner-gone'))).toBe(true);
    expect(existsSync(gone.workspaceRef)).toBe(true);

    const { removed } = await manager.pruneOrphans(['owner/live']);

    // orphan (removed project) clone + its worktree are gone
    expect(existsSync(join(cacheDir, 'owner-gone'))).toBe(false);
    expect(existsSync(gone.workspaceRef)).toBe(false);
    expect(removed).toEqual(expect.arrayContaining(['cache/owner-gone', 'tasks/task-gone']));
    // live project untouched
    expect(existsSync(join(cacheDir, 'owner-live'))).toBe(true);
    expect(existsSync(live.workspaceRef)).toBe(true);
    expect(removed).not.toContain('cache/owner-live');
    expect(removed).not.toContain('tasks/task-live');
  });

  it('leaves the scratch dir and non-worktree entries alone', async () => {
    const { manager } = buildManager();
    await manager.prepareScratch('chat-1'); // creates workspaces/scratch/chat-1
    await manager.prepare('task-live', 'owner/live');
    mkdirSync(join(workspacesDir, 'stray-dir'), { recursive: true }); // not a worktree

    const { removed } = await manager.pruneOrphans(['owner/live']);

    expect(existsSync(join(workspacesDir, 'scratch'))).toBe(true);
    expect(existsSync(join(workspacesDir, 'stray-dir'))).toBe(true);
    expect(removed).toEqual([]);
  });

  it('is a no-op when there are no cache/workspaces dirs yet', async () => {
    const { manager } = buildManager();
    await expect(manager.pruneOrphans(['owner/live'])).resolves.toEqual({ removed: [] });
  });

  it('fetches refs/pull/<n>/head and checks out FETCH_HEAD without falling back to the base branch', async () => {
    writeFileSync(join(remoteDir, 'pr-feature.md'), 'pr head');
    execFileSync('git', ['add', 'pr-feature.md'], { cwd: remoteDir });
    execFileSync('git', ['commit', '-m', 'pr head commit'], { cwd: remoteDir });
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: remoteDir })
      .toString()
      .trim();
    execFileSync('git', ['update-ref', 'refs/pull/7/head', headSha], { cwd: remoteDir });

    const { manager, gitCalls } = buildManager();
    const result = await manager.prepare(
      'task-pr',
      'owner/repo',
      undefined,
      'feature/pr',
      'refs/pull/7/head',
    );

    expect(result.branch).toBe('feature/pr');
    expect(
      gitCalls.some(
        (args) => args[0] === 'fetch' && args[1] === 'origin' && args[2] === 'refs/pull/7/head',
      ),
    ).toBe(true);
    expect(
      gitCalls.some(
        (args) =>
          args[0] === 'worktree' &&
          args[1] === 'add' &&
          args[3] === '-B' &&
          args[4] === 'feature/pr' &&
          args[5] === 'FETCH_HEAD',
      ),
    ).toBe(true);
    expect(readFileSync(join(result.workspaceRef, 'pr-feature.md'), 'utf8')).toBe('pr head');
  });
});

describe('WorkspaceManager — git ref validation', () => {
  it('rejects prepare with an invalid headBranch (leading dash)', async () => {
    const _unused = buildManager();
    const real = new SpawnGitCommandRunner();
    const gitCallCount = { count: 0 };
    const countingGit = {
      run: (args: string[], opts: { cwd: string }) => {
        gitCallCount.count++;
        return real.run(args, opts);
      },
    };
    const strictManager = new WorkspaceManager({
      resolveGit: () => countingGit,
      cacheDir,
      workspacesDir,
      cloneUrl: () => remoteDir,
    });

    await expect(
      strictManager.prepare('task-1', 'owner/repo', undefined, '--upload-pack=/tmp/x'),
    ).rejects.toMatchObject({
      nonRetryable: true,
      message: expect.stringContaining('invalid headBranch'),
    });
    // Verify no git commands were run (validation happens at the start)
    expect(gitCallCount.count).toBe(0);
  });

  it('rejects prepare with an invalid headRef (leading dash)', async () => {
    buildManager();
    const real = new SpawnGitCommandRunner();
    const gitCallCount = { count: 0 };
    const countingGit = {
      run: (args: string[], opts: { cwd: string }) => {
        gitCallCount.count++;
        return real.run(args, opts);
      },
    };
    const strictManager = new WorkspaceManager({
      resolveGit: () => countingGit,
      cacheDir,
      workspacesDir,
      cloneUrl: () => remoteDir,
    });

    await expect(
      strictManager.prepare('task-1', 'owner/repo', undefined, undefined, '-x'),
    ).rejects.toMatchObject({
      nonRetryable: true,
      message: expect.stringContaining('invalid headRef'),
    });
    // Verify no git commands were run
    expect(gitCallCount.count).toBe(0);
  });

  it('accepts prepare with a valid headBranch', async () => {
    const { manager } = buildManager();

    const result = await manager.prepare('task-1', 'owner/repo', undefined, 'feature/x');

    expect(result.branch).toBe('feature/x');
    expect(existsSync(result.workspaceRef)).toBe(true);
  });
});

describe('WorkspaceManager — repository sessions', () => {
  it('returns an existing matching session without running git again', async () => {
    const { manager, gitCalls } = buildManager();
    const request = { taskId: 'retry', repositories: [{ repo: 'acme/app' }] };

    const first = await manager.prepareRepositorySession('hub', request);
    const callsAfterFirst = gitCalls.length;
    const second = await manager.prepareRepositorySession('hub', request);

    expect(second).toEqual(first);
    expect(gitCalls).toHaveLength(callsAfterFirst);
  });

  it('rejects a different request without mutating an existing session', async () => {
    const { manager } = buildManager();
    const first = await manager.prepareRepositorySession('hub', {
      taskId: 'request-mismatch',
      repositories: [{ repo: 'acme/app' }],
    });

    await expect(
      manager.prepareRepositorySession('hub', {
        taskId: 'request-mismatch',
        repositories: [{ repo: 'acme/app', ref: 'main' }],
      }),
    ).rejects.toMatchObject({ nonRetryable: true, message: expect.stringContaining('request') });
    expect(existsSync(join(first.workspaceRef, '.agentops-session.json'))).toBe(true);
  });

  it('serializes matching creators across manager instances for the entire clone', async () => {
    let clonesStarted = 0;
    let releaseClones: () => void;
    const clonesReleased = new Promise<void>((resolve) => {
      releaseClones = resolve;
    });
    let firstCloneStarted!: () => void;
    const firstClone = new Promise<void>((resolve) => {
      firstCloneStarted = resolve;
    });
    const git = {
      run: async (args: string[]) => {
        if (args[0] === 'clone') {
          clonesStarted++;
          firstCloneStarted();
          await clonesReleased;
        }
        return {
          stdout: args[0] === 'rev-parse' ? 'a'.repeat(40) : '',
          stderr: '',
          exitCode: 0,
        };
      },
    };
    const firstManager = new WorkspaceManager({
      resolveGit: () => git,
      resolveGitForProject: () => git,
      cacheDir,
      workspacesDir,
      cloneUrl: () => remoteDir,
    });
    const secondManager = new WorkspaceManager({
      resolveGit: () => git,
      resolveGitForProject: () => git,
      cacheDir,
      workspacesDir,
      cloneUrl: () => remoteDir,
      repositorySessionLockRetryMs: 1,
    });
    const request = { taskId: 'concurrent', repositories: [{ repo: 'acme/app' }] };
    const expectedPath = join(
      workspacesDir,
      'repository-sessions',
      repositorySessionIdentity('hub'),
      repositorySessionIdentity(request.taskId),
    );
    const first = firstManager.prepareRepositorySession('hub', request);
    await firstClone;
    const second = secondManager.prepareRepositorySession('hub', request);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(clonesStarted).toBe(1);
    expect(existsSync(join(expectedPath, '.agentops-session.json'))).toBe(false);
    releaseClones!();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ workspaceRef: expectedPath }),
      expect.objectContaining({ workspaceRef: expectedPath }),
    ]);
    expect(existsSync(join(expectedPath, '.agentops-session.json'))).toBe(true);
  });

  it('keeps the winner intact when concurrent creators have different requests', async () => {
    let clonesStarted = 0;
    let releaseClones: () => void;
    const clonesReleased = new Promise<void>((resolve) => {
      releaseClones = resolve;
    });
    let firstCloning!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      firstCloning = resolve;
    });
    const git = {
      run: async (args: string[]) => {
        if (args[0] === 'clone') {
          clonesStarted++;
          firstCloning();
          await clonesReleased;
        }
        return {
          stdout: args[0] === 'rev-parse' ? 'b'.repeat(40) : '',
          stderr: '',
          exitCode: 0,
        };
      },
    };
    const manager = new WorkspaceManager({
      resolveGit: () => git,
      resolveGitForProject: () => git,
      cacheDir,
      workspacesDir,
      cloneUrl: () => remoteDir,
    });
    const firstRequest = { taskId: 'concurrent-mismatch', repositories: [{ repo: 'acme/app' }] };
    const secondRequest = {
      taskId: 'concurrent-mismatch',
      repositories: [{ repo: 'acme/app', ref: 'main' }],
    };
    const first = manager.prepareRepositorySession('hub', firstRequest);
    const second = manager.prepareRepositorySession('hub', secondRequest);

    await firstStarted;
    releaseClones!();
    const results = await Promise.allSettled([first, second]);
    const winnerIndex = results.findIndex((result) => result.status === 'fulfilled');
    const loser = results.find((result) => result.status === 'rejected');
    expect(winnerIndex).not.toBe(-1);
    expect(loser).toMatchObject({
      reason: { nonRetryable: true, message: expect.stringContaining('request') },
    });
    const winnerRequest = winnerIndex === 0 ? firstRequest : secondRequest;
    await expect(manager.prepareRepositorySession('hub', winnerRequest)).resolves.toMatchObject({
      workspaceRef: expect.any(String),
    });
  });

  it('does not let an orphan staging directory occupy the final session path', async () => {
    const { manager } = buildManager();
    const ownerPath = join(
      workspacesDir,
      'repository-sessions',
      repositorySessionIdentity('hub'),
      '.staging',
    );
    mkdirSync(join(ownerPath, 'orphan'), { recursive: true });

    await expect(
      manager.prepareRepositorySession('hub', {
        taskId: 'orphan-safe',
        repositories: [{ repo: 'acme/app' }],
      }),
    ).resolves.toMatchObject({
      workspaceRef: expect.stringContaining(repositorySessionIdentity('orphan-safe')),
    });
  });

  it('reclaims stale crashed staging only after its PVC lease expires', async () => {
    let time = 10;
    const manager = new WorkspaceManager({
      resolveGit: () => new SpawnGitCommandRunner(),
      resolveGitForProject: () => new SpawnGitCommandRunner(),
      cacheDir,
      workspacesDir,
      cloneUrl: () => remoteDir,
      now: () => time,
      repositorySessionLockStaleMs: 20,
      repositorySessionStagingIdleMs: 20,
    });
    const owner = repositorySessionIdentity('gone');
    const task = repositorySessionIdentity('crashed');
    const staging = join(
      workspacesDir,
      'repository-sessions',
      owner,
      '.staging',
      'session-crashed',
    );
    mkdirSync(staging, { recursive: true });
    writeFileSync(
      join(staging, '.agentops-staging.json'),
      JSON.stringify({
        ownerProject: 'gone',
        taskId: 'crashed',
        requestIdentity: 'a'.repeat(64),
        createdAt: 0,
        workspaceRef: join(workspacesDir, 'repository-sessions', owner, task),
      }),
    );
    const lock = join(workspacesDir, 'repository-sessions', '.locks', owner, `${task}.lock`);
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, 'lease.json'),
      JSON.stringify({ token: crypto.randomUUID(), acquiredAt: 0 }),
    );

    await manager.pruneOrphans([], []);
    expect(existsSync(staging)).toBe(true);
    time = 21;
    const { removed } = await manager.pruneOrphans([], []);
    expect(existsSync(staging)).toBe(false);
    expect(removed).toContain(staging);
  });

  it('uses collision-resistant owner and task path components', async () => {
    const { manager } = buildManager();
    const first = await manager.prepareRepositorySession('a/b', {
      taskId: 'c/d',
      repositories: [{ repo: 'acme/app' }],
    });
    const second = await manager.prepareRepositorySession('a-b', {
      taskId: 'c-d',
      repositories: [{ repo: 'acme/shared' }],
    });
    expect(second.workspaceRef).not.toBe(first.workspaceRef);
    await expect(manager.cleanupRepositorySession('a-b', first.workspaceRef)).rejects.toMatchObject(
      { nonRetryable: true },
    );
  });

  it('creates confined one- and multi-repository sessions using the owner project runner', async () => {
    const remoteB = join(root, 'remote-b');
    execFileSync('git', ['clone', remoteDir, remoteB]);
    const ownerCalls: string[][] = [];
    const targetCalls: string[][] = [];
    const resolvedProjects: string[] = [];
    const metadataPresentDuringClone: boolean[] = [];
    const real = new SpawnGitCommandRunner();
    const ownerRunner = {
      run: (args: string[], opts: { cwd: string }) => {
        ownerCalls.push(args);
        if (args[0] === 'clone')
          metadataPresentDuringClone.push(existsSync(join(opts.cwd, '.agentops-session.json')));
        return real.run(args, opts);
      },
    };
    const targetRunner = {
      run: (args: string[], opts: { cwd: string }) => {
        targetCalls.push(args);
        return real.run(args, opts);
      },
    };
    const manager = new WorkspaceManager({
      resolveGit: () => targetRunner,
      resolveGitForProject: (project) => {
        resolvedProjects.push(project);
        return project === 'hub' ? ownerRunner : targetRunner;
      },
      cacheDir,
      workspacesDir,
      cloneUrl: (repo) => (repo === 'acme/app' ? remoteDir : remoteB),
    });

    const session = await manager.prepareRepositorySession('hub', {
      taskId: 'rollbar-123',
      repositories: [{ repo: 'acme/app' }, { repo: 'acme/shared', ref: 'main' }],
    });

    expect(session.workspaceRef).toBe(
      join(
        workspacesDir,
        'repository-sessions',
        repositorySessionIdentity('hub'),
        repositorySessionIdentity('rollbar-123'),
      ),
    );
    expect(session.repositories.map((repository) => repository.relativePath)).toEqual([
      'repositories/acme/app',
      'repositories/acme/shared',
    ]);
    expect(
      session.repositories.every((repository) => /^[0-9a-f]{40}$/.test(repository.commit)),
    ).toBe(true);
    expect(
      session.repositories.every((repository) =>
        existsSync(join(session.workspaceRef, repository.relativePath)),
      ),
    ).toBe(true);
    expect(ownerCalls.filter((args) => args[0] === 'clone')).toHaveLength(2);
    expect(metadataPresentDuringClone).toEqual([false, false]);
    expect(resolvedProjects).toEqual(['hub']);
    expect(targetCalls).toEqual([]);
    const metadata = JSON.parse(
      readFileSync(join(session.workspaceRef, '.agentops-session.json'), 'utf8'),
    );
    expect(metadata).toMatchObject({
      ownerProject: 'hub',
      taskId: 'rollbar-123',
      repositories: session.repositories,
    });
    expect(Number.isFinite(metadata.createdAt)).toBe(true);
    expect(Number.isFinite(metadata.lastUsedAt)).toBe(true);
  });

  it('checks out the exact fetched explicit ref rather than the remote default commit', async () => {
    const defaultCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: remoteDir })
      .toString()
      .trim();
    execFileSync('git', ['checkout', '-b', 'feature/session-ref'], { cwd: remoteDir });
    writeFileSync(join(remoteDir, 'feature.txt'), 'feature');
    execFileSync('git', ['add', 'feature.txt'], { cwd: remoteDir });
    execFileSync('git', ['commit', '-m', 'feature'], { cwd: remoteDir });
    const featureCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: remoteDir })
      .toString()
      .trim();
    execFileSync('git', ['checkout', 'main'], { cwd: remoteDir });
    const { manager } = buildManager();
    const session = await manager.prepareRepositorySession('hub', {
      taskId: 'refs',
      repositories: [
        { repo: 'acme/default' },
        { repo: 'acme/feature', ref: 'refs/heads/feature/session-ref' },
      ],
    });
    expect(session.repositories.map((repository) => repository.commit)).toEqual([
      defaultCommit,
      featureCommit,
    ]);
  });

  it('cleans up only owned session roots and is idempotent once absent', async () => {
    const { manager } = buildManager();
    const session = await manager.prepareRepositorySession('hub', {
      taskId: 'one',
      repositories: [{ repo: 'acme/app' }],
    });
    await expect(
      manager.cleanupRepositorySession('other', session.workspaceRef),
    ).rejects.toMatchObject({ nonRetryable: true });
    expect(existsSync(session.workspaceRef)).toBe(true);
    await manager.cleanupRepositorySession('hub', session.workspaceRef);
    await expect(
      manager.cleanupRepositorySession('hub', session.workspaceRef),
    ).resolves.toBeUndefined();
    await expect(
      manager.cleanupRepositorySession('hub', join(root, 'outside')),
    ).rejects.toMatchObject({ nonRetryable: true });
    const malformed = join(
      workspacesDir,
      'repository-sessions',
      repositorySessionIdentity('hub'),
      'not-a-session',
    );
    await expect(manager.cleanupRepositorySession('hub', malformed)).rejects.toMatchObject({
      nonRetryable: true,
    });
    await expect(manager.touchRepositorySession('hub', malformed)).rejects.toMatchObject({
      nonRetryable: true,
    });
  });

  it('removes only the generated session root when a sequential clone fails', async () => {
    let cloneCount = 0;
    const git = {
      run: async (args: string[]) => {
        if (args[0] === 'clone' && ++cloneCount === 2)
          return { stdout: '', stderr: 'nope', exitCode: 1 };
        if (args[0] === 'rev-parse') return { stdout: 'a'.repeat(40), stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    const manager = new WorkspaceManager({
      resolveGit: () => git,
      resolveGitForProject: () => git,
      cacheDir,
      workspacesDir,
      cloneUrl: () => remoteDir,
    });
    const sessionsRoot = join(workspacesDir, 'repository-sessions');

    await expect(
      manager.prepareRepositorySession('hub', {
        taskId: 'partial',
        repositories: [{ repo: 'acme/app' }, { repo: 'acme/shared' }],
      }),
    ).rejects.toThrow(/nope/);
    const taskRoots = existsSync(sessionsRoot)
      ? readdirSync(sessionsRoot)
          .filter((owner) => owner !== '.locks')
          .flatMap((owner) =>
            readdirSync(join(sessionsRoot, owner)).filter((entry) => entry !== '.staging'),
          )
      : [];
    expect(taskRoots).toEqual([]);
    expect(readdirSync(join(sessionsRoot, repositorySessionIdentity('hub'), '.staging'))).toEqual(
      [],
    );
  });

  it('rejects malformed and symlinked metadata without deleting the session', async () => {
    const { manager } = buildManager();
    const session = await manager.prepareRepositorySession('hub', {
      taskId: 'metadata',
      repositories: [{ repo: 'acme/app' }],
    });
    const metadataPath = join(session.workspaceRef, '.agentops-session.json');
    writeFileSync(
      metadataPath,
      JSON.stringify({
        ownerProject: 'hub',
        taskId: 'metadata',
        createdAt: 1,
        lastUsedAt: 1,
        repositories: [
          { repo: 'acme/app', relativePath: 'repositories/wrong', commit: 'A'.repeat(40) },
        ],
      }),
    );
    await expect(
      manager.cleanupRepositorySession('hub', session.workspaceRef),
    ).rejects.toMatchObject({ nonRetryable: true });
    expect(existsSync(session.workspaceRef)).toBe(true);
    rmSync(metadataPath);
    const outside = join(root, 'metadata-outside.json');
    writeFileSync(outside, '{}');
    symlinkSync(outside, metadataPath);
    await expect(manager.touchRepositorySession('hub', session.workspaceRef)).rejects.toMatchObject(
      { nonRetryable: true },
    );
    expect(existsSync(session.workspaceRef)).toBe(true);
  });

  it('requires complete finite metadata timestamps before cleanup', async () => {
    const { manager } = buildManager();
    const session = await manager.prepareRepositorySession('hub', {
      taskId: 'missing-timestamp',
      repositories: [{ repo: 'acme/app' }],
    });
    writeFileSync(
      join(session.workspaceRef, '.agentops-session.json'),
      JSON.stringify({
        ownerProject: 'hub',
        taskId: 'missing-timestamp',
        lastUsedAt: Number.NaN,
        repositories: session.repositories,
      }),
    );
    await expect(
      manager.cleanupRepositorySession('hub', session.workspaceRef),
    ).rejects.toMatchObject({
      nonRetryable: true,
    });
    expect(existsSync(session.workspaceRef)).toBe(true);
  });

  it('touches owned sessions and skips legacy workspace refs', async () => {
    let time = 100;
    const manager = new WorkspaceManager({
      resolveGit: () => new SpawnGitCommandRunner(),
      resolveGitForProject: () => new SpawnGitCommandRunner(),
      cacheDir,
      workspacesDir,
      cloneUrl: () => remoteDir,
      now: () => time,
    });
    const session = await manager.prepareRepositorySession('hub', {
      taskId: 'one',
      repositories: [{ repo: 'acme/app' }],
    });
    time = 101;
    await manager.touchRepositorySession('hub', session.workspaceRef);
    expect(
      JSON.parse(readFileSync(join(session.workspaceRef, '.agentops-session.json'), 'utf8'))
        .lastUsedAt,
    ).toBe(101);
    await expect(
      manager.touchRepositorySession('other', session.workspaceRef),
    ).rejects.toMatchObject({ nonRetryable: true });
    await expect(
      manager.touchRepositorySession('hub', join(workspacesDir, 'legacy')),
    ).resolves.toBeUndefined();
  });

  it('prunes only expired or non-live repository sessions and skips their directory as a legacy worktree', async () => {
    let time = 0;
    const manager = new WorkspaceManager({
      resolveGit: () => new SpawnGitCommandRunner(),
      resolveGitForProject: () => new SpawnGitCommandRunner(),
      cacheDir,
      workspacesDir,
      cloneUrl: () => remoteDir,
      now: () => time,
    });
    const active = await manager.prepareRepositorySession('live', {
      taskId: 'active',
      repositories: [{ repo: 'acme/app' }],
    });
    const expired = await manager.prepareRepositorySession('live', {
      taskId: 'expired',
      repositories: [{ repo: 'acme/shared' }],
    });
    const gone = await manager.prepareRepositorySession('gone', {
      taskId: 'gone',
      repositories: [{ repo: 'acme/gone' }],
    });
    time = 86_400_000;
    await manager.touchRepositorySession('live', active.workspaceRef);
    const { removed } = await manager.pruneOrphans([], ['live']);
    expect(existsSync(active.workspaceRef)).toBe(true);
    expect(existsSync(expired.workspaceRef)).toBe(true); // exact TTL boundary is active
    expect(existsSync(gone.workspaceRef)).toBe(false);
    expect(removed).toContain(gone.workspaceRef);
    time++;
    await manager.pruneOrphans([], ['live']);
    expect(existsSync(expired.workspaceRef)).toBe(false);
  });

  it('serializes cleanup and touch so the later touch is a no-op', async () => {
    const { manager } = buildManager();
    const session = await manager.prepareRepositorySession('hub', {
      taskId: 'cleanup-race',
      repositories: [{ repo: 'acme/app' }],
    });
    await Promise.all([
      manager.cleanupRepositorySession('hub', session.workspaceRef),
      manager.touchRepositorySession('hub', session.workspaceRef),
    ]);
    expect(existsSync(session.workspaceRef)).toBe(false);
  });

  it('never follows a symlinked repository-session owner directory', async () => {
    const { manager } = buildManager();
    const session = await manager.prepareRepositorySession('hub', {
      taskId: 'owner-link',
      repositories: [{ repo: 'acme/app' }],
    });
    const ownerPath = join(workspacesDir, 'repository-sessions', repositorySessionIdentity('hub'));
    const outside = join(root, 'outside-owner');
    // Preserve a valid session outside the trusted root, then substitute the owner component.
    renameSync(ownerPath, outside);
    symlinkSync(outside, ownerPath);
    await expect(manager.touchRepositorySession('hub', session.workspaceRef)).rejects.toMatchObject(
      { nonRetryable: true },
    );
    await expect(
      manager.cleanupRepositorySession('hub', session.workspaceRef),
    ).rejects.toMatchObject({ nonRetryable: true });
    await manager.pruneOrphans([], []);
    expect(existsSync(join(outside, repositorySessionIdentity('owner-link')))).toBe(true);
    await expect(
      manager.prepareRepositorySession('hub', {
        taskId: 'another',
        repositories: [{ repo: 'acme/app' }],
      }),
    ).rejects.toMatchObject({ nonRetryable: true });
  });

  it('never follows a symlinked staging directory while removing a final session', async () => {
    const { manager } = buildManager();
    const session = await manager.prepareRepositorySession('hub', {
      taskId: 'staging-link',
      repositories: [{ repo: 'acme/app' }],
    });
    const prunable = await manager.prepareRepositorySession('hub', {
      taskId: 'staging-link-prune',
      repositories: [{ repo: 'acme/app' }],
    });
    const outside = join(root, 'outside-staging');
    mkdirSync(outside);
    writeFileSync(join(outside, 'sentinel'), 'keep');
    const staging = join(
      workspacesDir,
      'repository-sessions',
      repositorySessionIdentity('hub'),
      '.staging',
    );
    rmSync(staging, { recursive: true, force: true });
    symlinkSync(outside, staging);

    await expect(
      manager.cleanupRepositorySession('hub', session.workspaceRef),
    ).resolves.toBeUndefined();
    await manager.pruneOrphans([], []);
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('keep');
    expect(existsSync(session.workspaceRef)).toBe(false);
    expect(existsSync(prunable.workspaceRef)).toBe(false);
  });
});
