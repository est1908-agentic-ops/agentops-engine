# M1 Wiring — Design

Status: draft · 2026-07-03 · Owner: Artem
Milestone: M1, integration step (ties together all 5 sub-projects: [claude backend](2026-07-03-claude-backend-design.md), [pi backend](2026-07-03-pi-backend-design.md), [GitHub ports](2026-07-03-github-ports-design.md), [worktree activities](2026-07-03-worktree-activities-design.md), [config loading](2026-07-03-agentops-config-loading-design.md))

## Context

Each of M1's five sub-projects is implemented and unit-tested in isolation, and every one of their design docs explicitly deferred the same thing: connecting the real implementations to `packages/worker/src/main.ts` and `packages/cli/src/main.ts`, which today construct only `StubBackend`, `MemoryScmPort`, `MemoryTrackerPort`, and `MemoryWorkspaceManager`. Quoting the deferrals already on record:

- claude-backend design: "registering `'claude'` in the backends map is deferred to the M1 wiring step"
- config-loading design: "which `ScmPort` instance `scm` is here is a wiring decision, not this sub-project's... belongs to M1's final integration/wiring step"
- worktree-activities design: "the exact wiring call site is the shared M1 integration step both docs already defer"

As a result, no code path today turns a real GitHub issue into a real PR, and no `engine` command exists — `ARCHITECTURE.md:390` and `MILESTONES.md:24` both name `engine start --issue N` as M1's literal acceptance UX, but the CLI only offers positional `pnpm --filter cli cli start <taskId> <goal> <product> <repo> <issueRef>`. This doc is that last wiring step.

## Goal

