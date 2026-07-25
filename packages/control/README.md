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
- `MANAGED_PROJECTS_DIR` (default `/etc/managed-projects`) — directory mounted from the `managed-projects` ConfigMap; read by `FileManagedProjectStore` to back the read-only `/api/projects`, `/api/projects/:repo`, and `/api/registry/repos` routes. The console has no write path onto this registry anymore — see `docs/superpowers/plans/2026-07-25-engine-projects-configmap-resolver.md`
- `CONTROL_CRUD_TOKEN` — bearer token, sent as `X-Control-Crud-Token`, gating every mutating route control exposes: `POST /api/platform/runs`, `POST /api/devcycle/runs`, `/api/platform/chats/*`, `PUT /api/tiers`, `PUT /api/settings/self-heal`, `POST /api/agents/:id/run`. Unset means all of these return 401 (fail-closed); read-only GETs (including `/api/projects`) are never gated by it

## Production

Serves `packages/ui`'s built static assets itself once
`pnpm --filter @agentops/ui run build` has produced `packages/ui/dist` — see
`images/engine/Dockerfile`'s `control` target. Locally, run `packages/ui`'s
own Vite dev server instead (see `packages/ui/README.md`), which proxies
`/api/*` here.
