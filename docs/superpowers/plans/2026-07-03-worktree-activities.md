# Worktree Activities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fake `workspaceRef: input.repo` string in `DevCycle` with a real, git-worktree-backed local directory per task, so the real `claude`/`pi` backends have an actual checkout to operate on.

**Architecture:** A `GitCommandRunner` interface (in `packages/ports`, zero dependencies) with one concrete `SpawnGitCommandRunner` implementation (in `packages/activities`, spawns real `git`, centralizes token injection). `WorkspaceManager` uses it to maintain one shared base clone per repo plus one `git worktree` per task. A `MemoryWorkspaceManager` fake (same shape, zero I/O) keeps existing e2e tests hermetic. `dev-cycle.ts` calls `prepareWorkspace` once up front and `cleanupWorkspace` at every terminal state.

**Tech Stack:** TypeScript strict, `node:child_process` (no new npm dependency), vitest, real temporary git repos in tests (no mocking git itself).

**Design doc:** [docs/superpowers/specs/2026-07-03-worktree-activities-design.md](../specs/2026-07-03-worktree-activities-design.md)

---

### Task 1: `GitCommandRunner` interface in `packages/ports`

**Files:**
- Create: `packages/ports/src/git/git-command-runner.ts`
- Modify: `packages/ports/src/index.ts`
- Test: none (pure type declarations — nothing to unit test yet)

- [ ] **Step 1: Write the interface**

```ts
// packages/ports/src/git/git-command-runner.ts
export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitCommandRunner {
  run(args: string[], opts: { cwd: string }): Promise<GitCommandResult>;
}
```

- [ ] **Step 2: Export it from the package barrel**

Modify `packages/ports/src/index.ts`:

```ts
export * from './tracker-port';
export * from './scm-port';
export * from './memory/memory-tracker';
export * from './memory/memory-scm';
export * from './git/git-command-runner';
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @agentops/ports run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/ports/src/git/git-command-runner.ts packages/ports/src/index.ts
git commit -m "feat(ports): add GitCommandRunner interface"
```

---

### Task 2: `SpawnGitCommandRunner` — real implementation, centralized auth injection

**Files:**
- Create: `packages/activities/src/workspace/spawn-git-command-runner.ts`
- Test: `packages/activities/src/workspace/spawn-git-command-runner.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/activities/src/workspace/spawn-git-command-runner.test.ts
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { SpawnGitCommandRunner } from './spawn-git-command-runner';

function fakeSpawn(exitCode: number, stdout: string, stderr: string) {
  const calls: { command: string; args: string[]; options: unknown }[] = [];
  const spawnFn = vi.fn((command: string, args: string[], options: unknown) => {
    calls.push({ command, args, options });
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      child.emit('close', exitCode);
    });
    return child;
  });
  return { spawnFn, calls };
}

describe('SpawnGitCommandRunner', () => {
  it('prepends the auth header config override when a token is available', async () => {
    const { spawnFn, calls } = fakeSpawn(0, 'ok', '');
    const runner = new SpawnGitCommandRunner({
      spawn: spawnFn as never,
      authToken: () => 'secret-token',
    });

    await runner.run(['fetch', 'origin'], { cwd: '/tmp/repo' });

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('git');
    expect(calls[0].args).toEqual([
      '-c',
      'http.extraHeader=Authorization: Bearer secret-token',
      'fetch',
      'origin',
    ]);
  });

  it('omits the config override entirely when no token is available', async () => {
    const { spawnFn, calls } = fakeSpawn(0, 'ok', '');
    const runner = new SpawnGitCommandRunner({ spawn: spawnFn as never });

    await runner.run(['worktree', 'list'], { cwd: '/tmp/repo' });

    expect(calls[0].args).toEqual(['worktree', 'list']);
  });

  it('resolves with stdout, stderr, and exit code on any exit (never throws itself)', async () => {
    const { spawnFn } = fakeSpawn(1, 'partial output', 'fatal: not a git repository');
    const runner = new SpawnGitCommandRunner({ spawn: spawnFn as never });

    const result = await runner.run(['status'], { cwd: '/tmp/repo' });

    expect(result).toEqual({ stdout: 'partial output', stderr: 'fatal: not a git repository', exitCode: 1 });
  });

  it('runs with the given cwd', async () => {
    const { spawnFn, calls } = fakeSpawn(0, '', '');
    const runner = new SpawnGitCommandRunner({ spawn: spawnFn as never });

    await runner.run(['status'], { cwd: '/tmp/some-repo' });

    expect((calls[0].options as { cwd: string }).cwd).toBe('/tmp/some-repo');
  });

  it('resolves (never hangs, never throws) when the process itself fails to spawn', async () => {
    const spawnFn = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        child.emit('error', new Error('spawn git ENOENT'));
      });
      return child;
    });
    const runner = new SpawnGitCommandRunner({ spawn: spawnFn as never });

    const result = await runner.run(['status'], { cwd: '/does/not/exist' });

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('spawn git ENOENT');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/activities/src/workspace/spawn-git-command-runner.test.ts`
Expected: FAIL — `Cannot find module './spawn-git-command-runner'`.

