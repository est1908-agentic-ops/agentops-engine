# agentops-engine

The code of the agentic ops platform: Temporal workflows that turn tracker tasks into merge-ready PRs using pluggable coding-agent CLIs (`claude` / `cursor-agent` / `pi` / `codex`), plus the Gateway, Agent Runner images, role packs, and the Mission Control UI.

Its sibling repo **`agentops-platform`** holds the GitOps state (ArgoCD apps, Helm values, SOPS secrets). This repo builds images; that repo pins and deploys them. Never mix the two concerns.

## Start here

| Doc | What it is |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The canonical design: components, decisions, workflow catalog, phases |
| [docs/MILESTONES.md](docs/MILESTONES.md) | Build order M0–M9 with done-criteria |
| [docs/M0-SPEC.md](docs/M0-SPEC.md) | **Implement this first.** Full spec of the M0 walking skeleton |
| [AGENTS.md](AGENTS.md) | Conventions and rules for agents (and humans) working in this repo |

## Status

M0 walking skeleton implemented: the full DevCycle pipeline runs end-to-end against in-memory
stubs (`pnpm e2e`), zero token spend, no cluster, no real forge. See
[docs/M0-SPEC.md](docs/M0-SPEC.md) for what "M0" covers.

M1's five sub-projects (`claude`/`pi` backends, GitHub ports, worktree activities, `agentops.json`
config loading) are implemented and unit-tested. The remaining piece — wiring them together into a
working `engine start --issue N` path — is designed in
[docs/superpowers/specs/2026-07-03-m1-wiring-design.md](docs/superpowers/specs/2026-07-03-m1-wiring-design.md)
and not yet landed; until it does, the commands below still only exercise the in-memory demo path.
See [docs/MILESTONES.md](docs/MILESTONES.md) for the full build order.

## Quick start

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage
pnpm e2e
```

`pnpm e2e` runs the four required M0 scenarios against `TestWorkflowEnvironment` (time-skipping) —
no running Temporal server needed.

To run the pipeline manually against a local Temporal dev server:

```bash
# terminal 1
temporal server start-dev

# terminal 2
pnpm --filter @agentops/worker run start

# terminal 3
pnpm --filter @agentops/cli run cli start demo-task-1 "Add a widget"
pnpm --filter @agentops/cli run cli state demo-task-1
pnpm --filter @agentops/cli run cli signal demo-task-1 resume
```

The manual run uses the `stub` backend and in-memory tracker/scm ports (same as `pnpm e2e`) — it
exercises the real Temporal server and worker process, but still spends zero tokens and touches no
real repo.

## Running against a real repo (M1 target — pending the wiring plan)

Once [the M1 wiring design](docs/superpowers/specs/2026-07-03-m1-wiring-design.md) lands, the same
worker and CLI switch to real GitHub ports, a real `WorkspaceManager`, and the `claude`/`pi`
backends based on a single signal: whether `GITHUB_TOKEN` is set. No token → the demo path above,
unchanged. Token set → live mode, with a startup log line confirming which mode is active. Expected
usage once implemented:

```bash
# terminal 1
temporal server start-dev

# terminal 2
GITHUB_TOKEN=<token> pnpm --filter @agentops/worker run start

# terminal 3
GITHUB_TOKEN=<token> pnpm --filter @agentops/cli run engine start \
  --issue owner/repo#42 --repo owner/repo --product my-product --goal "..."
```

**This spends real tokens and opens a real PR** — only point `--repo` at a disposable test repo, and
make sure the product's `agentops.json` routing is set the way you intend before running it. Until
the wiring plan lands, `engine`/`--issue`/`--repo`/`--product`/`--goal` don't exist yet; use the demo
`cli start <taskId> <goal> [product] [repo] [issueRef]` form above instead.

## Target package layout (from ARCHITECTURE.md §5.9)

```
packages/
  contracts/    # zod schemas: TaskEvent, StageResult, Verdict, RunStats,
                # RoleManifest, ProductConfig
  ports/        # TrackerPort, ScmPort + adapters (github, gitea, linear, memory)
  backends/     # AgentBackend + adapters: claude, cursor, pi, codex, stub
  prompts/      # versioned prompt packs per stage/role
  policies/     # pure functions: repairLoop, brakes, verdictParse, feedbackHash
  workflows/    # devCycle, heal, bugHunt, securityReview, evalRun, qaSquad,
                # productProbe, metaOptimize, budgetReport, configSync
  activities/   # all I/O: runAgent, forge/tracker ops, workspace, stats
  gateway/      # webhook receiver → startWorkflow / signal
  worker/       # Temporal worker entrypoints
  cli/          # admin CLI: start, resume, clarify, inspect
  ui/           # Mission Control: React SPA + BFF
images/         # Dockerfiles: worker, gateway, agent-runner-<backend>
charts/         # Helm chart (values live in agentops-platform)
```

The load-bearing rule: **workflows are deterministic policy; activities are all I/O.** `policies/` must stay pure (no imports from Temporal, no I/O) — that's where the prototype's hard-won semantics live, protected by unit tests.
