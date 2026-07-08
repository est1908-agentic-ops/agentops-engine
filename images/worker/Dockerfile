# syntax=docker/dockerfile:1
FROM node:22-slim AS runtime

# prepareWorkspace and GithubScmPort.push shell out to `git` from inside
# this container (packages/activities/src/workspace, packages/ports/src/github)
# — without it, git clone fails with `spawn git ENOENT` and (pre-fix) retries
# forever. See images/agent-runner/Dockerfile for the same pattern.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

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
COPY . .
RUN pnpm typecheck
RUN chown -R node:node /app

# Numeric, not the name "node": kubelet can't verify a pod's runAsNonRoot
# against a named image user without a matching explicit runAsUser in the
# pod spec (see charts/engine's podSecurityContext/containerSecurityContext).
USER 1000
CMD ["pnpm", "--filter", "@agentops/worker", "run", "start"]