- [ ] **Step 3: Implement**

```ts
// packages/activities/src/workspace/spawn-git-command-runner.ts
import { spawn as nodeSpawn } from 'node:child_process';
import type { GitCommandResult, GitCommandRunner } from '@agentops/ports';

export interface SpawnGitCommandRunnerOptions {
  spawn?: typeof nodeSpawn;
  authToken?: () => string | undefined;
}

export class SpawnGitCommandRunner implements GitCommandRunner {
  private readonly spawnFn: typeof nodeSpawn;
  private readonly authToken?: () => string | undefined;

  constructor(opts: SpawnGitCommandRunnerOptions = {}) {
    this.spawnFn = opts.spawn ?? nodeSpawn;
    this.authToken = opts.authToken;
  }

  async run(args: string[], opts: { cwd: string }): Promise<GitCommandResult> {
    const token = this.authToken?.();
    const fullArgs = token
      ? ['-c', `http.extraHeader=Authorization: Bearer ${token}`, ...args]
      : [...args];

    return new Promise((resolve) => {
      const child = this.spawnFn('git', fullArgs, { cwd: opts.cwd });
      let stdout = '';
      let stderr = '';
      let settled = false;
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      // A bad cwd or a missing `git` binary emits 'error' instead of 'close' — without
      // this handler the returned promise would hang forever instead of resolving.
      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        resolve({ stdout, stderr: stderr + err.message, exitCode: -1 });
      });
      child.on('close', (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        resolve({ stdout, stderr, exitCode: exitCode ?? -1 });
      });
    });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/activities/src/workspace/spawn-git-command-runner.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/activities/src/workspace/spawn-git-command-runner.ts packages/activities/src/workspace/spawn-git-command-runner.test.ts
git commit -m "feat(activities): add SpawnGitCommandRunner with centralized auth injection"
```

---

### Task 3: `WorkspaceManager` — real base-clone-cache + per-task worktree

**Files:**
- Create: `packages/activities/src/workspace/workspace-manager.ts`
- Test: `packages/activities/src/workspace/workspace-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

These use a *real* `SpawnGitCommandRunner` (no injected fake) against real temporary git repos — git's own behavior (worktrees, `origin/HEAD`) is what's under test.

```ts
// packages/activities/src/workspace/workspace-manager.test.ts
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
  const manager = new WorkspaceManager({ git: recording, cacheDir, workspacesDir, cloneUrl: () => remoteDir });
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
    const manager = new WorkspaceManager({ git, cacheDir, workspacesDir, cloneUrl: () => remoteDir });

    await manager.prepare('task-1', 'owner/repo');

    const config = readFileSync(join(cacheDir, 'owner-repo', '.git', 'config'), 'utf8');
    expect(config).not.toContain('super-secret');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/activities/src/workspace/workspace-manager.test.ts`
Expected: FAIL — `Cannot find module './workspace-manager'`.

- [ ] **Step 3: Implement**

```ts
// packages/activities/src/workspace/workspace-manager.ts
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
```

(`mkdir` with `recursive: true` on an already-existing directory is a no-op, not an error — safe to call on every `prepare`. `cwd: this.cacheDir` on the `clone` call needs `cacheDir` itself to already exist so git can create `cachePath` inside it, which the `mkdir` calls above guarantee.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/activities/src/workspace/workspace-manager.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/activities/src/workspace/workspace-manager.ts packages/activities/src/workspace/workspace-manager.test.ts
git commit -m "feat(activities): add WorkspaceManager (base-clone cache + per-task git worktree)"
```

