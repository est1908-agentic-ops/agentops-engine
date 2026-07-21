# Authoring Tier-2 project workflows

Tier 1 (agentops.json + built-in workflows) covers most cases. Use Tier 2 when you need a custom workflow structure (e.g. poll Rollbar, Linear, or an internal system) that no built-in provides.

## Install (in your project)

```bash
pnpm add @agentic-ops/engine-sdk @temporalio/workflow @temporalio/worker @temporalio/common @temporalio/client
```

## Project layout

```
agentops/
  workflows/rollbar-monitor.ts   # your workflow(s)
  activities/rollbar-fetch.ts    # optional: your secret-holding activities
  worker.ts                      # createEngineWorker
agentops.json                      # schedule it (with "taskQueue")
```

## Workflow example

```ts
import { engineActivities } from '@agentic-ops/engine-sdk/workflow';

export async function rollbarMonitor(input: { repo: string; project: string }) {
  const eng = engineActivities();
  // ... poll your source (using your activities) ...
  await eng.createIssue({
    repo: input.repo,
    project: input.project,
    title: 'bug',
    body: '...',
    labels: ['bug'],
    dedupeFingerprint: '...',
  });
  // or delegate a full fix:
  // await childDevCycle({ repo: input.repo, project: input.project, ... });
}
```

## Worker

```ts
import { createEngineWorker } from '@agentic-ops/engine-sdk/worker';

const worker = await createEngineWorker({
  taskQueue: 'proj-myapp',
  workflowsPath: require.resolve('./workflows'),
  activities: {/* your project activities */},
});
await worker.run();
```

## agentops.json

```json
{
  "agents": [
    {
      "name": "rollbar",
      "workflow": "rollbarMonitor",
      "schedule": "continuous",
      "input": { "repo": "acme/web", "project": "acme" }
    }
  ],
  "worker": {
    "image": "<registry>/<repo>/agentops-worker:<tag>",
    "externalSecrets": ["rollbar-token"]
  }
}
```

Omit `taskQueue` on agents — the reconciler defaults custom workflows to
`proj-<project>`, which matches `PROJECT_TASK_QUEUE` on the worker Deployment.

## Deploy

Your CI builds the worker image; the `worker` block in `agentops.json` drives
deployment via the generic `project-worker` Helm chart (no engine secrets).
See [project-worker-deployment.md](project-worker-deployment.md).

The engine stamps `project` in memo at start (from your agentops.json entry) and
enforces repo ownership on every privileged activity.

See [docs/project-worker/](project-worker/) for a full reference (Rollbar monitor),
[project-worker-deployment.md](project-worker-deployment.md) for deploying the
worker, and the [SLDS in the engine README](../README.md#the-software-lifecycle-development-system-slds)
for how project workflows fit into the wider development system.