`engine start --issue N` against a real repo produces a real PR with green CI, using real GitHub ports, a real backend (`claude`, per `agentops.json` routing), and real git worktrees — while the existing local/demo path (zero env vars, all in-memory, today's 166 unit tests + 4 e2e tests) keeps passing completely unchanged.

## Non-goals

- k8s (M2), webhooks (M3), budget/LiteLLM enforcement (M5).
- Automating the live trial in CI. This repo's CI can't safely hold a real `GITHUB_TOKEN` plus an authenticated `claude` CLI yet — verification is manual and documented (see Testing strategy).
- A real installed/global `engine` binary (`npm link`, packaged `bin`). M1 is explicitly "still local"; a `pnpm`-scoped script that reads `engine` at the command line is enough. Real packaging is later polish, not blocking.
- Fixing `docs/MILESTONES.md`'s staleness (M0 checkboxes, current-milestone marker, the pi M1-vs-M5 wording mismatch). That's a docs edit with no design content — do it directly, no spec needed.
- Per-sub-project PR/CI/Bugbot cleanup for the five already-landed sub-projects.

## Mode-selection approach

**`GITHUB_TOKEN` presence is the only signal.** Set → live mode (real GitHub ports, real worktrees). Unset → demo mode (today's in-memory everything, unchanged). No `--live` flag, no config field.

Rejected alternative: an explicit `--live` flag (or `agentops.json` field) as a second, deliberate opt-in on top of the token check. This would guard against "I had `GITHUB_TOKEN` set in my shell for an unrelated tool and `engine start` silently went live," but every existing sub-project design doc already committed to token-presence-alone as the switch (see config-loading design: "the existing local-demo path... should keep working against `MemoryScmPort`... a real run needs a `GithubScmPort`"), and a second flag is a new config surface none of them anticipated. Instead, this design closes that gap with a single loud startup log line stating which mode is active — never silent, without adding a flag.

Backend selection is **not** part of this switch. `packages/worker/src/main.ts` always registers `{ stub, claude: new ClaudeBackend(), pi: new PiBackend() }` regardless of mode — which backend actually runs per stage is entirely `agentops.json`'s `routing` field, a config concern already solved by the config-loading sub-project. Rejected alternative: gating backend registration on `GITHUB_TOKEN` too, on the reasoning that "live" should mean "everything real" — rejected because it conflates two independent axes (do I have GitHub credentials vs. which agent CLI does this product want) for no benefit; registering a backend class costs nothing until a stage actually routes to it.

## Components

### `packages/ports/src/github/build-github-ports.ts` (new)

```ts
export function createGithubPorts(
  token: string,
  git: GitCommandRunner,
): { scm: GithubScmPort; tracker: GithubTrackerPort } {
  const octokit = new Octokit({ auth: token });
  return { scm: new GithubScmPort(octokit, git), tracker: new GithubTrackerPort(octokit) };
}
```

The only place `new Octokit(...)` is called outside test files, regardless of which composition root (worker or CLI) needs it — keeps AGENTS.md hard rule 4 ("nothing outside `ports/` may import a forge SDK") true no matter where this factory gets called from. `scm`/`tracker` share one authenticated client, matching the GitHub-ports design's "two narrow views over one authenticated client" framing.

### `packages/ports/src/github/clone-url.ts` (new)

```ts
export function githubCloneUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}
```

Three lines, exported from the `packages/ports` barrel. Keeps GitHub-shaped URL construction inside `ports/` rather than hardcoded into `worker/main.ts`, consistent with the worktree-activities design's `cloneUrl: (repo: string) => string` option on `WorkspaceManager`.

### `packages/worker/src/main.ts` (changed)

```ts
const githubToken = process.env.GITHUB_TOKEN;

const { scm, tracker, workspaces } = githubToken
  ? (() => {
      const git = new SpawnGitCommandRunner({ authToken: () => githubToken });
      const { scm, tracker } = createGithubPorts(githubToken, git);
      return { scm, tracker, workspaces: new WorkspaceManager({ git, cloneUrl: githubCloneUrl }) };
    })()
  : { scm: new MemoryScmPort(), tracker: new MemoryTrackerPort(), workspaces: new MemoryWorkspaceManager() };

console.log(
  githubToken
    ? 'agentops worker: LIVE mode (GITHUB_TOKEN set) — real GitHub + real agent CLIs, will spend tokens and open real PRs'
    : 'agentops worker: DEMO mode (no GITHUB_TOKEN) — in-memory ports + stub backend only',
);

const activities: DevCycleActivities = createActivities({
  backends: { stub: new StubBackend(), claude: new ClaudeBackend(), pi: new PiBackend() },
  tracker,
  scm,
  stats: new InMemoryStatsStore(),
  stageResults: new InMemoryStageResultStore(),
  workspaces,
  prompts: new PromptPack(),
});
```

`stats`/`stageResults` stay in-memory in both modes — nothing in M1's scope needs them durable yet (that's M4's `agent_run_stats` projection).

### `packages/cli/src/main.ts` (changed)

`cmdStart` resolves its `ScmPort` (used only for `loadProductConfig`, never for `push`) the same way:

```ts
const githubToken = process.env.GITHUB_TOKEN;
const scm = githubToken
  ? createGithubPorts(githubToken, new SpawnGitCommandRunner({ authToken: () => githubToken })).scm
  : (() => { const scm = new MemoryScmPort(); seedDemoAgentopsConfig(scm, repo); return scm; })();
const config = await loadProductConfig(scm, repo);
```

This resolves the "which `ScmPort`" question the config-loading design explicitly deferred. The CLI builds its own throwaway `SpawnGitCommandRunner` rather than sharing the worker's instance — they're different processes; the git runner is stateless until `.run()` is called, so a second instance costs nothing and never needs to push.

### `engine` command surface

Rename `packages/cli/package.json`'s `"cli": "tsx src/main.ts"` script to `"engine": "tsx src/main.ts"`, invoked as `pnpm --filter cli engine start --issue owner/repo#42 --repo owner/repo --product my-product --goal "..."`. This makes `engine start --issue N` a real, typeable command without building/installing a global binary this milestone doesn't need.

Rewrite `start`'s argument handling from positional to flags: `--issue`, `--repo`, `--product`, `--goal`, optional `--task-id` (auto-generated from `crypto.randomUUID()` if omitted — CLI code, not workflow code, so no determinism-boundary concern). Hand-rolled parsing (a simple loop pairing `--flag value`) — no new dependency; `commander`/`yargs` exist only as transitive deps of other tools today, and five flags don't justify adding one. `signal`/`state` subcommands keep their current positional args (`<taskId> <signal> [text]`, `<taskId>`) — unambiguous already, and not what the milestone text calls out.

## Data flow (live mode, happy path)

1. `pnpm --filter cli engine start --issue owner/repo#42 --repo owner/repo --product my-product --goal "..."`.
2. CLI sees `GITHUB_TOKEN`, builds a real `GithubScmPort`, `loadProductConfig` reads the real `agentops.json` off `owner/repo`'s default branch via `readFile`.
3. CLI starts the `devCycle` workflow via the Temporal client with `TaskInput{ taskId, product, repo, issueRef, goal, config }`.
4. Worker (already running in live mode) executes `dev-cycle.ts`: `prepareWorkspace` → real `WorkspaceManager.prepare` clones/fetches `owner/repo` into `~/.agentops/cache`, adds a worktree at `~/.agentops/workspaces/<taskId>` on branch `agentops/<taskId>`.
5. `getIssue(issueRef)` → real `GithubTrackerPort.getIssue` fetches the real issue title/body/labels.
6. Per-stage `runAgent` → `ClaudeBackend` (per `agentops.json` routing) spawns the real `claude` CLI inside the workspace.
7. `pushBranch` → real `GithubScmPort.push` (token-authenticated git push).
8. `openPr` → real `GithubScmPort.openPr` opens a real PR against `owner/repo`.
9. `getPrFeedback` polls real checks/review threads — the existing babysit/brake logic now runs against real data instead of memory fixtures, unchanged itself.
10. `cleanupWorkspace` removes the git worktree on terminal state (already implemented and e2e-tested).

## Error handling

No new error paths. `WorkspaceManager`, `GithubScmPort`, and `GithubTrackerPort` already throw descriptive errors on git/API failure (verified in the prior audit of each sub-project), and the workflow's existing retry/brake logic already handles the memory equivalents' analogous errors — real errors surface through the same activity-failure path. The only genuinely new code here — the two small factories and the mode branch — is unconditional glue with no failure mode of its own: no token means the memory path runs, by construction, never a crash or a partial/mixed state.

## Testing strategy

- Unit test `createGithubPorts`: given a token and a fake `GitCommandRunner`, returns a `GithubScmPort`/`GithubTrackerPort` pair (assert via a fake `GithubClient`, same DI pattern the GitHub-ports doc already uses — no real `Octokit` construction in tests).
- Unit test `githubCloneUrl('owner/name')` → exact string.
- Unit test the CLI's new flag parser: missing/malformed flags produce the same class of usage errors today's positional validation does.
- No test spawns a real worker in live mode or hits real GitHub/`claude` — matches this repo's existing convention that `main.ts`/`create-worker.ts` aren't unit-tested themselves, only the logic beneath them. Real-API/real-CLI verification is manual, same posture as claude-backend's deferred `verify:live` script.
- **Manual runbook (added to README):** set `GITHUB_TOKEN`, have `claude` authenticated locally, point `--repo` at a disposable throwaway test repo with one real open issue, run `engine start --issue <ref> --repo <slug> --product default --goal "..."`, confirm a PR lands with green CI, and separately confirm a deliberately-low `brakes.maxTokens` trips and escalates. **This manual run is the actual execution of M1's acceptance criterion** — not something this doc automates away.
- The existing e2e suite (4 tests, memory-mode) must stay green completely unchanged — proof the demo path isn't disturbed by the new branch.

## Named risks

- **A stray `GITHUB_TOKEN` in the environment silently flips to live mode.** Mitigated by the mandatory startup log line, not eliminated — accepted per the "Mode-selection approach" discussion above; revisit with an explicit `--live`/config gate if this ever causes an actual incident.
- **Every stage defaults to `claude`/`claude-sonnet-5` in `DEFAULT_PRODUCT_CONFIG`.** The moment this wiring lands, a real run against a repo with no `agentops.json` routing override spends real tokens on every stage — no dry-run default exists. Already called out in the config-loading design's risk section; worth restating loudly in the README's `engine start` section, not just here.
- **No CI coverage of the live path, ever, until this changes.** Accepted for M1; the manual runbook is the only verification until there's a safe way to hold real credentials in CI (post-M1 concern, likely tied to M2's secrets bootstrap).

## Package/file summary

- **New:** `packages/ports/src/github/build-github-ports.ts`, `clone-url.ts`, and `.test.ts` for each; exported from `packages/ports/src/index.ts`.
- **Changed:** `packages/worker/src/main.ts` (mode-aware composition root, always-on backend registration, startup log line).
- **Changed:** `packages/cli/src/main.ts` (mode-aware `ScmPort` selection in `cmdStart`; flag-based argument parsing for `start`).
- **Changed:** `packages/cli/package.json` (`"cli"` script renamed to `"engine"`).
- **Changed:** `README.md` (document `GITHUB_TOKEN`/live-mode behavior, the flag-based `engine start` invocation, and the manual live-verification runbook).

## Open questions carried forward

- Real installed `engine` binary (global `bin`, `npm link`) — deferred until something outside this repo (Mission Control, ops tooling) needs to invoke it as an actual executable rather than via `pnpm --filter cli engine`.
- Explicit `--live`/config-gated double opt-in — deferred unless the token-presence-only approach causes a real accidental-live-run incident.
- `docs/MILESTONES.md` staleness (M0 checkboxes, current-marker, pi M1-vs-M5 wording) — a docs housekeeping edit, tracked here so it isn't lost, not designed as part of this doc.