---

### Task 4: `MemoryWorkspaceManager` — fake for tests/e2e

**Files:**
- Create: `packages/activities/src/workspace/memory-workspace-manager.ts`
- Test: `packages/activities/src/workspace/memory-workspace-manager.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/activities/src/workspace/memory-workspace-manager.test.ts
import { describe, expect, it } from 'vitest';
import { MemoryWorkspaceManager } from './memory-workspace-manager';

describe('MemoryWorkspaceManager', () => {
  it('returns a deterministic fake workspace without touching the filesystem', async () => {
    const manager = new MemoryWorkspaceManager();

    const result = await manager.prepare('task-1', 'owner/repo');

    expect(result).toEqual({
      workspaceRef: 'memory://owner/repo/task-1',
      branch: 'agentops/task-1',
      baseBranch: 'main',
    });
  });

  it('tracks which workspaceRefs have been prepared and cleaned up', async () => {
    const manager = new MemoryWorkspaceManager();
    const { workspaceRef } = await manager.prepare('task-1', 'owner/repo');

    expect(manager.isPrepared(workspaceRef)).toBe(true);
    expect(manager.isCleanedUp(workspaceRef)).toBe(false);

    await manager.cleanup(workspaceRef, 'owner/repo');

    expect(manager.isCleanedUp(workspaceRef)).toBe(true);
  });

  it('throws if cleanup is called on a workspaceRef that was never prepared', async () => {
    const manager = new MemoryWorkspaceManager();
    await expect(manager.cleanup('memory://never/prepared', 'owner/repo')).rejects.toThrow(/never prepared/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/activities/src/workspace/memory-workspace-manager.test.ts`
Expected: FAIL — `Cannot find module './memory-workspace-manager'`.

- [ ] **Step 3: Implement**

```ts
// packages/activities/src/workspace/memory-workspace-manager.ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/activities/src/workspace/memory-workspace-manager.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Export both from the activities barrel**

Modify `packages/activities/src/index.ts`:

```ts
export * from './stats-store';
export * from './stage-result-store';
export * from './create-activities';
export * from './workspace/spawn-git-command-runner';
export * from './workspace/workspace-manager';
export * from './workspace/memory-workspace-manager';
```

- [ ] **Step 6: Commit**

```bash
git add packages/activities/src/workspace/memory-workspace-manager.ts packages/activities/src/workspace/memory-workspace-manager.test.ts packages/activities/src/index.ts
git commit -m "feat(activities): add MemoryWorkspaceManager test double"
```

---

### Task 5: `ScmPort.push` gains `workspaceRef`

**Files:**
- Modify: `packages/ports/src/scm-port.ts`
- Modify: `packages/ports/src/memory/memory-scm.ts`
- Modify: `packages/ports/src/memory/memory-scm.test.ts`

- [ ] **Step 1: Add the failing test**

`packages/ports/src/memory/memory-scm.test.ts` has no `push` test today. Add one as the last `it(...)` inside the existing `describe('MemoryScmPort', ...)` block, right after the `readFile returns seeded content` test:

```ts
  it('push accepts and ignores a workspaceRef (real git happens in the real adapter, not here)', async () => {
    const scm = new MemoryScmPort();
    await expect(scm.push('/some/workspace/path', 'branch-x', 'hash-x')).resolves.toBeUndefined();
  });
