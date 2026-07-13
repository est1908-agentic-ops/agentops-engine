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

# Own /app as node, then build as uid 1000 so every file pnpm writes is born
# node-owned. This replaces a post-install `chown -R node:node /app` that had
# to walk the entire copied node_modules tree (676 packages materialized as
# real files by --package-import-method copy) and cost ~130s on every build
# where a manifest changed — the single dominant vertex in the image build.
# Two consequences of installing as non-root: COPY ignores the active USER and
# writes root-owned unless told, so each manifest copy is --chown=node:node;
# and the pnpm store cache mount is owned by 1000 so the install can write it.
# `deps` is restored to root at the end so stages forking from it (worker's
# apt-get) still run privileged; file ownership set here is unaffected.
RUN chown node:node /app
USER node
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node packages/activities/package.json ./packages/activities/
COPY --chown=node:node packages/backends/package.json  ./packages/backends/
COPY --chown=node:node packages/cli/package.json       ./packages/cli/
COPY --chown=node:node packages/contracts/package.json ./packages/contracts/
COPY --chown=node:node packages/control/package.json   ./packages/control/
COPY --chown=node:node packages/gateway/package.json   ./packages/gateway/
COPY --chown=node:node packages/policies/package.json  ./packages/policies/
COPY --chown=node:node packages/ports/package.json     ./packages/ports/
COPY --chown=node:node packages/prompts/package.json   ./packages/prompts/
COPY --chown=node:node packages/ui/package.json        ./packages/ui/
COPY --chown=node:node packages/worker/package.json    ./packages/worker/
COPY --chown=node:node packages/workflows/package.json ./packages/workflows/
RUN --mount=type=cache,target=/pnpm-store,uid=1000,gid=1000,sharing=locked \
    pnpm install --frozen-lockfile --store-dir /pnpm-store --package-import-method copy
USER root

FROM deps AS base
COPY --chown=1000:1000 . .

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
# Cache the apt index and downloaded archives across builds (persists in the
# self-hosted runners' long-lived buildkitd). node:slim ships a `docker-clean`
# apt hook that deletes /var/cache/apt/*.deb after each install — remove it in
# the same RUN (before apt reads its config) or the archive cache mount is a
# no-op. No `rm -rf /var/lib/apt/lists/*`: cache-mount contents are never
# committed to the image layer, so they don't bloat it, and removing them
# would wipe the very cache this is meant to keep.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates
COPY --chown=1000:1000 . .
# Numeric, not the name "node": kubelet can't verify a pod's runAsNonRoot
# against a named image user without a matching explicit runAsUser in the
# pod spec (see charts/engine's podSecurityContext/containerSecurityContext).
USER 1000
# `pnpm run start` (a "run script" invocation) does not forward SIGTERM to
# the tsx/node process it spawns -- pnpm swallows the signal and reports its
# own lifecycle failure instead, so the child never sees it. `pnpm exec`
# execs the target directly without that wrapper, so SIGTERM reaches
# Worker.run()'s built-in handler and it can drain gracefully instead of the
# pod being SIGKILLed mid runAgent activity. See issue devcycle:...:12
# (2026-07-13): two runAgent retries in one workflow both traced via Loki to
# `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL ... Command failed with signal
# "SIGTERM"` on the pod a rollout had just evicted; confirmed with a minimal
# repro that `pnpm run <script>` eats SIGTERM but `pnpm exec <bin>` doesn't.
CMD ["pnpm", "--filter", "@agentops/worker", "exec", "tsx", "src/main.ts"]

FROM base AS gateway
USER 1000
CMD ["pnpm", "--filter", "@agentops/gateway", "exec", "tsx", "src/main.ts"]

FROM base AS control
# Build as uid 1000, not root: /app is already fully owned by node:node
# (born node-owned in `deps`, copied with --chown in `base`), so there's no
# need for another whole-tree `chown -R` after this writes new files.
USER 1000
RUN pnpm --filter @agentops/ui run build
CMD ["pnpm", "--filter", "@agentops/control", "exec", "tsx", "src/main.ts"]
