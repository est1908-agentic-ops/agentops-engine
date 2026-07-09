# @agentops/control

Node HTTP BFF for the platform console — starts and inspects `platform`
Temporal workflow runs on behalf of `packages/ui`, via `@temporalio/client`.
No framework, plain `node:http`, matching `packages/gateway`'s convention.

## Run locally

Requires a running Temporal dev server (`temporal server start-dev`) and a
worker registered on the `agentops-devcycle` task queue.

```bash
TEMPORAL_UI_BASE_URL=http://localhost:8233 pnpm --filter @agentops/control run start
```

## Env vars

- `TEMPORAL_ADDRESS` (default `localhost:7233`)
- `TEMPORAL_NAMESPACE` (default `default`)
- `TASK_QUEUE` (default `agentops-devcycle`)
- `PROJECT_REGISTRY_JSON` (optional) — same format the worker/gateway use; only `repo` slugs are read, no tokens required
- `TEMPORAL_UI_BASE_URL` (required) — e.g. `http://localhost:8233` locally, or the cluster's Temporal Web UI host
- `PORT` (default `3001`)

## Production

Serves `packages/ui`'s built static assets itself once
`pnpm --filter @agentops/ui run build` has produced `packages/ui/dist` — see
`images/engine/Dockerfile`'s `control` target. Locally, run `packages/ui`'s
own Vite dev server instead (see `packages/ui/README.md`), which proxies
`/api/*` here.
