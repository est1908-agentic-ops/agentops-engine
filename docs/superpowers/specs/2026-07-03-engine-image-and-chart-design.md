# Engine Image & Chart — Design

Status: draft · 2026-07-03 · Owner: Artem
Milestone: M2, sub-project 3 of 5 (see [decomposition](2026-07-03-m2-decomposition.md))

## Context

Nothing in `agentops-engine` builds a container image today — `packages/worker` runs via `tsx` against source, and there is no `images/` or `charts/` directory (ARCHITECTURE.md §5.9 names both as top-level, not yet created). M2 needs two images (the worker, and the `claude` agent-runner) and a Helm chart so `agentops-platform` has something to point an ArgoCD Application at. This sub-project has no dependency on the other four — it can be built and smoke-tested against any k3s cluster (even a throwaway `k3d`/`kind` one) before platform bootstrap lands for real.

## Goal

`docker build` produces a working worker image and a working `agent-claude` image; CI pushes both to GHCR on merge to `main`; a Helm chart in `charts/engine/` deploys the worker as a Deployment with the RBAC and PVCs the [K8s Job runner](2026-07-03-k8s-job-runner-design.md) sub-project needs.

## Non-goals

- `agent-pi` image — M2 only needs `claude` in-cluster (matches M1 wiring's live-mode default); add the second image when M5 brings the second backend live.
- Automated tag-bumping in `agentops-platform` — a human edits `values.yaml` for M2, per the decomposition doc's cross-cutting decision.
- Gateway image — M3.

## Components

### `images/worker/Dockerfile`

Multi-stage: build stage (`node:22-slim`, `pnpm install --frozen-lockfile`, `pnpm build` — the `build` script already exists per-package via `tsc`), runtime stage (`node:22-slim`, copy `dist/` + production `node_modules` only, non-root user, `CMD ["node", "packages/worker/dist/main.js"]`). No `claude`/`pi` CLI installed here — the worker never spawns them directly once the K8s Job runner lands; it only talks to the K8s API.

### `images/agent-claude/Dockerfile`

`node:22-slim` base + `git` + the `claude` CLI (`npm install -g @anthropic-ai/claude-code`, pinned version) + **step-ca's root cert baked in** (per ARCHITECTURE.md §5.1 — copied into the system trust store at build time; the exact cert content is supplied at build time from `agentops-platform`'s step-ca output, so this Dockerfile takes it as a build arg / build context file rather than hardcoding a placeholder). Non-root user (`USER node` or a dedicated uid), no other tooling — this image's only job is running one CLI invocation against a mounted workspace and exiting.

### CI: `.github/workflows/ci.yaml` (changed)

New job, gated on `push: branches: [main]` (never on `pull_request` — no reason to push images for unreviewed code):

```yaml
build-images:
  needs: build
  if: github.ref == 'refs/heads/main'
  runs-on: ubuntu-latest
  permissions:
    contents: read
    packages: write
  steps:
    - uses: actions/checkout@v4
    - uses: docker/login-action@v3
      with: { registry: ghcr.io, username: ${{ github.actor }}, password: ${{ secrets.GITHUB_TOKEN }} }
    - uses: docker/build-push-action@v6
      with: { context: ., file: images/worker/Dockerfile, push: true, tags: ghcr.io/<org>/agentops-engine/worker:${{ github.sha }} }
    - uses: docker/build-push-action@v6
      with: { context: ., file: images/agent-claude/Dockerfile, push: true, tags: ghcr.io/<org>/agentops-engine/agent-claude:${{ github.sha }} }
```

`<org>` resolved to the real GitHub org/user at implementation time. `GITHUB_TOKEN` here is the Actions-provided token (packages:write scope via the `permissions` block), unrelated to the live-mode `GITHUB_TOKEN` env var the engine itself reads — worth a one-line comment in the workflow file to avoid confusing the two.

### `charts/engine/` (new Helm chart)

```
charts/engine/
  Chart.yaml
  values.yaml                 # image.tag placeholder, replicas: 1, taskQueue, resources
  templates/
    deployment.yaml            # worker Deployment: image, env (TEMPORAL_ADDRESS, GITHUB_TOKEN from secretRef,
                               #   AGENT_RUNNER_IMAGE from values), volumeMounts for workspace PVC
    serviceaccount.yaml
    role.yaml                  # namespaced Role: jobs (create/get/list/delete), pods/log (get) — dev-agents namespace
    rolebinding.yaml
    pvc.yaml                   # workspace-cache and workspace-tasks PVCs (see below)
```

Two PVCs, both consumed by the [K8s Job runner](2026-07-03-k8s-job-runner-design.md):

- `workspace-cache` — base-clone cache (`WorkspaceManager`'s `cacheDir`), long-lived.
- `workspace-tasks` — per-task worktrees (`workspacesDir`), same lifecycle as today (cleaned up on terminal states).

Both mounted at a fixed path (`/workspace/cache`, `/workspace/tasks`) in the worker Deployment; the same PVC names/paths get mounted into every agent-runner Job pod by the K8s Job runner code, so a task's worktree is visible identically to the worker (which creates it via `prepareWorkspace`) and the Job pod (which runs the CLI inside it). `storageClassName` left as a values.yaml override — k3s's bundled `local-path` provisioner is the default assumption (RWO, single-node — accepted per the decomposition doc's cross-cutting note).

`values.yaml` exposes `image.workerTag` / `image.agentClaudeTag` (both default to a placeholder, real values come from `agentops-platform`'s override file — the chart itself ships no pinned tag), `temporalAddress`, `namespace` (default `dev-agents`).

## Testing strategy

- `docker build` for both images succeeds locally (CI enforces it via the new job; no unit tests for Dockerfiles beyond that).
- `helm template charts/engine` renders without error and is asserted against a golden-file snapshot (same convention as the prompts package's golden-file tests) covering: Deployment env vars present, Role verbs match exactly `["create","get","list","watch","delete"]` on `jobs` and `["get"]` on `pods/log`, PVC names match what the K8s Job runner design expects.
- Manual: `helm install --dry-run` against a throwaway `k3d` cluster before this is wired into `agentops-platform` for real.

## Named risks

- **Image size / cold-start latency for `agent-claude`.** Every stage's Job pod is a fresh container; if the image isn't cache-warm on the node, pull time adds wall-clock to every stage. Mitigated by `imagePullPolicy: IfNotPresent` (set in the Job spec, not this chart) and accepting the cost for M2 — revisit if per-stage latency becomes a real complaint post-M2.
- **Baking the step-ca root cert into the image couples this Dockerfile to platform bootstrap's output.** For M2's first cut, the cert is supplied as a build-context file checked in by whoever runs the build after step-ca is up (manual step, documented in the README); a fully automated "platform publishes its CA cert, engine CI consumes it" pipeline is more machinery than M2's gate requires.

## Package/file summary

- **New:** `images/worker/Dockerfile`, `images/agent-claude/Dockerfile`.
- **New:** `charts/engine/` (Chart.yaml, values.yaml, templates/*).
- **Changed:** `.github/workflows/ci.yaml` (new `build-images` job).
- **Changed:** `README.md` (document image build/push, the step-ca cert build-context step).

## Open questions carried forward

- Real `<org>` GHCR namespace — placeholder until implementation time.
- Whether `agent-claude`'s CLI version should be pinned via Dockerfile `ARG` (rebuildable) or hard-coded — lean `ARG` with a default, no strong opinion yet; decide during implementation.
