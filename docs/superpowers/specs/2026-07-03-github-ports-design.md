# GitHub Ports — Design

Status: draft · 2026-07-03 · Owner: Artem
Milestone: M1, sub-project 3 of 5 (see [claude-backend design](2026-07-03-claude-backend-design.md) for the full decomposition)

## Context

`TrackerPort` and `ScmPort` (packages/ports) are implemented today only by `MemoryTrackerPort`/`MemoryScmPort` — scriptable fixtures for tests. M1 needs real adapters against GitHub, since AGENTS.md hard rule 4 is explicit: "Nothing outside `ports/` may import a forge/tracker SDK or call their APIs." This doc designs `GithubTrackerPort` and `GithubScmPort`.

Depends on nothing else in M1. [Worktree activities](2026-07-03-worktree-activities-design.md) depends on this doc only insofar as `push`'s real implementation lives here and needs the `workspaceRef` parameter that doc adds to the `ScmPort.push` signature. [Config loading](2026-07-03-agentops-config-loading-design.md) depends on this doc's `readFile`.

## Goal

Real, testable (no live network in CI) implementations of `TrackerPort` and `ScmPort` against the GitHub REST + GraphQL APIs.

## Non-goals

- Gitea/Linear adapters (ARCHITECTURE.md's other tracker options) — GitHub only, per M1 scope.
- Webhooks / event push (M3 — Gateway). This is purely the poll/pull-style port implementation `pr_babysit`'s durable timer already drives.
- Rate-limit-aware backoff beyond respecting standard `Retry-After`/secondary-rate-limit headers that the client library already handles — full budget-aware scheduling is M5.

## Client library choice

`@octokit/rest` (REST) + the same instance's built-in `.graphql()` (GraphQL) — official GitHub SDK, actively maintained, matches "free/open source first." Rejected alternative: shelling out to the `gh` CLI. That would mean two different "spawn an external binary" patterns in the codebase (this, and the `claude` backend) for no shared benefit, and `gh` isn't guaranteed present on every host/container that runs the worker — an npm dependency is more portable and far easier to unit-test (inject a fake client) than mocking a CLI's stdout.

## Ref conventions (new — currently unspecified)

`TrackerPort.getIssue(ref)`/`ScmPort.getPrFeedback(prRef)` take opaque strings. `MemoryTrackerPort` gets away with treating them as arbitrary test keys, but a real adapter is a single shared instance across every task/repo (constructed once at worker startup, per `ActivityDependencies`), so refs must encode the repo:

- Issue ref: `"owner/repo#123"`.
- PR ref (returned by `openPr`, consumed by `getPrFeedback`): `"owner/repo#456"` — same shape, symmetry intentional.
- `repo` fields throughout (`TaskInput.repo`, `OpenPrRequest.repo`) are the `"owner/repo"` slug — the same convention [worktree activities](2026-07-03-worktree-activities-design.md) uses to build a clone URL.

This convention should be documented in `packages/ports`' README/index once implemented, since nothing currently pins it down.

## `GithubTrackerPort`

```ts
export class GithubTrackerPort implements TrackerPort {
  constructor(private octokit: Octokit);
  async getIssue(ref: string): Promise<Issue>;      // GET /repos/{owner}/{repo}/issues/{number}
  async comment(ref: string, body: string): Promise<void>;  // POST .../issues/{number}/comments
  async label(ref: string, label: string): Promise<void>;   // POST .../issues/{number}/labels
}
```

`ref` is parsed once, at the top of each method, by a shared `parseRef(ref): {owner, repo, number}` helper — throws a clear error on malformed input rather than letting a cryptic Octokit 404 surface.

## `GithubScmPort`

```ts
export class GithubScmPort implements ScmPort {
  constructor(private octokit: Octokit, private git: GitRunner /* from worktree activities, injected */);
  async openPr(req: OpenPrRequest): Promise<OpenPrResult>;
  async getPrFeedback(prRef: string): Promise<PrFeedback>;
  async push(workspaceRef: string, branch: string, contentHash: string): Promise<void>;
  async readFile(repo: string, path: string): Promise<string | null>;
}
```

**`openPr`:** fetch the repo's default branch (`GET /repos/{owner}/{repo}` → `default_branch`) as the PR base, then `POST /repos/{owner}/{repo}/pulls` with `head: branch`. Returns `{ prRef: "owner/repo#<number>", url: response.html_url }`.

**`getPrFeedback` — the one genuinely tricky piece.** `PrFeedback` needs `ciStatus` and `unresolvedThreads`:

- `ciStatus`: GitHub Actions results surface through the **Checks API**, not the older Commit Status API (most repos today run CI via Actions, which populates check-runs, not the legacy `statuses` array). Fetch `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` for the PR's head SHA (fetched via `GET .../pulls/{number}` first). Map: any check-run `status != completed` → `pending`; all completed and all `conclusion == success` → `green`; any `conclusion` in `failure|cancelled|timed_out` → `failed`.
- `unresolvedThreads`: **the REST API has no "resolved" field for review comments** — thread-resolution state only exists in GitHub's GraphQL schema (`PullRequestReviewThread.isResolved`). This means `getPrFeedback` must make a GraphQL call, not a pure-REST one:

  ```graphql
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
          nodes { isResolved comments(first: 1) { nodes { id body } } }
        }
      }
    }
  }
  ```

  `unresolvedThreads` = count of `!isResolved`; `comments[]` in `PrFeedback` = each thread's first comment mapped to `{id, body, resolved: isResolved}`. This is the detail most likely to be silently gotten wrong (REST-only implementations of "unresolved review threads" are a common bug elsewhere) — flagging it now so it isn't discovered as a mysterious "babysit never reaches merge_ready" bug during M1 integration, since `babysitDecision` depends entirely on this number being accurate.

**`push`:** runs `git push` (via the same injectable `git.ts` runner [worktree activities](2026-07-03-worktree-activities-design.md) defines) inside `workspaceRef`, using the **same per-invocation `-c http.extraHeader` token pattern** that doc specifies for clone/fetch — never embed the token in the remote URL, never persist it to `.git/config`:

```
git -c http.extraHeader="Authorization: Bearer <token>" push origin <branch>
```

`contentHash` isn't used to construct anything here (no commit message synthesis) — it's already recorded via `recordStageResult`/`recordRunStats` elsewhere for tracking; `push` just ships whatever the agent already committed in the workspace. (Implication carried over from the worktree doc: the `implement` prompt must instruct the agent to `git commit` its own changes — nothing else in this design does it.)

**`readFile`:** `GET /repos/{owner}/{repo}/contents/{path}` — base64-decode `content`, return the string. `404` → return `null` (matches the interface's "file may not exist" contract, used by [config loading](2026-07-03-agentops-config-loading-design.md) to detect a missing `agentops.json`). Any other error status → throw.

## Auth

Single GitHub token from `process.env.GITHUB_TOKEN`, read once at construction (worker/CLI startup), passed into one shared `Octokit` instance used by both `GithubTrackerPort` and `GithubScmPort` — they're two narrow views over one authenticated client, not two separately-authenticated things. No fallback/default; missing token fails fast at startup with a clear error rather than surfacing as a confusing 401 on first use.

## Testing strategy

Both classes take their `Octokit` instance via constructor injection — unit tests pass a hand-built fake object shaped like the subset of the Octokit surface actually used (`rest.issues.get`, `rest.pulls.create`, `graphql`, etc.), asserting on call arguments and mapping return values into the expected `Issue`/`PrFeedback`/`OpenPrResult` shapes. No network, no token, no `nock`/HTTP-mocking layer needed — the fake is a plain object, same DI philosophy as `ClaudeBackend`'s injectable `spawn` and `WorkspaceManager`'s injectable git runner. Coverage:

- `getIssue`/`comment`/`label`: ref parsing (including the malformed-ref error case), correct Octokit calls.
- `getPrFeedback`: check-runs → each `ciStatus` value; GraphQL response → correct `unresolvedThreads` count and `comments[]` mapping (this is the test worth writing first, given it's the highest-risk mapping).
- `readFile`: base64 decode; 404 → `null`; other error status → throws.
- `push`: git runner invoked with the right args and the token passed via `-c`, never interpolated into the URL string anywhere in the call.

Real-API verification is a manual, documented script against a disposable throwaway test repo (same posture as the claude backend's `verify:live` script) — never part of `pnpm e2e`.

## Named risks

- **GraphQL + REST split doubles the API surface this adapter depends on** — a GitHub API deprecation or schema change on either side is two failure modes to watch, not one. Acceptable; there's no single-API way to get thread-resolution state today.
- **No pagination handling for `reviewThreads(first: 100)` / check-runs.** A PR with over 100 review threads or check-runs would undercount. Vanishingly unlikely for M1's scale (a single test repo, agent-driven PRs); worth a `TODO` comment at the call site rather than building pagination now.
- **Secondary rate limits on rapid babysit polling.** `pr_babysit`'s poll interval (currently 5s in tests, presumably longer in real config) calling `getPrFeedback` repeatedly could trip GitHub's abuse-detection secondary rate limit if set too aggressively for real use. Not a design flaw here, but worth remembering when M1's real `ProductConfig` picks a babysit poll interval — should be minutes, not seconds, outside tests.

## Package/file summary

- **New:** `packages/ports/src/github/github-tracker-port.ts`, `github-scm-port.ts`, `parse-ref.ts`, and `.test.ts` for each.
- **New dependency:** `octokit` (or `@octokit/rest` + `@octokit/graphql` — a single `octokit` package bundles both) added to `packages/ports/package.json`.
- **Changed:** `packages/ports/src/scm-port.ts` — already covered by the worktree-activities doc's `push` signature change; this doc is the one that actually implements it.
- **Changed:** wherever `ActivityDependencies` is constructed for a real run — wires `new Octokit({auth: process.env.GITHUB_TOKEN})` once, passes it into both adapters.

## Open questions carried forward

- Gitea/Linear adapters — not needed until a non-GitHub product shows up; the `TrackerPort`/`ScmPort` interfaces are already forge-agnostic so this is additive, not a redesign.
- Rate-limit-aware scheduling — M5.
