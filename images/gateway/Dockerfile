# syntax=docker/dockerfile:1
FROM node:22-slim AS runtime

# Same rationale as images/worker/Dockerfile: baked-in pnpm, not `corepack
# enable` alone, to avoid a runtime fetch the dev-agents NetworkPolicy
# (GitHub + Anthropic + DNS only) would block.
RUN npm install --global pnpm@9.15.9

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm typecheck
RUN chown -R node:node /app

USER node
CMD ["pnpm", "--filter", "@agentops/gateway", "run", "start"]
