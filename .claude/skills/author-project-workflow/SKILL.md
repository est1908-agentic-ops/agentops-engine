# author-project-workflow

Use when asked to add a custom Tier-2 workflow for a project (anything beyond agents.json + built-ins).

Steps:
1. Install the SDK in the target project.
2. Write `agentops/workflows/<name>.ts` using `engineActivities()`, `engineAgent()`, `childDevCycle()` from `@agentops/engine-sdk/workflow`.
3. Add project-owned activities (for the project's own secrets) under `agentops/activities/`.
4. Write `agentops/worker.ts` using `createEngineWorker` from `@agentops/engine-sdk/worker`.
5. Add entry to `agents.json` with `"schedule": "continuous"` (or cron); omit `taskQueue` unless you need a non-default queue (`proj-<project>` is the default).
6. Deploy as a normal worker Deployment (shared proj ns, no engine secrets).

Reference: `docs/project-worker/`
Guide: `docs/authoring-project-workflows.md`

Never put engine credentials in a project worker.
