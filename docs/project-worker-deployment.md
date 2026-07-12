# Deploying a Tier-2 project worker

A Tier-2 project (a custom Temporal workflow shape, e.g. a Rollbar monitor) runs
in its **own worker** that polls its own task queue and delegates privileged work
back to the engine (see `docs/superpowers/specs/2026-07-12-custom-agent-workflows-sp2-design.md`).
This doc covers **deploying** that worker.

## Model (why there's no per-project ArgoCD Application to hand-write)

- The worker is deployed by the generic `project-worker` Helm chart
  (`oci://gitactions.est1908.top/agentic-ops/project-worker`), rendered per project
  by one ArgoCD `ApplicationSet` in `agentops-platform`
  (`clusters/ops/project-workers/`).
- Temporal is a single shared namespace; the worker "registers" simply by polling
  its task queue `proj-<project>`. The engine reconciler starts the project's
  workflow **by name on that queue**; the worker (the only process polling it) runs it.

## Onboarding (Stage 1 — git-file list)

1. Your CI builds and pushes your worker image (`worker.ts` using
   `@agentic-ops/engine-sdk/worker`; see `examples/project-worker/`).
2. In `agentops-platform`, add an entry to `clusters/ops/project-workers/workers.yaml`:
   ```yaml
   - project: <slug>
     image: <registry>/<repo>/agentops-worker:<tag>
     # taskQueue omitted -> proj-<slug>
   ```
3. Merge the platform PR -> ArgoCD syncs -> your worker Deployment polls `proj-<slug>`.
4. In your repo, `agents.json` schedules your workflow with an explicit
   `"taskQueue": "proj-<slug>"` (the queue your worker polls). ConfigSync starts it there.

## What the worker pod gets — and does NOT get

- **Gets:** Temporal connection (the shared namespace), `PROJECT_TASK_QUEUE`, the
  OTLP endpoint, and any `externalSecretRefs` you declare (your own externals,
  provisioned as SOPS secrets in `agentops-platform`).
- **Does NOT get:** any engine credential (agent OAuth, per-project SCM tokens).
  Privileged work is delegated to the engine via `engineActivities()` /
  `childDevCycle()` — that omission is the security boundary.

> Stage 2 (repo-sourced onboarding — set the worker in your `agents.json`, no
> platform PR) is tracked separately (spec §12 SP-b).