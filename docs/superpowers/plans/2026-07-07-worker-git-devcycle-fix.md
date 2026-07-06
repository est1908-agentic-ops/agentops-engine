# Worker Missing `git` — devCycle Blocker Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unblock `devCycle` on the live cluster. `prepareWorkspace` has been retrying forever with `WorkspaceError: git clone failed ... spawn git ENOENT` because `images/worker/Dockerfile` never installs `git` — confirmed by shelling into the running `worker:c06b276` image (`command -v git` → not found). Fix the image, audit `agent-runner` for the same gap, stop deterministic failures from retrying forever, and confirm the `agentops.json` 404 path is genuinely optional.

**Architecture:** The worker container (packages/worker) is the *only* place that shells out to `git` — `WorkspaceManager` (clone/fetch/worktree) and `GithubScmPort.push` both run as Temporal activities inside it (`packages/worker/src/main.ts:52,57`). `images/agent-runner/Dockerfile` already installs `git ca-certificates` (added for the coding-agent CLIs' own tool use) and neither `push` nor `openPr` ever run inside that container, so it needs no change — Task 2 documents that audit rather than touching the file. For "deterministic failures fail fast," this plan does *not* add a blanket bounded `maximumAttempts` to the workflow's `proxyActivities` call — that would also cut off legitimate retry-with-backoff for transient failures on activities like `openPr`/`pushBranch` (GitHub rate limits, network blips), which is undocumented scope creep beyond what broke. Instead it distinguishes, at the source, a spawn-level failure (the `git` binary itself couldn't be launched — never fixed by retrying) from an ordinary non-zero git exit (could be transient) and marks only the former as a Temporal `ApplicationFailure.nonRetryable`.

**Tech Stack:** Node 22, TypeScript strict, Temporal TS SDK (`@temporalio/common` for `ApplicationFailure`), vitest, Docker.

**Already correct, no task needed:** the "Secondary (verify)" item in the report — `agentops.json` returning 404 — is already handled correctly: `GithubScmPort.readFile` (`packages/ports/src/github/github-scm-port.ts:85-96`) catches a 404 and returns `null`; `loadTaskConfig` (`packages/gateway/src/load-task-config.ts:11-15`) treats `null` as "use `parseProductConfig({})`", which merges every field against `DEFAULT_PRODUCT_CONFIG` (`packages/contracts/src/product-config.ts`). This is already covered by `packages/gateway/src/load-task-config.test.ts`'s `'fully defaults when agentops.json is absent'` test. Task 6 re-runs that test and traces the code path as the requested confirmation — no code changes.

---

## File Structure

| File | Responsibility |
|---|---|
| `images/worker/Dockerfile` | **The blocker fix** — installs `git` + `ca-certificates` so `SpawnGitCommandRunner` can actually spawn `git`. |
| `packages/ports/src/git/git-command-runner.ts` | `GitCommandResult` gains an optional `spawnFailed` flag — true only when the child process itself couldn't be launched. |
| `packages/activities/src/workspace/spawn-git-command-runner.ts` | Sets `spawnFailed: true` on the `child.on('error', ...)` path (missing/unspawnable binary), never on a normal non-zero exit. |
| `packages/activities/src/workspace/spawn-git-command-runner.test.ts` | Asserts `spawnFailed` is set on a spawn error and absent on an ordinary failing exit. |
| `packages/activities/src/workspace/workspace-manager.ts` | `WorkspaceError` gains a `nonRetryable` flag, set from the triggering `GitCommandResult.spawnFailed`. |
| `packages/activities/src/workspace/workspace-manager.test.ts` | Asserts `prepare()` throws a non-retryable `WorkspaceError` on a spawn failure and a retryable one on an ordinary git failure. |
| `packages/activities/src/create-activities.ts` | `prepareWorkspace`/`cleanupWorkspace` catch a non-retryable `WorkspaceError` and rethrow as `ApplicationFailure.nonRetryable` so Temporal fails the activity immediately instead of retrying forever. |
| `packages/activities/src/create-activities.test.ts` | Asserts the `WorkspaceError` → `ApplicationFailure` translation, and that a retryable `WorkspaceError` still passes through unchanged. |
| `packages/activities/package.json` | Adds the `@temporalio/common` dependency (already used elsewhere in the workspace at `^1.11.0`, e.g. `packages/backends/package.json`'s `@temporalio/activity`). |

No changes to `images/agent-runner/Dockerfile`, `images/gateway/Dockerfile`, `packages/gateway/src/load-task-config.ts`, or any file under `packages/workflows` — see Task 2 and Task 6 for why, and the Architecture note above for why the retry fix stays out of `packages/workflows`.

---

### Task 1: Install `git` + `ca-certificates` in the worker image (THE BLOCKER)

**Files:**
- Modify: `images/worker/Dockerfile`

- [ ] **Step 1: Confirm the current image really lacks `git`**

Read `images/worker/Dockerfile` — it goes straight from `FROM node:22-slim AS runtime` to `RUN npm install --global pnpm@9.15.9` with no `apt-get` step, unlike `images/agent-runner/Dockerfile` which has one. This matches the live-cluster finding (`command -v git` → not found in `worker:c06b276`).

- [ ] **Step 2: Add the same install block `images/agent-runner/Dockerfile` already uses**

Edit `images/worker/Dockerfile`. Replace:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-slim AS runtime

# Baked-in pnpm, not `corepack enable` alone: corepack lazily downloads
# pnpm into the *current user's* cache on first invocation. Building as
# root then running as `node` means two different cache dirs, so a bare
# `corepack enable` re-fetches pnpm from the npm registry on every
# container start -- which the dev-agents NetworkPolicy (GitHub +
# Anthropic + DNS only, see platform-components design) will block.
RUN npm install --global pnpm@9.15.9
```

with:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-slim AS runtime

# prepareWorkspace and GithubScmPort.push shell out to `git` from inside
# this container (packages/activities/src/workspace, packages/ports/src/github)
# — without it, git clone fails with `spawn git ENOENT` and (pre-fix) retries
# forever. See images/agent-runner/Dockerfile for the same pattern.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Baked-in pnpm, not `corepack enable` alone: corepack lazily downloads
# pnpm into the *current user's* cache on first invocation. Building as
# root then running as `node` means two different cache dirs, so a bare
# `corepack enable` re-fetches pnpm from the npm registry on every
# container start -- which the dev-agents NetworkPolicy (GitHub +
# Anthropic + DNS only, see platform-components design) will block.
RUN npm install --global pnpm@9.15.9
```

- [ ] **Step 3: Commit**

```bash
git add images/worker/Dockerfile
git commit -m "fix(worker-image): install git + ca-certificates so prepareWorkspace can clone"
```

(The full build+run verification that `git --version` actually works inside the built image happens in Task 7, once every other change in this plan has landed — no need to build twice.)

---

### Task 2: Audit `agent-runner` for the same gap (verification only — expect no diff)

**Files:** none expected — this task confirms the report's item 2 is already satisfied.

- [ ] **Step 1: Confirm `agent-runner` already installs `git`**

```bash
sed -n '1,20p' images/agent-runner/Dockerfile
```

Expected: lines 11-13 already contain

```dockerfile
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 2: Confirm push/PR-opening never runs inside `agent-runner`**

```bash
grep -n "class GithubScmPort" -A2 packages/ports/src/github/github-scm-port.ts
grep -n "SpawnGitCommandRunner\|createGithubPorts" packages/worker/src/main.ts
```

Expected findings to record in the PR description: `GithubScmPort.push` (git CLI) and `.openPr` (REST API) are both wired up in `packages/worker/src/main.ts:52-57` (`buildActivityDependencies`) and invoked only from `packages/activities/src/create-activities.ts`'s `pushBranch`/`openPr` — i.e. only inside the **worker** container. `agent-runner` (`K8sJobRunner`/`ProcessCliRunner` in `packages/backends/src/k8s/k8s-job-runner.ts` and `packages/backends/src/process-cli-runner.ts`) only ever spawns the configured CLI binary (`claude` or `pi`); there is no `git`/`push`/`commit` call anywhere in `packages/backends/src`.

- [ ] **Step 3: Note the conclusion in the PR description**

No code change: `agent-runner` already ships `git` (for the coding-agent CLI's own tool use inside the workspace) and never performs the push/PR step that the report worried about — that happens from the worker, which Task 1 already fixes.

---

### Task 3: Distinguish a spawn failure from an ordinary git failure

**Files:**
- Modify: `packages/ports/src/git/git-command-runner.ts`
- Modify: `packages/activities/src/workspace/spawn-git-command-runner.ts`
- Test: `packages/activities/src/workspace/spawn-git-command-runner.test.ts`

- [ ] **Step 1: Write the failing tests**

Edit `packages/activities/src/workspace/spawn-git-command-runner.test.ts`. In the `'resolves (never hangs, never throws) when the process itself fails to spawn'` test, add an assertion after the existing ones:

```ts
    const result = await runner.run(['status'], { cwd: '/does/not/exist' });

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('spawn git ENOENT');
    expect(result.spawnFailed).toBe(true);
```

Add a new test right after it:

```ts
  it('does not set spawnFailed when git itself runs and merely exits non-zero', async () => {
    const { spawnFn } = fakeSpawn(128, '', 'fatal: could not read Username for https://github.com');
    const runner = new SpawnGitCommandRunner({ spawn: spawnFn as never });

    const result = await runner.run(['fetch', 'origin'], { cwd: '/tmp/repo' });

    expect(result.exitCode).toBe(128);
    expect(result.spawnFailed).toBeUndefined();
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
cd /Users/est1908/.superset/worktrees/agentops-engine/spectrum-witch
pnpm install
pnpm vitest run --config vitest.config.ts packages/activities/src/workspace/spawn-git-command-runner.test.ts
```

Expected: FAIL — `result.spawnFailed` is `undefined` where the first new assertion expects `true` (`spawnFailed` doesn't exist yet on `GitCommandResult`).

- [ ] **Step 3: Add the field to the shared type**

Edit `packages/ports/src/git/git-command-runner.ts`:

```ts
export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  // True only when the child process itself could not be spawned (e.g. the
  // `git` binary is missing) — as opposed to git running and exiting
  // non-zero. Lets callers tell a permanent environment defect (retrying
  // won't help) apart from a transient failure (e.g. a network blip during
  // clone/fetch), which should still retry.
  spawnFailed?: boolean;
}

export interface GitCommandRunner {
  run(args: string[], opts: { cwd: string }): Promise<GitCommandResult>;
}
```

- [ ] **Step 4: Set the flag on the spawn-error path only**

Edit `packages/activities/src/workspace/spawn-git-command-runner.ts`. Replace:

```ts
      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        resolve({ stdout, stderr: stderr + err.message, exitCode: -1 });
      });
```

with:

```ts
      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        resolve({ stdout, stderr: stderr + err.message, exitCode: -1, spawnFailed: true });
      });
