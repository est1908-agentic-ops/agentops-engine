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

Pre-M0. Nothing is implemented yet — the next commit after this scaffold should start the M0 walking skeleton per [docs/M0-SPEC.md](docs/M0-SPEC.md).

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
