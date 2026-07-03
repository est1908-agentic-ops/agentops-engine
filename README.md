# agentops-engine

Temporal workflows that turn tracker issues into merge-ready PRs via pluggable agent CLIs (`claude`, `pi`, `codex`, …). Builds images and worker code; deploy state lives in **`agentops-platform`** (GitOps, Helm, secrets).

**Docs:** [ARCHITECTURE.md](docs/ARCHITECTURE.md) · [MILESTONES.md](docs/MILESTONES.md) · [M0-SPEC.md](docs/M0-SPEC.md) · [AGENTS.md](AGENTS.md)

## Develop

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e
```

`pnpm e2e` uses `TestWorkflowEnvironment` — no Temporal server required.

## Run locally

Requires `GITHUB_TOKEN` (PAT with `repo` scope) in the environment or a repo-root `.env` file, a running Temporal dev server, and `agentops.json` in the target repo.

```bash
# terminal 1
temporal server start-dev

# terminal 2
pnpm worker

# terminal 3
pnpm engine start \
  --issue owner/repo#42 --repo owner/repo --product my-product --goal "..."
```

Inspect and signal:

```bash
pnpm engine state <task-id>
pnpm engine signal <task-id> resume
```

**Opens a real PR and spends real tokens** — use a disposable test repo and check routing in `agentops.json` first.

## Images & chart (M2)

Two images build from this repo:

- `images/worker/Dockerfile` — runs the worker via the same `tsx src/main.ts`
  entrypoint used locally (`pnpm worker`); see the engine-image-and-chart
  design doc for why this isn't a compiled `node dist/main.js` image.
- `images/agent-claude/Dockerfile` — `git` + the `claude` CLI, with a
  placeholder `step-ca-root.crt` baked in. **Before building this image for
  a real cluster**, replace `images/agent-claude/step-ca-root.crt` with the
  real root CA certificate exported from step-ca (see agentops-platform's
  platform-components design doc for the export command) — the placeholder
  lets the image build today but issues no real trust to internal services.

CI builds both on every push/PR and pushes to
`ghcr.io/flair-hr/agentops-engine/{worker,agent-claude}:<git-sha>` on merge
to `main`. Bumping the deployed tag is a manual PR to `agentops-platform`'s
`clusters/ops/engine/values.yaml` — no automated promotion bot yet.

`charts/engine/` is the Helm chart for the worker Deployment (RBAC to manage
agent-runner Jobs, the `workspace-tasks`/`workspace-cache` PVCs). It ships no
real image tag or registry — `agentops-platform` supplies those as a values
override. Render it locally with:

```bash
helm template engine charts/engine --namespace dev-agents
```

## Layout

`packages/{contracts,ports,backends,policies,workflows,activities,worker,cli}` — workflows are deterministic policy; activities are all I/O. See [ARCHITECTURE.md §5.9](docs/ARCHITECTURE.md) for the full tree.
