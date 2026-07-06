# Project Registry & Per-Project GitHub Credentials — Design

Status: draft · 2026-07-06 · Owner: Artem
Hardens M2 (chart/secrets); a prerequisite for M5's "two repos" done-when criterion. Supersedes the single-token `## Auth` section of [github-ports-design.md](2026-07-03-github-ports-design.md).

## Context

Today the entire worker fleet — which ARCHITECTURE.md §5.2/§5.7 already assumes serves *all* repos and products — runs on exactly one `GITHUB_TOKEN`, read once at process startup and baked into one shared `Octokit` instance and one shared `SpawnGitCommandRunner` (`packages/worker/src/main.ts:87`, `packages/cli/src/main.ts:69`, `packages/ports/src/github/build-github-ports.ts`). The chart mirrors this: one `githubTokenSecretName` value, one K8s Secret, one `GITHUB_TOKEN` env var (`charts/engine/values.yaml`, `charts/engine/templates/deployment.yaml`). There is no registry anywhere of which products/repos exist — `TaskInput.product` is a free-form string, unchecked against `repo`.

This breaks as soon as a second real product lives in a different GitHub org or needs its own least-privilege scope: there is exactly one token, shared by every task the worker ever runs, regardless of which repo it targets.

Confirmed in brainstorming before this doc was written:

