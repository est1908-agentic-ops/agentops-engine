# Consolidate Engine Dockerfiles + Drop Redundant Typechecks — Design

Status: draft · 2026-07-09 · Owner: Artem

## Context

`images/worker/Dockerfile`, `images/gateway/Dockerfile`, and `images/control/Dockerfile` are ~80% byte-identical: same base image, same pnpm bootstrap, the same 13-line workspace-manifest `COPY` block (added in `docs/superpowers/specs/2026-07-09-ci-image-build-caching-design.md`), the same `pnpm install --frozen-lockfile` line. Adding or removing a workspace package means editing that block in all three files, and it's easy to update two and forget the third.

Empirically (tested by fully wiping BuildKit's cache and building `worker` then `control` back to back): duplicating this block does **not** cost meaningful extra build time — BuildKit's layer cache is a hash chain, so `worker`'s extra `apt-get` step already prevents its layers from being reused by `gateway`/`control` today regardless of the duplication, and the pnpm-store cache mount (not the layer cache) is what captures most of the real install-time savings. So the value of consolidating is correctness/DRY, not raw speed.

Separately: all three Dockerfiles run their own `pnpm typecheck` (`worker`/`gateway`: full-repo `pnpm -r run typecheck`; `control`: scoped `pnpm --filter @agentops/control run typecheck`) as a build step. `.github/workflows/ci.yaml`'s `build-images` job already has `needs: build`, and the `build` job already runs the full-repo `pnpm typecheck` on the exact same commit before `build-images` starts. Every in-image typecheck is therefore redundant in the CI path — including `control`'s scoped one, since the root `typecheck` script is workspace-recursive and covers `@agentops/control` too.

## Goal

One Dockerfile with a shared `base` stage for the pnpm-workspace install, feeding three thin per-role stages (`worker`, `gateway`, `control`), with the now-redundant in-image typechecks removed.

## Non-goals

- `images/agent-runner/Dockerfile` — different base (no pnpm workspace install at all), not touched.
- The caching mechanics from the prior design (buildx `driver: docker`, the pnpm-store cache mount) — unchanged, just relocated into the new file.
- Reducing CI job count or adding parallelism — out of scope.
- Adding any new verification step to compensate for the removed in-image typechecks. Per explicit confirmation: these images are only ever built by CI, where the `build` job's gate already covers this; a local `docker build` is an impractically slow way to typecheck when `pnpm typecheck` is right there.

## Design

### 1. New consolidated Dockerfile

`images/engine/Dockerfile` (new file):

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-slim AS deps

# Baked-in pnpm, not `corepack enable` alone: corepack lazily downloads
# pnpm into the *current user's* cache on first invocation. Building as
# root then running as `node` means two different cache dirs, so a bare
# `corepack enable` re-fetches pnpm from the npm registry on every
# container start -- which the dev-agents NetworkPolicy (GitHub +
# Anthropic + DNS only, see platform-components design) will block.
RUN npm install --global pnpm@9.15.9

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
    pnpm install --frozen-lockfile --store-dir /pnpm-store --package-import-method copy

FROM deps AS base
COPY . .

# worker forks from `deps` (before the source COPY), not `base`, so this
# apt-get's cache key only depends on the manifest/lockfile chain, not on
# source changes. Forking from `base` instead would inherit COPY . .'s
# ever-changing digest, busting this layer (and its network apt-get call)
# on virtually every commit — it's cache-stable in the pre-consolidation
# worker-only Dockerfile precisely because it ran before any COPY at all.
FROM deps AS worker
# prepareWorkspace and GithubScmPort.push shell out to `git` from inside
# this container (packages/activities/src/workspace, packages/ports/src/github)
# — without it, git clone fails with `spawn git ENOENT` and (pre-fix) retries
# forever. See images/agent-runner/Dockerfile for the same pattern.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN chown -R node:node /app
# Numeric, not the name "node": kubelet can't verify a pod's runAsNonRoot
# against a named image user without a matching explicit runAsUser in the
# pod spec (see charts/engine's podSecurityContext/containerSecurityContext).
USER 1000
CMD ["pnpm", "--filter", "@agentops/worker", "run", "start"]

FROM base AS gateway
RUN chown -R node:node /app
USER 1000
CMD ["pnpm", "--filter", "@agentops/gateway", "run", "start"]

FROM base AS control
RUN pnpm --filter @agentops/ui run build
RUN chown -R node:node /app
USER 1000
CMD ["pnpm", "--filter", "@agentops/control", "run", "start"]
```

`images/worker/Dockerfile`, `images/gateway/Dockerfile`, `images/control/Dockerfile` are deleted.

**Why `deps`/`base` are split, not one stage:** an earlier version of this design had `worker` fork directly from a single `base` stage that already included `COPY . .`. Code review caught that this silently regressed `worker`'s `apt-get` layer — cache-stable forever in the pre-consolidation file because it ran before any `COPY` at all — into something invalidated on virtually every commit, since it would inherit `COPY . .`'s ever-changing digest. Splitting `deps` (manifest install, no source) from `base` (`deps` + full source) lets `worker` fork from `deps` and keep `apt-get` cache-stable, at the cost of one duplicated `COPY . .` line — a fair trade since that line is dirt cheap to (re-)run, unlike the `apt-get` network call it would otherwise gate.

### 2. CI wiring

In `.github/workflows/ci.yaml`'s `build-images` job, the three affected `docker/build-push-action@v6` steps switch from separate files to one file plus a `target`:

```yaml
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: images/engine/Dockerfile
          target: worker
          push: ${{ github.ref == 'refs/heads/main' }}
          tags: gitactions.est1908.top/agentic-ops/worker:${{ github.sha }}
```

(and the same shape for `gateway`/`control`, each with its own `target:` and `tags:`). `context: .` and every `tags:` value are unchanged. The `agent-runner` step (separate file, separate context) is untouched. Step order in the job is unchanged.

### 3. Documentation fix

`docs/ARCHITECTURE.md:246` currently reads:

```
images/         # Dockerfiles: worker, gateway, agent-runner (shared across backends, §5.4)
```

This is already stale (missing `control`, which predates this change). Update to:

```
images/         # Dockerfiles: engine (worker/gateway/control, one multi-stage
                # Dockerfile), agent-runner (shared across backends, §5.4)
```

## Verification

Local `docker buildx build --target <role> -f images/engine/Dockerfile -t <tag> .` for each of `worker`, `gateway`, `control`, confirming each still builds successfully without its former typecheck step. Re-run the same "touch `README.md`, rebuild, confirm `pnpm install` shows `CACHED`" check from the prior design on at least one target, to confirm consolidating the Dockerfile didn't regress the caching behavior already shipped.
