# CI: Speed Up Image Builds With Caching — Design

Status: draft · 2026-07-09 · Owner: Artem

## Context

`.github/workflows/ci.yaml`'s `build-images` job builds four images (`worker`, `agent-runner`, `gateway`, `control`) on every `main` push and every PR (build-only, no push, when `github.ref != 'refs/heads/main'`). These builds are slow, and get no benefit from caching today, for two independent reasons:

1. **The buildx builder is recreated every run.** `docker/setup-buildx-action@v3` defaults to the `docker-container` driver, which creates a uniquely-named, isolated BuildKit container per workflow run. Per `docs/superpowers/specs/2026-07-08-ci-self-hosted-runners-design.md`, CI now runs on the `est1908-agentic-ops` self-hosted runner pool. Per `/Users/est1908/work/personal/agent-vps/group_vars/all/vars.yml`, that pool is 4 runner *instances* (`count: 4`) registered on a single VPS (`agent_vps` in `playbook.yml`), all sharing one Docker daemon and one disk. So even though the host itself is persistent, each job's isolated builder container — and its cache — is thrown away the moment the job ends. Every build starts from zero layer cache regardless of the host's persistence.
2. **`images/worker/Dockerfile`, `images/control/Dockerfile`, and `images/gateway/Dockerfile` all `COPY . .` before `pnpm install --frozen-lockfile`.** Any change anywhere in the repo — including changes with no effect on dependencies — invalidates the install layer, forcing a full reinstall even when `pnpm-lock.yaml` didn't change. `images/agent-runner/Dockerfile` doesn't have this problem (no pnpm workspace install), but still suffers from cause 1.

## Goal

Make repeated `build-images` runs on this runner pool reuse work from previous runs: skip re-fetching/re-installing dependencies when they haven't changed, and skip re-running unaffected Docker layers entirely.

## Non-goals

- Parallelizing the four image builds into a matrix across the 4 runner instances. That's a wall-clock win via concurrency, not caching, and is a separate change.
- Registry-based (`type=registry`) or GitHub Actions (`type=gha`) cache backends. Both solve "cache portable across multiple machines," which isn't the problem here — the runner pool is one host. `type=registry` would also require wiring registry read credentials into PR-triggered builds (today `docker/login-action` only runs on `main` pushes); the self-hosted-runner design doc already flagged widening secret exposure to non-main jobs as a real cost, and there's no offsetting benefit here.
- Automated cache pruning/rotation (e.g. a cron job or ansible role). Flagged as a known operational cost below, not implemented as part of this change.
- Multi-platform builds. All four images build for a single architecture today; not changing that.

## Design

### 1. Stop recreating the buildx builder — use the host's built-in daemon driver

In `.github/workflows/ci.yaml`, change the `build-images` job's buildx setup:

```yaml
- uses: docker/setup-buildx-action@v3
  with:
    driver: docker
```

`driver: docker` uses the existing Docker Engine's built-in BuildKit worker instead of spinning up a separate `docker-container`. Since `dockerd` is the same long-lived, systemd-managed process across every job on this host (installed by the `docker` Ansible role, `enabled: true`), its content-addressed layer store persists naturally between builds — no explicit `cache-from`/`cache-to` config needed.

Trade-off: the `docker` driver doesn't support advanced cache exporters (`type=registry`, `type=gha`) or multi-platform builds. Neither is used here (see Non-goals), so this doesn't cost anything in practice.

### 2. Reorder the pnpm Dockerfiles so unrelated source changes don't bust the install layer

For `images/worker/Dockerfile`, `images/control/Dockerfile`, and `images/gateway/Dockerfile`, copy only the workspace manifests before installing, then copy the rest of the source. Everything before `WORKDIR /app` (the `apt-get`/`npm install --global pnpm@9.15.9` lines) is unchanged — only the block from `WORKDIR /app` through the old `COPY . .` + `pnpm install` pair is restructured:

```dockerfile
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/activities/package.json ./packages/activities/
COPY packages/backends/package.json  ./packages/backends/
COPY packages/cli/package.json       ./packages/cli/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/control/package.json   ./packages/control/
COPY packages/gateway/package.json   ./packages/gateway/
COPY packages/policies/package.json  ./packages/policies/
COPY packages/ports/package.json     ./packages/ports/
COPY packages/prompts/package.json   ./packages/prompts/
COPY packages/ui/package.json        ./packages/ui/
COPY packages/worker/package.json    ./packages/worker/
COPY packages/workflows/package.json ./packages/workflows/
RUN --mount=type=cache,target=/pnpm-store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir /pnpm-store
COPY . .
RUN pnpm typecheck   # (or the image-specific build/typecheck commands)
RUN chown -R node:node /app
```

All 11 workspace packages' `package.json` files must be copied regardless of which image is being built — `pnpm install --frozen-lockfile` in a pnpm workspace validates the *entire* workspace graph against the lockfile, so a missing member fails the install even if that package is irrelevant to this image.

Each Dockerfile keeps its own image-specific build/typecheck commands after the full `COPY . .` (e.g. `control`'s `pnpm --filter @agentops/ui run build` + `pnpm --filter @agentops/control run typecheck`) — those inherently need the full source and aren't cacheable further.

`images/agent-runner/Dockerfile` needs no reordering (it has no workspace install step); it benefits from change 1 alone.

### 3. Cache the pnpm store across installs, including lockfile changes

The `--mount=type=cache,target=/pnpm-store` line above (already shown in the reordered Dockerfiles) mounts a BuildKit cache volume for pnpm's package store, pointed at with `--store-dir /pnpm-store`. Unlike the image layer cache, this persists even when `pnpm-lock.yaml` changes and the install layer is invalidated — previously-downloaded package versions are reused from the mount instead of re-fetched over the network. `sharing=locked` avoids corruption if two builds on this host (e.g. concurrent PR runs on different runner instances) hit the mount at the same time.

Using an explicit `--store-dir` rather than relying on pnpm's default (`~/.local/share/pnpm/store`) avoids depending on pnpm's internal store-path/version scheme, which has changed across releases.

## Risks / operational notes

- **Unbounded disk growth.** Neither the daemon's layer cache nor the `/pnpm-store` mount is garbage-collected automatically. Over weeks/months this will consume disk on `agent_vps`. Not blocking this change, but an occasional `docker buildx prune` / `docker system prune` (manual, or a future ansible-managed cron) is a reasonable fast-follow.
- **Concurrent builds on the same daemon.** The 4 runner instances already share one `dockerd`; this change doesn't introduce new concurrency, but the pnpm store mount is the first thing that needs explicit lock handling (`sharing=locked`) because two simultaneous `pnpm install` calls could otherwise race on the same store.
- **If the runner pool ever grows to multiple physical machines**, this whole design stops working (a job could land on a cold host with no cache). At that point, revisit with a portable backend (`type=registry` is the natural fit, since the private registry already exists at `gitactions.est1908.top`) — this is why the design is scoped to "one persistent host," not treated as a generic pattern.
