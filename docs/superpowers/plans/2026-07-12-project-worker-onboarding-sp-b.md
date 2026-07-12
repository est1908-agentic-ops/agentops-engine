# Per-project worker onboarding — SP-b (repo-sourced generator) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Make Tier-2 worker onboarding **one PR in the project repo** — a `worker` block in `agents.json`, surfaced to the ArgoCD ApplicationSet by a repo-reading generator endpoint — so the platform repo is never touched per project.

**Architecture:** The worker spec lives in the project's `agents.json` (`worker` block). A **gateway** endpoint (`POST /api/v1/getparams.execute`) reads it per managed project via the token the registry already decrypts and returns ArgoCD plugin-generator params. The endpoint is on the gateway — **not** the browser-facing, encrypt-only `control` (Option A; see spec v3 note). Project (non-built-in) workflows default their queue to `proj-<project>` so the worker Deployment and the schedule can't drift.

**Spec:** `docs/superpowers/specs/2026-07-12-project-worker-onboarding-design.md` (§5.2, §6, §7, §12 SP-b).

---

## Task breakdown (as built)

1. **contracts** — `ProjectWorkerSchema` + `AgentsManifestSchema.worker?`; `BUILTIN_WORKFLOWS` + `isBuiltinWorkflow`. Tests in `agents-manifest.test.ts`.
2. **policies** — `resolveAgentQueue(spec, project, engineQueue?)`, `projectQueue(project)`, `workerWarnings(manifest, project)`; `reconcileAgents` queue-diff uses `resolveAgentQueue` (behavior change: a project workflow with no explicit `taskQueue` now re-points off `ENGINE_QUEUE`). Tests in `reconcile-agents.test.ts`.
3. **activities/workflows** — `applyScheduleChanges` + `startContinuousAgent` resolve queues via `resolveAgentQueue`; `loadAgentsManifest` returns the full `AgentsManifest`; `configSync` computes `workerWarnings` and rides them on the result. `activities-api.ts` return type updated.
4. **gateway** — `createProjectWorkerParamsProvider({ managedProjectDeps, buildScm })` (reuses `loadManagedProjectRegistry` + `buildScm`) with the §6.4 last-good cache; route `POST /api/v1/getparams.execute` (bearer-token gated by `ARGOCD_PLUGIN_TOKEN`, 404 when off); `main.ts` wiring. Tests in `argocd-project-workers.test.ts` (provider happy path / no-worker / fail-safe / removal; route 404/401/200 shape).
5. **docs/examples** — `docs/project-worker-deployment.md` updated to the repo-sourced flow; `examples/project-worker/agents.json` gains a `worker` block; spec corrected to Option A.

## Deferred (not in this PR)

- **Part 2 — agentops-platform:** swap the `project-workers` ApplicationSet from the git-file generator to the ArgoCD **plugin generator** pointing at the gateway (`POST /api/v1/getparams.execute`), add the plugin config + `ARGOCD_PLUGIN_TOKEN` Secret, migrate each `workers.yaml` entry into that project's `agents.json` `worker` block, then delete `workers.yaml`. **Can only land after this PR merges and the gateway deploys** (the generator must be reachable). Runs against the live GitOps cluster → a deliberate, separately-reviewed platform PR, not automated here.
- **Mission Control view** — folds into #30's SP4 line; the generator's consumer is ArgoCD, not the UI, so it isn't required for repo-sourced onboarding.

## Green bar

`pnpm lint && pnpm typecheck && pnpm test` (+ `pnpm e2e` for the reconciler queue change and the gateway repo-read path).
