# syntax=docker/dockerfile:1
FROM node:22-slim AS runtime

# Same rationale as images/worker/Dockerfile and images/gateway/Dockerfile:
# baked-in pnpm, not `corepack enable` alone, to avoid a runtime fetch the
# dev-agents NetworkPolicy (GitHub + Anthropic + DNS only) would block.
RUN npm install --global pnpm@9.15.9

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @agentops/ui run build
RUN pnpm --filter @agentops/control run typecheck
RUN chown -R node:node /app

# Numeric, not the name "node": kubelet can't verify a pod's runAsNonRoot
# against a named image user without a matching explicit runAsUser in the
# pod spec (see charts/engine's podSecurityContext/containerSecurityContext).
USER 1000
CMD ["pnpm", "--filter", "@agentops/control", "run", "start"]
