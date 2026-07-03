# Worktree Activities — Design

Status: draft · 2026-07-03 · Owner: Artem
Milestone: M1, sub-project 2 of 4 (see [claude-backend design](2026-07-03-claude-backend-design.md) for the full decomposition)

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

### New module: `packages/activities/src/workspace/`

```
packages/activities/src/workspace/
  workspace-manager.ts   # WorkspaceManager class
  git.ts                 # thin spawn-based git command runner (injectable, like ClaudeBackend's spawn)
  workspace-manager.test.ts
```

```ts
export interface WorkspaceManagerOptions {
  cacheDir?: string;      // default: ~/.agentops/cache  (shared base clones, one per repo)
  workspacesDir?: string; // default: ~/.agentops/workspaces  (one dir per taskId)
  cloneUrl: (repo: string) => string;  // e.g. repo "owner/name" -> "https://github.com/owner/name.git"
  authToken?: () => string | undefined; // read lazily so a rotated token is picked up per call
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

1. Resolve `cacheDir/<sanitized repo slug>` as the shared base clone path. If it doesn't exist: `git clone <cloneUrl(repo)> <cachePath>`. If it does: `git fetch origin` inside it to bring refs up to date.
2. Read the default branch from the local clone's `refs/remotes/origin/HEAD` (set automatically by `clone`/`fetch`) — no API call, no dependency on GitHub ports.
3. `git worktree add <workspacesDir>/<taskId> -b agentops/<taskId> origin/<baseBranch>` run inside the base clone, creating a fresh worktree with a new branch off the latest default branch.
4. Return `{ workspaceRef: <that path>, branch: "agentops/<taskId>", baseBranch }`.

**`cleanup(workspaceRef)`:** `git worktree remove <workspaceRef> --force` (force: agent-modified/uncommitted files are expected to remain), run from the base clone. The shared base clone itself is never deleted by this class — it's a long-lived cache, pruned only by manual ops action.

**Auth for `clone`/`fetch`:** every git invocation that talks to the remote passes the token via a **per-invocation config override**, never persisted to disk and never embedded in the remote URL:

```
git -c http.extraHeader="Authorization: Bearer <token>" fetch origin
```

`-c` overrides are process-scoped — they don't get written into `.git/config`. This matters because the base clone is long-lived and shared: an embedded-in-URL token (`https://<token>@github.com/...`) would sit in `.git/config` in plaintext indefinitely, violating AGENTS.md's "no secrets in code or fixtures" spirit even though it's a runtime path, not a fixture. The same mechanism is reused for `push` — see [GitHub ports design](2026-07-03-github-ports-design.md), which owns that call site but should follow this exact pattern for consistency.

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

`git.ts`'s command runner is injectable (same DI pattern as `ClaudeBackend`'s `spawn` option), so `WorkspaceManager` unit tests run against a **real temporary git repo on local disk** (created with plain `git init` + a commit in a `beforeEach`, via Node's `os.tmpdir()`) rather than mocking git itself — git's own behavior (worktree locking, `refs/remotes/origin/HEAD`) is exactly what's under test, so faking it would test nothing. No network access needed: the "remote" in tests is just another local directory (`git clone <local-path> <cache-path>` works identically to a network clone). This keeps tests hermetic and fast without mocking away the thing being verified. Coverage:

- `prepare` on a fresh repo: clones, detects default branch, creates a worktree with the right branch.
- `prepare` called twice for the same repo (simulating a second task): reuses the existing base clone (asserts no second `clone`, only a `fetch`), produces a second independent worktree.
- `cleanup` removes the worktree directory and it's gone from `git worktree list` in the base clone; base clone itself untouched.
- Auth token is passed via `-c http.extraHeader`, never appears in the resulting `.git/config` (grep the file after clone in the test).

## Named risks

- **No cross-task locking on the shared base clone.** Two tasks for the same repo running concurrently both `git fetch` and `git worktree add` against the same base clone directory. `git worktree add` itself is safe for concurrent use (git locks `.git/worktrees/`), but a `fetch` racing a `worktree add` reading refs is a plausible (rare) race. Acceptable for M1 (single worker, low concurrency expected); a real fix (per-repo mutex, e.g. a lock file held for the duration of `prepare`) should land before M5's multi-backend/higher-throughput milestone, not before.
- **Disk growth is unbounded.** Base clones accumulate one per distinct repo forever; task worktrees are cleaned up on terminal states but a crashed worker (killed before reaching a `cleanup` call) leaks a worktree directory. No reconciliation job exists yet to sweep orphans — acceptable for M1's manual-trigger, low-volume usage; worth a `BudgetReport`-adjacent housekeeping job later, not blocking here.

## Package/file summary

- **New:** `packages/activities/src/workspace/workspace-manager.ts`, `git.ts`, `.test.ts`.
- **Changed:** `packages/workflows/src/activities-api.ts` (add `prepareWorkspace`/`cleanupWorkspace` to `DevCycleActivities`; extend `pushBranch` signature).
- **Changed:** `packages/activities/src/create-activities.ts` (new activities, `ActivityDependencies` gains a `workspaces: WorkspaceManager`, `pushBranch` passes `workspaceRef` through).
- **Changed:** `packages/ports/src/scm-port.ts` (`push` signature), `packages/ports/src/memory/memory-scm.ts` (accept-and-ignore the new param).
- **Changed:** `packages/workflows/src/dev-cycle.ts` (state fields, wiring described above).
- **Changed:** `packages/worker/src/create-worker.ts` / wherever `ActivityDependencies` is constructed for a real run (wire a real `WorkspaceManager` alongside the real backends/ports — the exact call site depends on how M1's wiring step assembles a "real" worker vs. the e2e test's in-memory one).

## Open questions carried forward

- Reconciliation/GC for orphaned worktrees after a worker crash — deferred, noted above.
- Whether `implement`'s prompt should explicitly instruct the agent to `git commit` (it must, for `push` to have anything to send) — this is a [claude-backend](2026-07-03-claude-backend-design.md) prompt-copy concern, cross-referenced here since it's this doc's `push` step that would otherwise push nothing.