```

Leave the `child.on('close', ...)` handler untouched — it never sets `spawnFailed`, so it stays `undefined` for an ordinary exit.

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
pnpm vitest run --config vitest.config.ts packages/activities/src/workspace/spawn-git-command-runner.test.ts
```

Expected: PASS, all tests including the two new assertions.

- [ ] **Step 6: Commit**

```bash
git add packages/ports/src/git/git-command-runner.ts packages/activities/src/workspace/spawn-git-command-runner.ts packages/activities/src/workspace/spawn-git-command-runner.test.ts
git commit -m "feat(git-command-runner): flag results where the git binary itself failed to spawn"
```

---

### Task 4: Make `WorkspaceError` carry a non-retryable flag

**Files:**
- Modify: `packages/activities/src/workspace/workspace-manager.ts`
- Test: `packages/activities/src/workspace/workspace-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

Edit `packages/activities/src/workspace/workspace-manager.test.ts`, adding a new `describe` block at the end of the file (after the existing `describe('WorkspaceManager', ...)` block closes):

```ts
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
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
pnpm vitest run --config vitest.config.ts packages/activities/src/workspace/workspace-manager.test.ts
```

Expected: FAIL — `WorkspaceError` has no `nonRetryable` property yet (`rejects.toMatchObject` fails because the field is `undefined` vs. expected `true`/`false`).

- [ ] **Step 3: Add the flag to `WorkspaceError` and thread it through the git-result-based throw sites**

Edit `packages/activities/src/workspace/workspace-manager.ts`. Replace:

```ts
export class WorkspaceError extends Error {}
```

with:

```ts
export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly nonRetryable: boolean = false,
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}
```

Then update every `WorkspaceError` thrown from a `GitCommandResult` to pass its `spawnFailed` through. Replace:

```ts
    if (addResult.exitCode !== 0) {
      throw new WorkspaceError(`git worktree add failed for ${repo}: ${addResult.stderr}`);
    }
