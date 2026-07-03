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

## Layout

`packages/{contracts,ports,backends,policies,workflows,activities,worker,cli}` — workflows are deterministic policy; activities are all I/O. See [ARCHITECTURE.md §5.9](docs/ARCHITECTURE.md) for the full tree.
