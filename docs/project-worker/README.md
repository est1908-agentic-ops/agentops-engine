# Reference Tier-2 project worker (Rollbar monitor)

Copy this layout into **your project repo** — it is documentation, not a runnable
package in the engine monorepo. It shows the canonical Tier-2 pattern from
[custom agent workflows SP2](../superpowers/specs/2026-07-12-custom-agent-workflows-sp2-design.md):

- **Project-owned activities** hold your secrets (`rollbarFetch` reads
  `ROLLBAR_ACCESS_TOKEN` from the worker pod).
- **Engine delegation** via `engineActivities()` / `engineAgent()` / `childDevCycle()`
  on `agentops-engine` — no engine credentials in the project worker.
- **Continuous agent** with a durable cursor and `continueAsNew` to bound Temporal
  history on long-running polls.

## Layout

```
agentops/
  worker.ts                      # createEngineWorker — polls proj-<project>
  activities/rollbar-fetch.ts    # your secret-holding I/O
  workflows/rollbar-monitor.ts   # orchestration only (deterministic)
agents.json                      # schedule + worker block (deploy signal)
```

## Dependencies (in your project)

```bash
pnpm add @agentic-ops/engine-sdk @temporalio/workflow @temporalio/worker @temporalio/common @temporalio/client
```

## agents.json

The `worker` block marks the project Tier-2. Omit `taskQueue` on agents — the
reconciler defaults custom workflows to `proj-<project>` (same queue the worker
polls). See [agents.json](../agents-json.md) and
[project-worker-deployment.md](../project-worker-deployment.md).

## Security boundary

The worker Deployment mounts **only** Temporal connection config and your
`externalSecrets`. Privileged forge/agent work runs on the engine fleet; the
engine stamps `project` in workflow memo at start and rejects cross-repo calls.

## Deploy

Build a container whose entrypoint runs `agentops/worker.ts`, push the image, and
write the tag into `agents.json`'s `worker.image`. ConfigSync + the gateway's
ArgoCD generator deploy the generic `project-worker` Helm chart — no hand-written
Application per project. Details: [project-worker-deployment.md](../project-worker-deployment.md).

## Files in this reference

| File | Role |
|------|------|
| [agents.json](./agents.json) | Continuous agent + worker image/secrets |
| [agentops/worker.ts](./agentops/worker.ts) | Worker bootstrap |
| [agentops/activities/rollbar-fetch.ts](./agentops/activities/rollbar-fetch.ts) | Rollbar API (project secret) |
| [agentops/workflows/rollbar-monitor.ts](./agentops/workflows/rollbar-monitor.ts) | Poll → file issues → optional devCycle |

See also [authoring-project-workflows.md](../authoring-project-workflows.md) for the
conceptual walkthrough.