```

- [ ] **Step 2: Run the test to verify it fails on the type/signature**

Run: `pnpm --filter @agentops/ports run typecheck`
Expected: FAIL — `Expected 2 arguments, but got 3` (or similar) since `push` doesn't accept 3 args yet.

- [ ] **Step 3: Update the interface and implementation**

Modify `packages/ports/src/scm-port.ts`:

```ts
export interface ScmPort {
  openPr(req: OpenPrRequest): Promise<OpenPrResult>;
  getPrFeedback(prRef: string): Promise<PrFeedback>;
  push(workspaceRef: string, branch: string, contentHash: string): Promise<void>;
  readFile(repo: string, path: string): Promise<string | null>;
}
```

Modify `packages/ports/src/memory/memory-scm.ts` — change the `push` method signature (body stays a no-op):

```ts
  async push(_workspaceRef: string, _branch: string, _contentHash: string): Promise<void> {}
```

- [ ] **Step 4: Run tests and typecheck to verify they pass**

Run: `pnpm --filter @agentops/ports run typecheck && pnpm exec vitest run packages/ports/src/memory/memory-scm.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ports/src/scm-port.ts packages/ports/src/memory/memory-scm.ts packages/ports/src/memory/memory-scm.test.ts
git commit -m "feat(ports): ScmPort.push takes a workspaceRef"
```

---

### Task 6: Wire `prepareWorkspace`/`cleanupWorkspace` activities and the new `push` signature through `packages/activities`

**Files:**
- Modify: `packages/workflows/src/activities-api.ts`
- Modify: `packages/activities/src/create-activities.ts`
- Modify: `packages/activities/src/create-activities.test.ts`

- [ ] **Step 1: Update the failing tests first**

`packages/activities/src/create-activities.test.ts` currently builds deps without a `workspaces` field and calls `activities.pushBranch('branch', 'hash')` with two arguments. Update `buildDeps()` and the two call sites:

```ts
// packages/activities/src/create-activities.test.ts
import { describe, expect, it } from 'vitest';
import { StubBackend } from '@agentops/backends';
import { MemoryTrackerPort, MemoryScmPort } from '@agentops/ports';
import { createActivities } from './create-activities';
import { InMemoryStatsStore } from './stats-store';
import { InMemoryStageResultStore } from './stage-result-store';
import { MemoryWorkspaceManager } from './workspace/memory-workspace-manager';

function buildDeps() {
  return {
    backends: { stub: new StubBackend() },
    tracker: new MemoryTrackerPort(),
    scm: new MemoryScmPort(),
    stats: new InMemoryStatsStore(),
    stageResults: new InMemoryStageResultStore(),
    workspaces: new MemoryWorkspaceManager(),
  };
}
```

(leave the rest of the file's existing tests as-is except the two changes below)

Change the `openPr/getPrFeedback/pushBranch` test's `pushBranch` call:

```ts
    await expect(activities.pushBranch('/some/workspace', 'branch', 'hash')).resolves.toBeUndefined();
