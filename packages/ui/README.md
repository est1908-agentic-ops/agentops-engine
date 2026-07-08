# @agentops/ui

Platform Console — a minimal Vite + React SPA for starting and watching
`platform` Temporal workflow runs. Talks only to `packages/control`'s `/api/*`
routes; no direct Temporal SDK usage in the browser.

## Run locally

Needs `packages/control` running on port 3001 (see its own README) — this
dev server proxies `/api/*` there.

```bash
pnpm --filter @agentops/ui dev
```

Open http://localhost:5173.

## Build

```bash
pnpm --filter @agentops/ui build
```

Output goes to `packages/ui/dist`, which `packages/control` serves directly
in production (see `packages/control/src/main.ts` and
`images/control/Dockerfile`) — there is no separate ui deployment.

## Routes

- `/` — prompt input, suggested-prompt chips, optional hint-repos, and a
  table of recent `platform` runs.
- `/runs/:workflowId` — live status (polls every 3s while `RUNNING`), then
  the run's summary, actions taken, and any child `devCycle` fixes it
  started, plus a link to the run in Temporal Web UI.

Full design: `docs/superpowers/specs/2026-07-07-platform-console-design.md`.
