# Worktree Activities — Design

Status: draft · 2026-07-03 · Owner: Artem
Milestone: M1, sub-project 4 of 5 (see [claude-backend design](2026-07-03-claude-backend-design.md) for the full decomposition)

## Context

Every `AgentRunRequest.workspaceRef` in `dev-cycle.ts` today is set to `input.repo` — a bare repo identifier, not a filesystem path. That's fine for the `stub` backend (never reads the filesystem) but meaningless for the real `claude` backend, which `spawn`s with `cwd: req.workspaceRef` and needs an actual git checkout to operate on. This sub-project makes `workspaceRef` real: clone-and-worktree management so each task gets an isolated, branch-checked-out directory that persists across all its stage calls and its `pr_babysit` push rounds.

This is the one piece of M1 with no forge dependency at all — it's pure local git plumbing, independent of GitHub ports and config loading. ARCHITECTURE.md §5.4/§5.9 already call out the target shape: "base-clone cache + `git worktree` per task," proven in the vibeteam prototype.

## Goal

An activity-layer `WorkspaceManager` that, given a repo identifier, produces a real local directory with the task's branch checked out — reusing a shared base clone across tasks for the same repo — and cleans it up when the task reaches a terminal state.

## Non-goals

- Object-storage-backed workspaces (ARCHITECTURE.md's multi-node evolution) — local disk only, single worker host, matching M1's "still local" scope.
- Concurrency-safe multi-worker access to the same base clone (see Named risks).
- Anything forge-specific (auth, PR creation) — this package only knows "clone URL + token," supplied by whoever calls it. Credential *sourcing* is [GitHub ports'](2026-07-03-github-ports-design.md) concern; this doc just specifies how the token is passed through to git commands.

## Design

### Shared low-level piece: `GitCommandRunner`

[GitHub ports](2026-07-03-github-ports-design.md)' `push` needs to run `git push` from a real workspace directory too, using the same auth pattern. Rather than each sub-project spawning `git` independently (duplicating the auth-header logic, one place to get it wrong twice), both depend on one small interface. It has to live in `packages/ports`, not here: `packages/ports` depends on nothing but `contracts`, and `packages/activities` (this sub-project) already depends on `packages/ports` — so the interface sits at the lower layer, and this package provides the concrete implementation, which is the correct dependency direction. (`packages/ports` importing a git-spawning class defined in `packages/activities` would be backwards — activities is downstream of ports, never the reverse.)

```ts
// packages/ports/src/git/git-command-runner.ts — the interface only, zero implementation, zero I/O
export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitCommandRunner {
  run(args: string[], opts: { cwd: string }): Promise<GitCommandResult>;
}
```

```ts
// packages/activities/src/workspace/spawn-git-command-runner.ts — the real implementation
export interface SpawnGitCommandRunnerOptions {
  spawn?: typeof import('node:child_process').spawn; // injectable for tests
  authToken?: () => string | undefined;               // read lazily; not this class's job to source it
}

export class SpawnGitCommandRunner implements GitCommandRunner {
  constructor(opts?: SpawnGitCommandRunnerOptions);
  async run(args: string[], opts: { cwd: string }): Promise<GitCommandResult>;
}
```

**Auth is centralized inside `SpawnGitCommandRunner.run`, not left to each call site.** Every invocation prepends a per-call config override when a token is available — `git -c http.extraHeader="Authorization: Bearer <token>" <args>` — before anything else in `args`. `-c` overrides are process-scoped; they never get written into `.git/config`, so the long-lived shared base clone never ends up with a plaintext token sitting in it (unlike embedding the token in the remote URL, `https://<token>@github.com/...`, which would persist indefinitely). Centralizing this inside the runner itself — rather than requiring `WorkspaceManager` and `GithubScmPort` to each remember to add it correctly — means there's exactly one place this can be gotten wrong, not two.

One `SpawnGitCommandRunner` instance is constructed at worker/CLI startup (with `authToken: () => process.env.GITHUB_TOKEN`) and shared between `WorkspaceManager` (this doc) and `GithubScmPort` (GitHub ports doc) — the exact wiring call site is the shared M1 integration step both docs already defer.

### New module: `packages/activities/src/workspace/`

```
packages/activities/src/workspace/
  spawn-git-command-runner.ts   # SpawnGitCommandRunner (above)
  workspace-manager.ts          # WorkspaceManager class
  workspace-manager.test.ts
  spawn-git-command-runner.test.ts
```

```ts
export interface WorkspaceManagerOptions {
  git: GitCommandRunner;  // injected — see above; same instance GithubScmPort uses for push
  cacheDir?: string;      // default: ~/.agentops/cache  (shared base clones, one per repo)
  workspacesDir?: string; // default: ~/.agentops/workspaces  (one dir per taskId)
  cloneUrl: (repo: string) => string;  // e.g. repo "owner/name" -> "https://github.com/owner/name.git"
}

export interface PreparedWorkspace {
  workspaceRef: string; // absolute path to the task's worktree
  branch: string;       // "agentops/<taskId>"
  baseBranch: string;   // detected default branch, e.g. "main"
}

export class WorkspaceManager {
  constructor(opts: WorkspaceManagerOptions);
  prepare(taskId: string, repo: string): Promise<PreparedWorkspace>;
  cleanup(workspaceRef: string): Promise<void>;
}
```

**`prepare(taskId, repo)`:**

1. Resolve `cacheDir/<sanitized repo slug>` as the shared base clone path. If it doesn't exist: `this.git.run(['clone', this.cloneUrl(repo), cachePath], {cwd: cacheDir})`. If it does: `this.git.run(['fetch', 'origin'], {cwd: cachePath})` to bring refs up to date.
2. Read the default branch from the local clone's `refs/remotes/origin/HEAD` (set automatically by `clone`/`fetch`) — no API call, no dependency on GitHub ports.
3. `this.git.run(['worktree', 'add', workspacePath, '-b', 'agentops/<taskId>', 'origin/<baseBranch>'], {cwd: cachePath})`, creating a fresh worktree with a new branch off the latest default branch.
4. Return `{ workspaceRef: workspacePath, branch: "agentops/<taskId>", baseBranch }`.

**`cleanup(workspaceRef)`:** `this.git.run(['worktree', 'remove', workspaceRef, '--force'], {cwd: cachePath})` (force: agent-modified/uncommitted files are expected to remain). The shared base clone itself is never deleted by this class — it's a long-lived cache, pruned only by manual ops action.

### Required wiring change: `dev-cycle.ts`

Today `workspaceRef: input.repo` is passed inline on every `runStageAgent` call, and `branch` is computed inline right before `openPr`. Both need to move earlier:

- Add `state.workspaceRef: string` and `state.branch: string` to `DevCycleState`.
- Immediately after building `state` (before the `preImplementStages` loop — the `context` stage's agent already needs a real cwd), call a new activity `activities.prepareWorkspace({ taskId: input.taskId, repo: input.repo })` and populate `state.workspaceRef`/`state.branch` from the result.
- Every `workspaceRef: input.repo` in `runStageAgent` becomes `workspaceRef: state.workspaceRef`.
- The inline `const branch = \`agentops/${input.taskId}\`` before `openPr` is deleted; `openPr` uses `state.branch`.
- `activities.pushBranch(branch, ...)` in the babysit loop becomes `activities.pushBranch(state.workspaceRef, state.branch, ...)` (see the `ScmPort.push` signature change below).
- Cleanup: call `activities.cleanupWorkspace(state.workspaceRef)` at each terminal return (`state.status = 'failed'` after cancellation, and the final `state.status = 'done'` at the bottom). **Not** on the `stopRequested` → `pending` return — that path expects an eventual `resume`, so the workspace must survive it. Given `dev-cycle.ts` currently has multiple return statements, the cleanest implementation is likely consolidating the failed/done paths through one exit point that calls cleanup before returning, rather than duplicating the cleanup call at each `return state` site — a small structural nit worth taking during implementation, not a design requirement in itself.

### Required interface change: `ScmPort.push`

`push(branch: string, contentHash: string): Promise<void>` has no way to know *which* local checkout to push from — it's a single instance shared across all tasks. Real git push is a local operation on a specific directory, so the signature must carry it:

```ts
push(workspaceRef: string, branch: string, contentHash: string): Promise<void>;
```

`MemoryScmPort.push` ignores the new parameter (unchanged behavior, still a no-op). `DevCycleActivities.pushBranch` and `create-activities.ts`'s `pushBranch` activity gain the same parameter and pass it through. This is a one-line ripple, called out here because it's this sub-project's dependency creating the need, even though the real implementation of `push` itself belongs to GitHub ports.

## Testing strategy

Two layers, tested differently:

- **`SpawnGitCommandRunner`**: `spawn` is injectable (same DI pattern as `ClaudeBackend`'s `spawn` option) — unit tests inject a fake process and assert the exact argv passed to real `spawn`, specifically that `-c http.extraHeader=...` is prepended when a token is present and omitted entirely when `authToken()` returns `undefined`, and that the token never appears anywhere else in the constructed args (no URL interpolation).
- **`WorkspaceManager`**: takes a *real* `SpawnGitCommandRunner` (no token needed — tests use local paths, not real remotes) against **real temporary git repos on local disk** (created with plain `git init` + a commit in a `beforeEach`, via Node's `os.tmpdir()`) rather than mocking git itself — git's own behavior (worktree locking, `refs/remotes/origin/HEAD`) is exactly what's under test, so faking it would test nothing. No network access needed: the "remote" in tests is just another local directory (`git clone <local-path> <cache-path>` works identically to a network clone). Coverage:
  - `prepare` on a fresh repo: clones, detects default branch, creates a worktree with the right branch.
  - `prepare` called twice for the same repo (simulating a second task): reuses the existing base clone (asserts no second `clone`, only a `fetch`), produces a second independent worktree.
  - `cleanup` removes the worktree directory and it's gone from `git worktree list` in the base clone; base clone itself untouched.

## Named risks

- **No cross-task locking on the shared base clone.** Two tasks for the same repo running concurrently both `git fetch` and `git worktree add` against the same base clone directory. `git worktree add` itself is safe for concurrent use (git locks `.git/worktrees/`), but a `fetch` racing a `worktree add` reading refs is a plausible (rare) race. Acceptable for M1 (single worker, low concurrency expected); a real fix (per-repo mutex, e.g. a lock file held for the duration of `prepare`) should land before M5's multi-backend/higher-throughput milestone, not before.
- **Disk growth is unbounded.** Base clones accumulate one per distinct repo forever; task worktrees are cleaned up on terminal states but a crashed worker (killed before reaching a `cleanup` call) leaks a worktree directory. No reconciliation job exists yet to sweep orphans — acceptable for M1's manual-trigger, low-volume usage; worth a `BudgetReport`-adjacent housekeeping job later, not blocking here.

## Package/file summary

- **New:** `packages/ports/src/git/git-command-runner.ts` (interface only).
- **New:** `packages/activities/src/workspace/workspace-manager.ts`, `spawn-git-command-runner.ts`, `.test.ts` for each.
- **Changed:** `packages/workflows/src/activities-api.ts` (add `prepareWorkspace`/`cleanupWorkspace` to `DevCycleActivities`; extend `pushBranch` signature).
- **Changed:** `packages/activities/src/create-activities.ts` (new activities, `ActivityDependencies` gains a `workspaces: WorkspaceManager`, `pushBranch` passes `workspaceRef` through).
- **Changed:** `packages/ports/src/scm-port.ts` (`push` signature), `packages/ports/src/memory/memory-scm.ts` (accept-and-ignore the new param).
- **Changed:** `packages/workflows/src/dev-cycle.ts` (state fields, wiring described above).
- **Changed:** `packages/worker/src/create-worker.ts` / wherever `ActivityDependencies` is constructed for a real run (construct one `SpawnGitCommandRunner`, wire it into both a real `WorkspaceManager` here and `GithubScmPort` — the exact call site depends on how M1's wiring step assembles a "real" worker vs. the e2e test's in-memory one).

## Open questions carried forward

- Reconciliation/GC for orphaned worktrees after a worker crash — deferred, noted above.
- Whether `implement`'s prompt should explicitly instruct the agent to `git commit` (it must, for `push` to have anything to send) — this is a [claude-backend](2026-07-03-claude-backend-design.md) prompt-copy concern, cross-referenced here since it's this doc's `push` step that would otherwise push nothing.
