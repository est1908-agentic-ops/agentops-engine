import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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

    expect(callsA.map((args) => args[0])).toEqual(['clone', 'symbolic-ref', 'worktree']);
    expect(callsB.map((args) => args[0])).toEqual(['clone', 'symbolic-ref', 'worktree']);
  });
});