```

with:

```ts
    if (addResult.exitCode !== 0) {
      throw new WorkspaceError(`git worktree add failed for ${repo}: ${addResult.stderr}`, addResult.spawnFailed === true);
    }
```

Replace:

```ts
    const result = await git.run(['worktree', 'remove', workspaceRef, '--force'], {
      cwd: cachePath,
    });
    if (result.exitCode !== 0) {
      throw new WorkspaceError(`git worktree remove failed for ${workspaceRef}: ${result.stderr}`);
    }
```

with:

```ts
    const result = await git.run(['worktree', 'remove', workspaceRef, '--force'], {
      cwd: cachePath,
    });
    if (result.exitCode !== 0) {
      throw new WorkspaceError(`git worktree remove failed for ${workspaceRef}: ${result.stderr}`, result.spawnFailed === true);
    }
```

Replace:

```ts
      const fetchResult = await git.run(['fetch', 'origin'], { cwd: cachePath });
      if (fetchResult.exitCode !== 0) {
        throw new WorkspaceError(`git fetch failed for ${repo}: ${fetchResult.stderr}`);
      }
      return;
    }
    const cloneResult = await git.run(['clone', this.cloneUrl(repo), cachePath], { cwd: this.cacheDir });
    if (cloneResult.exitCode !== 0) {
      throw new WorkspaceError(`git clone failed for ${repo}: ${cloneResult.stderr}`);
    }