```

Add a new test:

```ts
describe('createActivities — workspace lifecycle', () => {
  it('prepareWorkspace and cleanupWorkspace delegate to the workspaces dependency', async () => {
    const deps = buildDeps();
    const activities = createActivities(deps);

    const prepared = await activities.prepareWorkspace({ taskId: 't1', repo: 'owner/repo' });
    expect(prepared).toEqual({ workspaceRef: 'memory://owner/repo/t1', branch: 'agentops/t1', baseBranch: 'main' });

    await activities.cleanupWorkspace(prepared.workspaceRef, 'owner/repo');
    expect((deps.workspaces as MemoryWorkspaceManager).isCleanedUp(prepared.workspaceRef)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/activities/src/create-activities.test.ts`
Expected: FAIL — `activities.prepareWorkspace is not a function`, and a typecheck error on `buildDeps()` missing `workspaces` once `ActivityDependencies` is updated (do Step 3 first if your editor flags it before you run tests).

- [ ] **Step 3: Update `DevCycleActivities`**

Modify `packages/workflows/src/activities-api.ts`:

```ts
import type { AgentRunRequest, AgentRunResult, PrFeedback, RunStats, StageResult } from '@agentops/contracts';

export interface Issue {
  ref: string;
  title: string;
  body: string;
  labels: string[];
}

export interface OpenPrRequest {
  repo: string;
  branch: string;
  title: string;
  body: string;
}

export interface OpenPrResult {
  prRef: string;
  url: string;
}

export interface StageResultRecord extends StageResult {
  taskId: string;
}

export interface PreparedWorkspace {
  workspaceRef: string;
  branch: string;
  baseBranch: string;
}

export interface DevCycleActivities {
  runAgent(req: AgentRunRequest): Promise<AgentRunResult>;
  getIssue(ref: string): Promise<Issue>;
  commentOnIssue(ref: string, body: string): Promise<void>;
  labelIssue(ref: string, label: string): Promise<void>;
  openPr(req: OpenPrRequest): Promise<OpenPrResult>;
  getPrFeedback(prRef: string): Promise<PrFeedback>;
  pushBranch(workspaceRef: string, branch: string, contentHash: string): Promise<void>;
  recordStageResult(result: StageResultRecord): Promise<void>;
  recordRunStats(stats: RunStats): Promise<void>;
  prepareWorkspace(req: { taskId: string; repo: string }): Promise<PreparedWorkspace>;
  cleanupWorkspace(workspaceRef: string, repo: string): Promise<void>;
}
```

- [ ] **Step 4: Update `createActivities`**

Modify `packages/activities/src/create-activities.ts`:

```ts
import type { AgentBackend } from '@agentops/backends';
import type { Issue, OpenPrRequest, OpenPrResult, ScmPort, TrackerPort } from '@agentops/ports';
import type { AgentRunRequest, AgentRunResult, PrFeedback, RunStats } from '@agentops/contracts';
import type { StageResultRecord, StageResultStore } from './stage-result-store';
import type { StatsStore } from './stats-store';
import type { PreparedWorkspace, Workspaces } from './workspace/workspace-manager';

export interface ActivityDependencies {
  backends: Record<string, AgentBackend>;
  tracker: TrackerPort;
  scm: ScmPort;
  stats: StatsStore;
  stageResults: StageResultStore;
  workspaces: Workspaces;
}

export function createActivities(deps: ActivityDependencies) {
  return {
    async runAgent(req: AgentRunRequest): Promise<AgentRunResult> {
      const backend = deps.backends[req.backend];
      if (!backend) {
        throw new Error(`createActivities.runAgent: unknown backend "${req.backend}"`);
      }
      return backend.run(req);
    },
    async getIssue(ref: string): Promise<Issue> {
      return deps.tracker.getIssue(ref);
    },
    async commentOnIssue(ref: string, body: string): Promise<void> {
      await deps.tracker.comment(ref, body);
    },
    async labelIssue(ref: string, label: string): Promise<void> {
      await deps.tracker.label(ref, label);
    },
    async openPr(req: OpenPrRequest): Promise<OpenPrResult> {
      return deps.scm.openPr(req);
    },
    async getPrFeedback(prRef: string): Promise<PrFeedback> {
      return deps.scm.getPrFeedback(prRef);
    },
    async pushBranch(workspaceRef: string, branch: string, contentHash: string): Promise<void> {
      await deps.scm.push(workspaceRef, branch, contentHash);
    },
    async recordStageResult(result: StageResultRecord): Promise<void> {
      deps.stageResults.record(result);
    },
    async recordRunStats(stats: RunStats): Promise<void> {
      deps.stats.record(stats);
    },
    async prepareWorkspace(req: { taskId: string; repo: string }): Promise<PreparedWorkspace> {
      return deps.workspaces.prepare(req.taskId, req.repo);
    },
    async cleanupWorkspace(workspaceRef: string, repo: string): Promise<void> {
      await deps.workspaces.cleanup(workspaceRef, repo);
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/activities/src/create-activities.test.ts && pnpm --filter @agentops/workflows run typecheck && pnpm --filter @agentops/activities run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/workflows/src/activities-api.ts packages/activities/src/create-activities.ts packages/activities/src/create-activities.test.ts
git commit -m "feat(activities): wire prepareWorkspace/cleanupWorkspace activities, extend pushBranch"
```

---

### Task 7: Wire `dev-cycle.ts` for real `workspaceRef`/`branch` and terminal-state cleanup

**Files:**
- Modify: `packages/workflows/src/dev-cycle.ts`

- [ ] **Step 1: Update `DevCycleState` and add workspace prep at the top of `devCycle`**

In `packages/workflows/src/dev-cycle.ts`, add two fields to `DevCycleState`:

```ts
export interface DevCycleState {
  taskId: string;
  stage: Stage;
  status: TaskStatus;
  blockReason: BlockReason | null;
  implementAttempts: number;
  iterations: number;
  cumulativeTokens: number;
  babysitRounds: number;
  prRef: string | null;
  workspaceRef: string;
  branch: string;
}
```

Immediately after `const state: DevCycleState = { ... }` is constructed (before `let cancelled = false;`), initialize the two new fields as empty strings so the object literal above stays valid TypeScript, then overwrite them right after workspace prep:

```ts
  const state: DevCycleState = {
    taskId: input.taskId,
    stage: 'context',
    status: 'running',
    blockReason: null,
    implementAttempts: 0,
    iterations: 0,
    cumulativeTokens: 0,
    babysitRounds: 0,
    prRef: null,
    workspaceRef: '',
    branch: '',
  };

  const prepared = await activities.prepareWorkspace({ taskId: input.taskId, repo: input.repo });
  state.workspaceRef = prepared.workspaceRef;
  state.branch = prepared.branch;
```

Place this `prepareWorkspace` call right after the `state` object is constructed, before the signal handlers are registered (workspace prep has no interaction with signals/cancellation — it's a one-time setup step every task needs regardless).

- [ ] **Step 2: Replace every `workspaceRef: input.repo` with `workspaceRef: state.workspaceRef`**

In `runStageAgent`, change:

```ts
      workspaceRef: input.repo,
```

to:

```ts
      workspaceRef: state.workspaceRef,
```

(There is exactly one occurrence, inside `runStageAgent`'s `activities.runAgent({...})` call.)

- [ ] **Step 3: Replace the inline branch computation and every `pushBranch`/`openPr` call site**

Delete this line (currently right before `state.stage = 'pr'`):

```ts
  const branch = `agentops/${input.taskId}`;
```

Change the `openPr` call from:

```ts
  const { prRef } = await activities.openPr({
    repo: input.repo,
    branch,
    title: input.goal,
    body: prBody,
  });
```

to:

```ts
  const { prRef } = await activities.openPr({
    repo: input.repo,
    branch: state.branch,
    title: input.goal,
    body: prBody,
  });
```

Change the babysit loop's push call from:

```ts
      await activities.pushBranch(branch, `${input.taskId}-${implementAttempt}`);
```

to:

```ts
      await activities.pushBranch(state.workspaceRef, state.branch, `${input.taskId}-${implementAttempt}`);
```

- [ ] **Step 4: Add workspace cleanup at each terminal `return state` exit point**

`dev-cycle.ts` currently returns `state` from five places: three `cancelled` checks (the `preImplementStages` loop, the repair-loop's brake-wait, and the `pr_babysit` loop's brake-wait), the `stopRequested` pending path, and the final `done` return. Every `cancelled`/`done` exit needs a cleanup call added; `stopRequested` does not (see below).

Replace every occurrence of:

```ts
      state.stage = 'failed';
      state.status = 'failed';
      return state;
```

with:

```ts
      state.stage = 'failed';
      state.status = 'failed';
      await activities.cleanupWorkspace(state.workspaceRef, input.repo);
      return state;
```

(There are three occurrences: one in the `preImplementStages` loop, one after `waitForResumeOrCancel()` returns `true` in the repair loop's brake-wait, and one in the `pr_babysit` loop's brake-wait — apply the same change at all three.)

Leave the `stopRequested` → `pending` return **unchanged** (no cleanup call — the workspace must survive for an eventual `resume`):

```ts
    if (stopRequested) {
      state.status = 'pending';
      return state;
    }
```

Add cleanup before the final success return:

```ts
  state.stage = 'done';
  state.status = 'done';
  await activities.cleanupWorkspace(state.workspaceRef, input.repo);
  return state;
```

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @agentops/workflows run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/workflows/src/dev-cycle.ts
git commit -m "feat(workflows): wire real workspaceRef/branch through DevCycle, cleanup on terminal states"
```

---

### Task 8: Update e2e test scaffolding for the new `workspaces` dependency

**Files:**
- Modify: `e2e/helpers.ts`

- [ ] **Step 1: Update `buildTestEnv`**

Modify `e2e/helpers.ts`:

```ts
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { WorkflowHandle } from '@temporalio/client';
import {
  createActivities,
  InMemoryStageResultStore,
  InMemoryStatsStore,
  MemoryWorkspaceManager,
} from '@agentops/activities';
import { StubBackend } from '@agentops/backends';
import { MemoryScmPort, MemoryTrackerPort } from '@agentops/ports';
import type { DevCycleActivities, DevCycleState } from '@agentops/workflows';
import { createWorker } from '@agentops/worker';

export interface TestEnv {
  env: TestWorkflowEnvironment;
  worker: Worker;
  stub: StubBackend;
  tracker: MemoryTrackerPort;
  scm: MemoryScmPort;
  stats: InMemoryStatsStore;
  stageResults: InMemoryStageResultStore;
  workspaces: MemoryWorkspaceManager;
  taskQueue: string;
}

let counter = 0;

export function nextTaskQueue(): string {
  counter += 1;
  return `agentops-devcycle-test-${counter}`;
}

export async function buildTestEnv(): Promise<TestEnv> {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const stub = new StubBackend();
  const tracker = new MemoryTrackerPort();
  const scm = new MemoryScmPort();
  const stats = new InMemoryStatsStore();
  const stageResults = new InMemoryStageResultStore();
  const workspaces = new MemoryWorkspaceManager();

  const activities: DevCycleActivities = createActivities({
    backends: { stub },
    tracker,
    scm,
    stats,
    stageResults,
    workspaces,
  });

  const taskQueue = nextTaskQueue();
  const worker = await createWorker({
    taskQueue,
    activities,
    connection: env.nativeConnection,
  });

  return { env, worker, stub, tracker, scm, stats, stageResults, workspaces, taskQueue };
}

export async function waitForStatus(
  handle: WorkflowHandle<(input: never) => Promise<DevCycleState>>,
  statuses: DevCycleState['status'][],
  timeoutMs = 30_000,
): Promise<DevCycleState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await handle.query('state');
    if (statuses.includes(state.status)) {
      return state as DevCycleState;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for status in [${statuses.join(', ')}]`);
}
```

- [ ] **Step 2: Run the full e2e suite to confirm nothing broke**

Run: `pnpm e2e`
Expected: PASS — all four existing scenarios (happy-path, brake-and-rescue, garbage-verdict, exhausted-rounds) still green. They don't assert anything about `workspaceRef` content, so a fake `memory://...` value flowing through is invisible to them; this is the regression check.

- [ ] **Step 3: Commit**

```bash
git add e2e/helpers.ts
git commit -m "test(e2e): wire MemoryWorkspaceManager into the shared test environment"
```

---

### Task 9: Add e2e coverage for workspace prepare/cleanup lifecycle

**Files:**
- Modify: `e2e/happy-path.e2e.test.ts`

- [ ] **Step 1: Add the failing assertions**

Add to the end of the `it(...)` block in `e2e/happy-path.e2e.test.ts` (after the existing `expect` calls):

```ts
    expect(testEnv.workspaces.isPrepared(finalState.workspaceRef)).toBe(true);
    expect(testEnv.workspaces.isCleanedUp(finalState.workspaceRef)).toBe(true);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run --config vitest.e2e.config.ts e2e/happy-path.e2e.test.ts`
Expected: FAIL if Task 7's cleanup wiring has a bug (e.g. cleanup called with the wrong ref) — otherwise this should already PASS, since Task 7 already wired cleanup. Either outcome is informative: if it fails, it caught a real wiring bug worth fixing before moving on.

- [ ] **Step 3: Fix forward if it failed, otherwise confirm it passes**

Run: `pnpm e2e`
Expected: PASS — all four e2e scenarios green, including the two new assertions.

- [ ] **Step 4: Commit**

```bash
git add e2e/happy-path.e2e.test.ts
git commit -m "test(e2e): assert workspace prepare/cleanup lifecycle on the happy path"
```

---

### Task 10: Full local verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full gate**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e
```

Expected: all green. `pnpm lint`'s `import/no-restricted-paths` rule should pass — `dev-cycle.ts` still only calls `activities.*` (proxied), never imports `@agentops/activities`/`@agentops/ports` directly.

- [ ] **Step 2: Commit if the gate required any fixes**

```bash
git add -A
git commit -m "chore: fix lint/typecheck fallout from worktree activities"
```

(Skip this step entirely if Step 1 was already green with no changes needed.)

---

### Task 11: Open the PR, pass CI, and resolve the Bugbot review

**Files:** none (integration / review).

> Sequential and partly asynchronous — CI and Bugbot run on the remote PR.
> **HARD GATE: Do not mark this task complete until ALL Bugbot comments are
> resolved (fixed or replied to) AND CI is green. Check with
> `gh pr view --json reviews,comments` before claiming done.**

- [ ] **Step 1: Sync the latest `main`**

```bash
git fetch origin
git merge origin/main
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e   # resolve conflicts + commit first if any; fix fallout
```

- [ ] **Step 2: Push and open the PR**

```bash
git status --short && git rev-parse --abbrev-ref HEAD   # clean tree, on feature branch (not main)
git push -u origin HEAD
gh pr create --base main --fill --title "feat: real git worktree workspaces for DevCycle"
```

- [ ] **Step 3: Subagent code review**

REQUIRED SUB-SKILL: `requesting-code-review`. Dispatch a code reviewer subagent (BASE_SHA = merge-base with `main`, HEAD_SHA = HEAD). Fix Critical and Important findings, commit, push, then proceed.

- [ ] **Step 4: Make every CI check pass**

```bash
gh pr checks --watch
```
On failure: `gh run view --log-failed`, reproduce locally, fix, commit, push, re-watch. Do not proceed while red.

- [ ] **Step 5: Wait for the Bugbot review**

```bash
gh pr view --json reviews,comments
gh pr comment --body "bugbot run"   # only if it hasn't reviewed yet
```

- [ ] **Step 6: Address each Bugbot comment**

REQUIRED SUB-SKILL: `receiving-code-review`. Verify before acting — reply to false positives; TDD-fix real findings, commit each referencing the finding, push once.

**Then mark each addressed thread resolved** (completion is gated on the unresolved-thread count, not just on having replied/fixed):

```bash
gh api graphql -f query='query($o:String!,$r:String!,$p:Int!){repository(owner:$o,name:$r){pullRequest(number:$p){reviewThreads(first:100){nodes{id isResolved path comments(first:1){nodes{body}}}}}}}' -F o=<owner> -F r=<repo> -F p=<number>
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=<thread-id>
```

**After pushing:** return to Step 4 (re-watch CI), then Step 5 (wait for re-review). Loop until Bugbot reports no unresolved comments.

- [ ] **Step 7: Final verification**

```bash
gh pr checks                          # all green
gh pr view --json reviews,comments    # no comment left unaddressed
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e   # suite green locally
```
Confirm no unresolved review threads remain, then mark this task complete.
