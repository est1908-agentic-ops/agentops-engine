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
- `ENGINE_DB_HOST`/`PORT`/`NAME`/`USER`/`PASSWORD` (all optional together) — enable `/api/tiers` PUT, `/api/settings/self-heal`, and `/api/budgets` (Postgres-backed model tiers / self-heal schedule / run-stats)
- `MANAGED_PROJECTS_DIR` (default `/etc/managed-projects`) — directory mounted from the `managed-projects` ConfigMap; read by `FileManagedProjectStore` to back the `/api/projects`, `/api/projects/:repo`, and `/api/registry/repos` routes (all gated by `CONTROL_CRUD_TOKEN`). The console has no write path onto this registry anymore — see `docs/superpowers/plans/2026-07-25-engine-projects-configmap-resolver.md`
- `CONTROL_CRUD_TOKEN` — bearer token, sent as `X-Control-Crud-Token`, gating every `/api/*` route (both reads and writes). Unset means all `/api/*` routes return 401 (fail-closed); only `/healthz` and static SPA assets are served without a token

## Production

Serves `packages/ui`'s built static assets itself once
`pnpm --filter @agentops/ui run build` has produced `packages/ui/dist` — see
`images/engine/Dockerfile`'s `control` target. Locally, run `packages/ui`'s
own Vite dev server instead (see `packages/ui/README.md`), which proxies
`/api/*` here.