```

with:

```ts
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
```

Replace:

```ts
    const result = await git.run(['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: cachePath });
    if (result.exitCode !== 0) {
      throw new WorkspaceError(`could not detect default branch in ${cachePath}: ${result.stderr}`);
    }
```

with:

```ts
    const result = await git.run(['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: cachePath });
    if (result.exitCode !== 0) {
      throw new WorkspaceError(`could not detect default branch in ${cachePath}: ${result.stderr}`, result.spawnFailed === true);
    }
```

Leave the last throw in `detectDefaultBranch` (`unexpected symbolic-ref output: "${ref}"`, for a *successful* command with unparseable output) as `nonRetryable = false` (the default) — it isn't a `GitCommandResult` failure and is out of scope for this fix.

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
pnpm vitest run --config vitest.config.ts packages/activities/src/workspace/workspace-manager.test.ts
```

Expected: PASS, including the two new tests.

- [ ] **Step 5: Commit**

```bash
git add packages/activities/src/workspace/workspace-manager.ts packages/activities/src/workspace/workspace-manager.test.ts
git commit -m "feat(workspace-manager): mark WorkspaceError non-retryable on a git spawn failure"
```

---

### Task 5: Fail fast at the activity boundary

**Files:**
- Modify: `packages/activities/package.json`
- Modify: `packages/activities/src/create-activities.ts`
- Test: `packages/activities/src/create-activities.test.ts`

- [ ] **Step 1: Write the failing tests**

Edit `packages/activities/src/create-activities.test.ts`. Add to the imports at the top:

```ts
import { ApplicationFailure } from '@temporalio/common';
import { WorkspaceError } from './workspace/workspace-manager';
```

Add a new `describe` block at the end of the file:

```ts
describe('createActivities — workspace error translation', () => {
  it('converts a non-retryable WorkspaceError into a Temporal ApplicationFailure', async () => {
    const deps = buildDeps();
    deps.workspaces = {
      prepare: async () => {
        throw new WorkspaceError('git clone failed for owner/repo: spawn git ENOENT', true);
      },
      cleanup: async () => {},
    };
    const activities = createActivities(deps);

    const err: unknown = await activities.prepareWorkspace({ taskId: 't1', repo: 'owner/repo' }).catch((e) => e);

    expect(err).toBeInstanceOf(ApplicationFailure);
    expect((err as ApplicationFailure).nonRetryable).toBe(true);
  });

  it('passes a retryable WorkspaceError through unchanged', async () => {
    const deps = buildDeps();
    deps.workspaces = {
      prepare: async () => {
        throw new WorkspaceError('git fetch failed for owner/repo: network unreachable', false);
      },
      cleanup: async () => {},
    };
    const activities = createActivities(deps);

    await expect(activities.prepareWorkspace({ taskId: 't1', repo: 'owner/repo' })).rejects.toThrow(WorkspaceError);
  });

  it('converts a non-retryable WorkspaceError from cleanupWorkspace too', async () => {
    const deps = buildDeps();
    deps.workspaces = {
      prepare: async () => ({ workspaceRef: 'ref', branch: 'b', baseBranch: 'main' }),
      cleanup: async () => {
        throw new WorkspaceError('git worktree remove failed: spawn git ENOENT', true);
      },
    };
    const activities = createActivities(deps);

    const err: unknown = await activities.cleanupWorkspace('ref', 'owner/repo').catch((e) => e);

    expect(err).toBeInstanceOf(ApplicationFailure);
    expect((err as ApplicationFailure).nonRetryable).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
pnpm vitest run --config vitest.config.ts packages/activities/src/create-activities.test.ts
```

Expected: FAIL — `@temporalio/common` isn't a dependency yet (module resolution error) and `prepareWorkspace`/`cleanupWorkspace` don't translate the error yet.

- [ ] **Step 3: Add the dependency**

Edit `packages/activities/package.json`, adding `@temporalio/common` to `dependencies` (matches the `^1.11.0` range already used for `@temporalio/activity`/`@temporalio/worker`/etc. elsewhere in the workspace):

```json
  "dependencies": {
    "dotenv": "^16.6.1",
    "@agentops/contracts": "workspace:*",
    "@agentops/ports": "workspace:*",
    "@agentops/backends": "workspace:*",
    "@agentops/prompts": "workspace:*",
    "@temporalio/common": "^1.11.0"
  }
```

Then install so the lockfile picks it up:

```bash
pnpm install
```

- [ ] **Step 4: Translate the error in `create-activities.ts`**

Edit `packages/activities/src/create-activities.ts`. Replace the import:

```ts
import type { PreparedWorkspace, Workspaces } from './workspace/workspace-manager';
```

with:

```ts
import { WorkspaceError, type PreparedWorkspace, type Workspaces } from './workspace/workspace-manager';
import { ApplicationFailure } from '@temporalio/common';
```

Add a helper above `createActivities`:

```ts
function rethrowWorkspaceError(err: unknown): never {
  if (err instanceof WorkspaceError && err.nonRetryable) {
    throw ApplicationFailure.nonRetryable(err.message, 'WorkspaceError');
  }
  throw err;
}
```

Replace:

```ts
    async prepareWorkspace(req: { taskId: string; repo: string }): Promise<PreparedWorkspace> {
      return deps.workspaces.prepare(req.taskId, req.repo);
    },
    async cleanupWorkspace(workspaceRef: string, repo: string): Promise<void> {
      await deps.workspaces.cleanup(workspaceRef, repo);
    },
```

with:

```ts
    async prepareWorkspace(req: { taskId: string; repo: string }): Promise<PreparedWorkspace> {
      try {
        return await deps.workspaces.prepare(req.taskId, req.repo);
      } catch (err) {
        rethrowWorkspaceError(err);
      }
    },
    async cleanupWorkspace(workspaceRef: string, repo: string): Promise<void> {
      try {
        await deps.workspaces.cleanup(workspaceRef, repo);
      } catch (err) {
        rethrowWorkspaceError(err);
      }
    },
```

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
pnpm vitest run --config vitest.config.ts packages/activities/src/create-activities.test.ts
```

Expected: PASS, including the three new tests.

- [ ] **Step 6: Typecheck the package**

```bash
pnpm --filter @agentops/activities run typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/activities/package.json pnpm-lock.yaml packages/activities/src/create-activities.ts packages/activities/src/create-activities.test.ts
git commit -m "feat(activities): fail fast — convert non-retryable WorkspaceErrors to ApplicationFailure"
```

---

### Task 6: Verify `agentops.json` 404 is genuinely optional (verification only — expect no diff)

**Files:** none expected.

- [ ] **Step 1: Run the existing coverage for the absent-file path**

```bash
pnpm vitest run --config vitest.config.ts packages/gateway/src/load-task-config.test.ts
pnpm vitest run --config vitest.config.ts packages/ports/src/github/github-scm-port.test.ts
```

Expected: PASS. In particular `load-task-config.test.ts`'s `'fully defaults when agentops.json is absent'` test asserts `config.routing.implement` equals the hardcoded default routing — i.e. a 404 truly falls back to `DEFAULT_PRODUCT_CONFIG`, not an empty/broken config.

- [ ] **Step 2: Trace the code path and record it in the PR description**

```bash
sed -n '85,97p' packages/ports/src/github/github-scm-port.ts   # readFile: 404 -> null, anything else -> rethrow
sed -n '1,24p' packages/gateway/src/load-task-config.ts        # null -> parseProductConfig({}) -> full defaults
```

Conclusion to record: no code change — `agentops.json` absence is already handled as "use every default," confirmed by the existing test suite. The gateway's `GET .../contents/agentops.json → 404 then proceeded` log line the report saw is expected behavior, not a silent degradation.

---

### Task 7: Full verification — suites, chart, and the actual fixed image

**Files:** none (verification only).

- [ ] **Step 1: Full local test suite**

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm test:policies-coverage
pnpm e2e
```

Expected: all green. (`pnpm e2e` isn't expected to exercise the new `WorkspaceError`/`ApplicationFailure` path — the e2e suite drives `devCycle` against `MemoryWorkspaceManager`, which never throws `WorkspaceError` — this run just confirms nothing else regressed.)

- [ ] **Step 2: Chart checks (unaffected by this change, but part of the repo's definition of done)**

```bash
helm lint charts/engine
bash charts/engine/tests/run.sh
```

Expected: both pass unchanged.

- [ ] **Step 3: Build the actual worker image and prove `git` works inside it**

```bash
docker build -f images/worker/Dockerfile -t agentops-worker-verify .
docker run --rm agentops-worker-verify git --version
```

Expected: the build succeeds (this also re-validates `pnpm install --frozen-lockfile` against the `pnpm-lock.yaml` committed in Task 5) and `git --version` prints a version string instead of "command not found". This is the direct repro-and-fix of the live-cluster finding (`command -v git` → not found in the pre-fix `worker:c06b276` image).

If Docker isn't available in your environment, skip running it and note that in the PR description — CI's `build-images` job (`.github/workflows/ci.yaml`) builds this same Dockerfile on every PR and will catch a regression.

- [ ] **Step 4: Clean up the local test image**

```bash
docker rmi agentops-worker-verify
```

---

### Task 8: Open the PR, pass CI, and resolve the Bugbot review

**Files:** none (integration / review).

> Sequential and partly asynchronous — CI and Bugbot run on the remote PR.
> **HARD GATE: Do not mark this task complete until ALL Bugbot comments are
> resolved (fixed or replied to) AND CI is green. Check with
> `gh pr view --json reviews,comments` before claiming done.**

- [ ] **Step 1: Sync the latest `main`**

```bash
git fetch origin
git merge origin/main
pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e   # resolve conflicts + commit first if any; fix fallout
```

- [ ] **Step 2: Push and open the PR**

```bash
git status --short && git rev-parse --abbrev-ref HEAD   # clean tree, on feature branch (not main)
git push -u origin HEAD
gh pr create --base main --fill --title "fix(worker-image): install git so prepareWorkspace stops failing with ENOENT"
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
# List unresolved threads, then resolve each addressed one by id:
gh api graphql -f query='query($o:String!,$r:String!,$p:Int!){repository(owner:$o,name:$r){pullRequest(number:$p){reviewThreads(first:100){nodes{id isResolved path comments(first:1){nodes{body}}}}}}}' -F o=<owner> -F r=<repo> -F p=<number>
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=<thread-id>
```

**After pushing:** return to Step 4 (re-watch CI), then Step 5 (wait for re-review). Loop until Bugbot reports no unresolved comments.

- [ ] **Step 7: Final verification**

```bash
gh pr checks                          # all green
gh pr view --json reviews,comments    # no comment left unaddressed
pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e   # suite green locally
```
Confirm no unresolved review threads remain, then mark this task complete.

---

## Post-merge (outside this PR — flag to Artem, not automatable from this sandbox)

Merging to `main` triggers `.github/workflows/ci.yaml`'s `build-images` job, which builds and pushes `worker`/`agent-runner`/`gateway` tagged `github.sha`, then `bump-platform` auto-bumps those tags in the `flair-hr/agentops-platform` GitOps repo — no manual tag bump needed. Once ArgoCD syncs the new tag, per the report's definition of done: re-label an issue in `broccoli-hr/broccoli` with `agentops` and confirm `devCycle` completes and opens a PR. This sandbox has no `kubectl`/cluster access and no `broccoli-hr/broccoli` context, so this final live-cluster confirmation needs to be done by Artem (or a session with cluster access) after the deploy lands.