- **Project == product, 1:1** with a repo — matches today's `TaskInput { product, repo }` shape and ARCHITECTURE.md §5.7's per-product framing. Cross-repo tasks (§6.2's marketing example, `targetRepo`) stay a special case, not the default this registry optimizes for.
- **Registry is static config, applied via Helm values + `helm upgrade`** — no hot-reload. Adding a project restarts the worker, the same operational shape as every other config change today. Dynamic reconciliation without a restart is `ConfigSync` (M7), not this.
- **No per-product namespace/quota/NetworkPolicy isolation** for now — ARCHITECTURE.md §5.7 frames that as an escalation path, not a default; nothing in M0–M2 built it, and it's out of scope here.
- **Credentials stay long-lived per-project PATs/tokens** — the same auth mechanism already in place (bearer token → Octokit; `http.extraHeader` → git), just parameterized per project instead of global. GitHub App installation tokens (short-lived, auto-provisioned) are a better long-term security posture but real new work (JWT signing, installation lookup, refresh) — named as future work, not built here.

## Goal

Let one worker fleet serve N products, each backed by its own GitHub token, through an explicit, typed, validated project registry — and make "onboard a new product" a documented, mechanical procedure (config + secret + redeploy), not a bespoke one-off requiring engine code changes.

## Non-goals

- GitHub App installation tokens — future upgrade, named as a risk, not designed here.
- Per-product namespace/quota/NetworkPolicy isolation (§5.7's escalation path) — deferred.
- Hot-reloading the registry without a worker restart — `ConfigSync`, M7.
- Non-GitHub trackers (Linear/Gitea) — the registry's `trackerType` field leaves room, but only `'github'` is implemented/validated now.
- Changing the CLI's per-invocation flag UX (`--repo`/`--product`) — unchanged; the registry adds validation and credential resolution behind them.
- SOPS-encrypted secret authoring for per-project tokens (ARCHITECTURE.md §5.1) — this design assumes the same manual-`kubectl create secret` posture as today's single `github-token` secret; formalizing via SOPS+age is `agentops-platform` work, not blocked by this doc.

## Design

### 1. `ProjectRegistry` contract — `packages/contracts/src/project-registry.ts` (new)

```ts
export const ProjectRegistryEntrySchema = z.object({
  product: z.string().min(1),
  repo: z.string().min(1),           // "owner/repo" — same convention as TaskInput.repo
  trackerType: z.literal('github'),  // extend when a second tracker adapter exists
  tokenEnvVar: z.string().min(1),    // name of the env var holding this project's resolved token
});
export type ProjectRegistryEntry = z.infer<typeof ProjectRegistryEntrySchema>;
export const ProjectRegistrySchema = z.array(ProjectRegistryEntrySchema);
export type ProjectRegistry = z.infer<typeof ProjectRegistrySchema>;

export class InvalidProjectRegistryError extends Error {
  constructor(message: string, public readonly issues?: unknown) { super(message); }
}

export function parseProjectRegistry(raw: unknown): ProjectRegistry {
  // ProjectRegistrySchema.parse(raw), then enforce invariants zod alone can't express:
  // unique `product`, unique `repo`, unique `tokenEnvVar` across entries.
}

// Not zod-validated (constructed programmatically, never parsed from raw input) — lives
// here, not in `packages/activities`, so both `activities` (loadProjectRegistry) and the
// worker/cli wiring layer (which builds GitCommandRunner instances per entry, §4) can
// share one type without `packages/ports` having to depend on `packages/activities`.
export interface ResolvedProjectEntry extends ProjectRegistryEntry { token: string }
```

The uniqueness invariants matter more than they look: two entries sharing a `repo` would make "which token does this repo use" undefined; two entries sharing a `product` breaks the 1:1 assumption every call site downstream relies on. `parseProjectRegistry` throws `InvalidProjectRegistryError` naming the duplicate rather than letting either silently pick "whichever entry the map iterates first."

### 2. Transport — one JSON env var + one token env var per project

Extends today's env-var wiring pattern rather than introducing a second mechanism (a mounted ConfigMap/file) for what is still small, rarely-changing config.

`charts/engine/values.yaml` gains a `projects` map:

```yaml
projects:
  product-a:
    repo: flair-hr/product-a
    githubTokenSecretName: github-token-product-a
  product-b:
    repo: flair-hr/product-b
    githubTokenSecretName: github-token-product-b
```

`templates/deployment.yaml` renders, via `range $product, $cfg := .Values.projects`:

- one `secretKeyRef` env var per project, named `GITHUB_TOKEN__<PRODUCT_UPPER_SNAKE>`, sourced from `$cfg.githubTokenSecretName` / key `GITHUB_TOKEN` (same secret shape as today's single secret — only the env var name and count change);
- one `PROJECT_REGISTRY_JSON` env var (`toJson` over the derived list `{product, repo, trackerType: "github", tokenEnvVar}` — no token values in this one, just the map).

The existing top-level `githubTokenSecretName` value and single `GITHUB_TOKEN` env var are removed — every project's credential goes through the per-project path now; there is no more implicit "default" token. Local dev without any registry configured keeps working exactly as today (see §6, demo-mode fallback).

### 3. Loading — `packages/activities/src/load-project-registry.ts` (new)

Mirrors the `parseProductConfig` (pure, contracts) / `loadProductConfig` (I/O) split from the config-loading design, except the I/O here is `process.env`, not a git-hosted file — and both the worker and the CLI need it, so it lives in `packages/activities` (already a shared dependency of both) rather than being duplicated in two `main.ts` files.

```ts
import { parseProjectRegistry, type ResolvedProjectEntry } from '@agentops/contracts';

export function loadProjectRegistry(env: NodeJS.ProcessEnv = process.env): ResolvedProjectEntry[] {
  const raw = env.PROJECT_REGISTRY_JSON;
  if (!raw) return [];
  const registry = parseProjectRegistry(JSON.parse(raw));
  return registry.map((entry) => {
    const token = env[entry.tokenEnvVar];
    if (!token) {
      throw new Error(`loadProjectRegistry: env var "${entry.tokenEnvVar}" for product "${entry.product}" is not set`);
    }
    return { ...entry, token };
  });
}
```

No `PROJECT_REGISTRY_JSON` at all → `[]` → demo mode (§6) — the direct successor to today's "no `GITHUB_TOKEN` → demo mode" fallback, just keyed off the registry instead of a single token. A registry entry present but its token env var missing is a loud boot-time failure naming exactly which product/env var is wrong, not a confusing 401 three stages later.

### 4. Multi-project ports — `packages/ports/src/github/project-scoped-ports.ts` (new)

Every `ScmPort`/`TrackerPort` method already carries enough repo information to route on — refs are `"owner/repo#N"` (`parseRef`), `OpenPrRequest`/`readFile` carry `repo` explicitly — except `push` (§5). Given the registry is small and static, this is a thin, **eager** dispatcher over already-built ports, keyed by `repo`.

**Two things push construction out of this file, both for the same reason — keep the dispatcher a plain router, not a builder:**

- **Package boundary:** `packages/ports` depends only on `@agentops/contracts` — it cannot import `SpawnGitCommandRunner` (lives in `packages/activities`, which already depends on `ports`; importing it back would be a circular workspace dependency).
- **Testability:** `createGithubPorts(token, git)` always constructs a real `Octokit`/`graphql` client from the raw token string — there's no seam to inject a fake `GithubClient` through it. A dispatcher that called `createGithubPorts` internally could only be tested against live GitHub.

So `createProjectScopedPorts` takes **already-constructed** `{ scm, tracker, git }` per entry — the caller (worker/CLI wiring, which already depends on `ports` and `activities`, exactly as it does today for the single-token case) calls `createGithubPorts(entry.token, git)` itself and passes the result in:

```ts
export interface ProjectScopedPortsEntry {
  repo: string;
  scm: ScmPort;
  tracker: TrackerPort;
  git: GitCommandRunner; // constructed by the caller, e.g. `new SpawnGitCommandRunner({ authToken: () => token })`
}

function repoFromRef(ref: string): string {
  const { owner, repo } = parseRef(ref);
  return `${owner}/${repo}`;
}

export function createProjectScopedPorts(entries: ProjectScopedPortsEntry[]): {
  scm: ScmPort;
  tracker: TrackerPort;
  resolveGit: (repo: string) => GitCommandRunner;
} {
  const byRepo = new Map(entries.map((e) => [e.repo, e]));
  function resolve(repo: string): ProjectScopedPortsEntry {
    const found = byRepo.get(repo);
    if (!found) throw new Error(`createProjectScopedPorts: no project registered for repo "${repo}" — check the project registry`);
    return found;
  }
  return {
    scm: {
      openPr: (req) => resolve(req.repo).scm.openPr(req),
      getPrFeedback: (prRef) => resolve(repoFromRef(prRef)).scm.getPrFeedback(prRef),
      push: (repo, workspaceRef, branch, contentHash) => resolve(repo).scm.push(repo, workspaceRef, branch, contentHash),
      readFile: (repo, path) => resolve(repo).scm.readFile(repo, path),
    },
    tracker: {
      getIssue: (ref) => resolve(repoFromRef(ref)).tracker.getIssue(ref),
      comment: (ref, body) => resolve(repoFromRef(ref)).tracker.comment(ref, body),
      label: (ref, label) => resolve(repoFromRef(ref)).tracker.label(ref, label),
    },
    resolveGit: (repo) => resolve(repo).git,
  };
}
```

This has a pleasant side effect beyond testability: the dispatcher itself has zero GitHub-specific knowledge — it only knows `ScmPort`/`TrackerPort`/`GitCommandRunner`, the same forge-agnostic interfaces the rest of `packages/ports` is built on. Extending to a second `trackerType` later (Gitea/Linear, explicitly out of scope for this design) would touch the wiring layer's entry-building step, not this file. `ResolvedProjectEntry` (§1/§3's `{ ...ProjectRegistryEntry, token }`) still lives in `packages/contracts` so `packages/activities` (`loadProjectRegistry`) and the wiring layer both consume one shared type when building `ProjectScopedPortsEntry[]` from it — `token` itself is only needed transiently by the wiring layer to call `createGithubPorts`, not by this dispatcher.

### 5. `WorkspaceManager` becomes repo-routed, not token-routed

`WorkspaceManager` stays a single shared instance across all projects (its cache-dir/workspace-dir bookkeeping is already namespaced per repo via `sanitizeRepoSlug`), but it can no longer hold one fixed `git: GitCommandRunner` — each project now has its own runner (§4).

`WorkspaceManagerOptions.git: GitCommandRunner` → `WorkspaceManagerOptions.resolveGit: (repo: string) => GitCommandRunner`. Every existing call site (`ensureBaseClone`, `detectDefaultBranch`, `prepare`'s `worktree add`, `cleanup`'s `worktree remove`) already receives or has `repo` in scope — each becomes `this.resolveGit(repo).run(...)` instead of `this.git.run(...)`. `GitCommandRunner`'s interface itself is untouched. Demo/local-single-repo mode passes a trivial `() => fixedRunner` constant, so `MemoryWorkspaceManager` and simple local dev don't get more complicated.

### 6. `ScmPort.push` gains a `repo` parameter (breaking, mechanical)

`push(workspaceRef, branch, contentHash)` → `push(repo, workspaceRef, branch, contentHash)`. This is the one call that didn't already carry enough repo information for `createProjectScopedPorts` to route it — `workspaceRef` is an opaque local path (`~/.agentops/workspaces/<taskId>`), not repo-derived.

Ripple, all mechanical:

- `packages/ports/src/scm-port.ts` — `ScmPort.push` signature.
- `packages/ports/src/github/github-scm-port.ts` — `GithubScmPort.push(repo, workspaceRef, branch, contentHash)`; `repo` is unused inside the method body (the clone at `workspaceRef` already points at the right remote) but required so the dispatcher in §4 knows which project's port instance to call.
- `packages/ports/src/memory/memory-scm.ts` — `MemoryScmPort.push` gains an unused `_repo` param for interface symmetry.
- `packages/workflows/src/activities-api.ts:39` — `DevCycleActivities.pushBranch` signature.
- `packages/activities/src/create-activities.ts:55` — `pushBranch` activity signature and its call into `deps.scm.push`.
- `packages/workflows/src/dev-cycle.ts:314` — call site already has `input.repo` in scope: `activities.pushBranch(input.repo, state.workspaceRef, state.branch, ...)`.

### 7. Worker/CLI wiring

- `packages/worker/src/main.ts`: `buildActivityDependencies(githubToken: string | undefined)` → `buildActivityDependencies(registry: ResolvedProjectEntry[])`. Empty registry → today's demo-mode branch (`MemoryScmPort`/`MemoryTrackerPort`/`MemoryWorkspaceManager`), unchanged. Non-empty: for each entry, build `const git = new SpawnGitCommandRunner({ authToken: () => entry.token })` (exactly today's single-token construction, just once per entry instead of once globally) and `const { scm, tracker } = createGithubPorts(entry.token, git)`, collect `{ repo: entry.repo, scm, tracker, git }` into `ProjectScopedPortsEntry[]`, and call `createProjectScopedPorts(entries)` for the dispatcher's `scm`/`tracker`/`resolveGit`; wire `new WorkspaceManager({ resolveGit, cloneUrl: githubCloneUrl })`.
- `packages/cli/src/main.ts`: since a CLI invocation only ever targets one `--repo`, it doesn't need the dispatcher at all — `buildStartScmPort(registry, product, repo)` looks up the single matching entry (throwing on an unregistered repo or a repo/product mismatch — the concrete "registry validates onboarding" behavior) and returns `createGithubPorts(entry.token, git).scm` directly, same as today's single-token path just keyed by a looked-up entry instead of a global token.
- Startup log line names which mode plus the registered products (e.g. `LIVE mode — 2 projects registered: product-a (flair-hr/product-a), product-b (flair-hr/product-b)`) instead of today's binary "GITHUB_TOKEN set/not set".

## Onboarding runbook (adding a new product)

1. Create/identify the product's GitHub repo; add `agentops.json` at its root (verify commands, routing, budgets — unchanged, already works via `loadProductConfig`).
2. Mint a GitHub token scoped to that repo only (fine-grained PAT: `repo` + `pull_request` permissions) — least privilege per project is the entire point of this design.
3. In `agentops-platform`, create the K8s Secret holding that token in the target namespace (`kubectl create secret generic github-token-<product> --from-literal=GITHUB_TOKEN=... -n dev-agents`, or the SOPS-encrypted equivalent once that lands).
4. Add an entry under `projects.<product>` (`repo`, `githubTokenSecretName`) to `agentops-platform`'s `clusters/ops/engine/values.yaml` override.
5. Merge the `agentops-platform` PR → ArgoCD syncs → `helm upgrade` restarts the worker Deployment with the new project wired in — the same mechanism as any other engine config change today (e.g. the existing image-tag auto-bump).
6. Smoke-test: `engine start --product <name> --repo owner/repo --goal "..."` — registry validation catches an unregistered/mismatched repo immediately; a real PR against the new repo confirms the token works end-to-end.

No engine code change is required per onboarding — only once, to land this design.

## Testing strategy

- `parseProjectRegistry`: pure unit tests. Valid array passes; duplicate `product` throws; duplicate `repo` throws; duplicate `tokenEnvVar` throws; non-array input throws.
- `loadProjectRegistry`: inject a fake `env` object. Missing `PROJECT_REGISTRY_JSON` → `[]`; present but a referenced `tokenEnvVar` absent from `env` → throws naming the product; valid → resolved tokens attached.
- `createProjectScopedPorts`: no Octokit/GithubClient involved at all — inject plain fake `ScmPort`/`TrackerPort` objects per entry (`{ openPr: vi.fn(), ... }`) and assert each method call lands on the entry matching the repo it carries; assert a repo absent from the registry throws a clear, named error — this is the one genuinely new failure mode worth its own test ("task somehow targets a repo not in the registry").
- `WorkspaceManager` with `resolveGit`: existing tests updated to pass a trivial `() => fakeRunner`; one new test maps two repos to two distinct fake runners and asserts each repo's `prepare()` call lands on its own runner — proves routing, not just the signature change.
- No new `pnpm e2e` scenario required (registry is a real-GitHub-only concern, out of stub/`TestWorkflowEnvironment` scope); the manual verify-live script mentioned in `github-ports-design.md` should be extended to exercise two disposable test repos with two distinct fine-grained PATs, proving cross-project isolation for real at least once before trusting this in production.

## Named risks

- **Registry entries and their secrets can drift out of sync** (an entry added to `values.yaml` before its Secret exists, or renamed on one side only). `loadProjectRegistry` throws a named, specific error at worker boot, so this fails loudly, not silently — a CI check that every declared `githubTokenSecretName` resolves before deploy would be a nice-to-have, not required now.
- **N long-lived PATs is still N secrets to rotate manually.** Accepted trade-off (per-project PAT was the explicit choice over GitHub App tokens for this pass); the App-installation-token path remains the documented upgrade once manual rotation at the current N becomes painful.
- **Eager construction of all N port/git-runner instances at worker startup** means adding a project requires a restart (already accepted — no hot-reload) and N Octokit clients live for the worker's lifetime. Fine at the scale this platform targets (single- to low-double-digit products); revisit only if that changes.
- **`WorkspaceManager`'s cache/workspace directories remain shared across all projects on one PVC**, namespaced only by `sanitizeRepoSlug(repo)` — unrelated to credentials and already true today, noted so it isn't rediscovered as a surprise later.

## Package/file summary

- **New:** `packages/contracts/src/project-registry.ts` (+ `.test.ts`)
- **New:** `packages/activities/src/load-project-registry.ts` (+ `.test.ts`)
- **New:** `packages/ports/src/github/project-scoped-ports.ts` (+ `.test.ts`)
- **Changed:** `packages/ports/src/scm-port.ts`, `github/github-scm-port.ts`, `memory/memory-scm.ts` (`push` signature) + tests
- **Changed:** `packages/activities/src/workspace/workspace-manager.ts` (`git` → `resolveGit`) + test
- **Changed:** `packages/activities/src/create-activities.ts` (`pushBranch` signature)
- **Changed:** `packages/workflows/src/activities-api.ts`, `dev-cycle.ts` (`pushBranch` call site) + tests
- **Changed:** `packages/worker/src/main.ts`, `packages/cli/src/main.ts` (registry-based wiring)
- **Changed:** `charts/engine/values.yaml`, `templates/deployment.yaml`, `tests/render.golden.yaml`
- **Changed (in `agentops-platform`, out of this repo):** `clusters/ops/engine/values.yaml` gets the real `projects` map + secret names; secrets created per project.

## Open questions carried forward

- SOPS-encrypted authoring flow for per-project tokens (ARCHITECTURE.md §5.1) — `agentops-platform` work, not blocked by this design.
- GitHub App installation tokens — future upgrade, not designed here.
- A CI check that every `values.yaml` project entry's secret exists before deploy — nice-to-have, not required for the initial version.
