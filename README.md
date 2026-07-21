# agentops-engine

The engine of **Agentic Ops** — a self-hosted home for autonomous dev agents.

Write your idea down as a tracker issue in the evening, add a label, go to sleep.
The engine designs, plans, implements, reviews, and babysits the PR until CI is
green — as a durable [Temporal](https://temporal.io) workflow that survives
crashes, redeploys, and provider rate limits. The agents themselves are pluggable
CLIs (`claude`, `pi`, …) running in disposable Kubernetes Jobs.

The guiding idea: **the human provides the intent; implementation, QA, monitoring,
delivery, bug fixing, and support can be automated.**

## The Software Lifecycle Development System (SLDS)

The SLDS is how Agentic Ops develops, repairs, and improves software. Humans
define the product vision, architecture, intent, and ideas; the SLDS turns that
direction into working software. This section is the source of truth for the
development lifecycle — every workflow change must move toward this model or
update it deliberately in the same PR.

### Software development cycle

- `devCycle` implements human-defined intent as a verified PR and hands it to the
  shared PR landing lifecycle.
- Autonomous recurring workflows — bug hunting, self-healing — continuously
  discover improvements and turn aligned findings into verified PRs through the
  same development cycle.
- PR landing brings a verified PR to merge-ready and either merges it when project
  policy grants Agentic Ops that authority or leaves it open for human handling.
- Autonomous work proceeds only when it is aligned with the product vision and
  architecture. Work that would change either requires a human decision first.

### Development workflows

- **Issue development (`devCycle`)** — turns an issue into a verified, reviewed PR
  and hands it to PR landing. Triggered by labeling a GitHub or Linear issue;
  Design → Plan → Implement → Review → PR babysit.
- **PR repair (`devCyclePrRepair`)** — responds to review feedback on an existing
  labeled PR, verifies the repair, and returns it to PR landing.
- **PR landing (`prLanding`)** — gives Agentic Ops-created and explicitly enrolled
  PRs one durable review, repair, verification, babysitting, and policy-controlled
  merge lifecycle.
- **Bug hunting (`whiteboxBugHunt`)** — scheduled read-only sweeps that inspect
  source, deduplicate findings, and file labeled issues that enter issue
  development.
- **Self-healing (`selfHeal`)** — inspects failed platform runs, diagnoses
  actionable failures, and starts issue development for proposed fixes to its own
  code.
- **Platform assistance (`platform`, `platformChat`)** — ask the running system
  about itself; it answers with Temporal history and logs as evidence, and can
  initiate development work.
- **Project workflows** — the [`agents` block](docs/project-config.md#the-agents-block)
  of a repo's `agentops.json` schedules built-in workflows (Tier 1); a project may ship
  its own Temporal workflows with `@agentic-ops/engine-sdk` running in its own worker
  (Tier 2) when its lifecycle cannot be expressed by configuration — see
  [authoring project workflows](docs/authoring-project-workflows.md).

### System principles

- **One connected system.** Findings become issues, issues become PRs, PR feedback
  becomes repairs, and platform failures become new development work.
- **One quality bar.** Every code-producing path converges on implementation,
  verification, review, PR babysitting, and the shared landing decision.
- **Durable autonomy.** Workflows are resumable, observable, bounded by brakes, and
  able to wait for human input without losing progress.
- **Humans set intent and authority.** Agents execute the lifecycle continuously;
  project policy determines approval and merge authority.
- **Reuse before invention.** New capabilities compose existing workflows and
  stages rather than create parallel delivery pipelines.
- **Extensible by projects.** Configuration is preferred; custom workflows are used
  only when the lifecycle shape is genuinely project-specific.

The engine realizes these with durable, resumable Temporal execution; OTel →
Loki/Tempo/Prometheus → Grafana observability; self-hosted, horizontally scalable
workers; multi-model, multi-provider routing with rate-limit fallback;
token/iteration budget brakes; and dogfooding — the system is built and maintained
by the agents it hosts.

## Architecture

This repo is the engine: workflows, activities, agent backends, images, and the
Helm chart. Deploy state (GitOps, Argo CD, secrets) lives in the companion
**`agentops-platform`** repo.

- [docs/temporal-architecture.md](docs/temporal-architecture.md) — how Temporal
  workflows, task queues, and workers map onto this repo's packages, and how the
  worker bursts agent runs out into disposable k8s Jobs.
- `packages/{contracts,ports,backends,policies,workflows,activities,worker,cli,gateway,control,ui,prompts,engine-sdk}` —
  workflows are deterministic policy; activities are all I/O; ports isolate
  forge/tracker SDKs; backends isolate agent CLIs. Working rules in
  [AGENTS.md](AGENTS.md).
- Historical feature design notes live in
  [docs/superpowers/specs/](docs/superpowers/specs/).

## Adding a product repo

Register the repo in Mission Control → **Projects**. Add
[`agentops.json`](docs/project-config.md) at the repo root so the engine
knows how to verify and route work. Point the repo's GitHub webhook at
`POST https://<gateway>/webhooks/github` (Issues events, shared secret) — then label an
issue `agentops` to start a run.

[`agentops.json`](docs/project-config.md) is the full project configuration: the verify
environment (commands, services, image), per-stage model routing and tiers, budget
brakes and timeouts, and auto-merge policy. Every field is optional — a missing file
uses full defaults. Auto-merge is `disabled` by default; enrolling **external** PRs also
requires the GitHub `Pull request` and `Pull request review` webhook events in addition
to `Issues`.

## Images & chart

Three images build from `images/`:

- `images/engine/Dockerfile --target worker` — the Temporal worker, same
  `tsx src/main.ts` entrypoint used locally.
- `images/engine/Dockerfile --target gateway` — the webhook receiver.
- `images/agent-runner/Dockerfile` — `git` + every agent backend's CLI
  (`claude`, `pi`) in one shared image; one disposable Job pod per agent call.

CI builds all three on every push/PR and, on merge to `main`, pushes immutable
`:<git-sha>` tags and commits that sha into `agentops-platform`'s values — Argo
CD auto-sync then rolls the cluster. No manual deploy step. (Requires the
`PLATFORM_PAT` repo secret: a fine-grained PAT scoped to the platform repo with
Contents read/write.)

`charts/engine/` is the Helm chart for the worker Deployment (RBAC to manage
agent-runner Jobs, shared workspace PVCs). It ships no real image tag or
registry — the platform repo supplies those as values overrides. Render locally:

```bash
helm template engine charts/engine --namespace <namespace>
```

## Docs

| Doc                                                                        | What it covers                                                 |
| -------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [docs/temporal-architecture.md](docs/temporal-architecture.md)             | Durable-execution architecture, package map, k8s Job bursting  |
| [docs/project-config.md](docs/project-config.md)                           | `agentops.json` project configuration reference                |
| [docs/authoring-project-workflows.md](docs/authoring-project-workflows.md) | Writing custom Tier-2 workflows with `@agentic-ops/engine-sdk` |
| [docs/project-worker-deployment.md](docs/project-worker-deployment.md)     | Deploying a Tier-2 project worker                              |
| [docs/runbooks/](docs/runbooks/)                                           | Operational runbooks                                           |
| [docs/superpowers/specs/](docs/superpowers/specs/)                         | Historical feature design notes                                |
| [docs/project-worker/](docs/project-worker/)                               | Reference Tier-2 project worker (Rollbar monitor)              |
