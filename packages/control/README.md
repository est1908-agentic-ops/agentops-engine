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
- `TEMPORAL_UI_BASE_URL` (required) — e.g. `http://localhost:8233` locally, or the cluster's Temporal Web UI host
- `PORT` (default `3001`)
- `ENGINE_DB_HOST`/`PORT`/`NAME`/`USER`/`PASSWORD`, `PROJECT_CREDENTIAL_PUBLIC_KEY`, `CONTROL_CRUD_TOKEN` (all optional together) — enable the `/api/projects` managed-project CRUD routes and the `/api/registry/repos` hint-repos picker (sourced from the managed-project list; empty with no store configured)

## Production

Serves `packages/ui`'s built static assets itself once
`pnpm --filter @agentops/ui run build` has produced `packages/ui/dist` — see
`images/engine/Dockerfile`'s `control` target. Locally, run `packages/ui`'s
own Vite dev server instead (see `packages/ui/README.md`), which proxies
`/api/*` here.

### Access control

The public console (API + UI) is protected by Traefik HTTP basic-auth at the
ingress edge (issue #4). The `Authorization` header is consumed by Traefik and
never reaches the application. Mutating API routes (`POST`/`PUT` to `/api/projects`
and `/api/tiers`) additionally require the `X-Control-Crud-Token` custom header as
a second factor.
