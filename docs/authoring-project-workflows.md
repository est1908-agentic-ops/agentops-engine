# Authoring Tier-2 project workflows

Tier 1 (agents.json + built-in workflows) covers most cases. Use Tier 2 when you need a custom workflow structure (e.g. poll Rollbar, Linear, or an internal system) that no built-in provides.

## Install (in your project)

```bash
pnpm add @agentops/engine-sdk @temporalio/workflow @temporalio/worker @temporalio/common @temporalio/client
```

## Project layout

```
agentops/
  workflows/rollbar-monitor.ts   # your workflow(s)
  activities/rollbar-fetch.ts    # optional: your secret-holding activities
  worker.ts                      # createEngineWorker
agents.json                      # schedule it (with "taskQueue")
```

## Workflow example

```ts
import { engineActivities } from '@agentops/engine-sdk/workflow';

export async function rollbarMonitor(input: { repo: string; project: string }) {
  const eng = engineActivities();
  // ... poll your source (using your activities) ...
  await eng.createIssue({ repo: input.repo, project: input.project, title: 'bug', body: '...', labels: ['bug'], dedupeFingerprint: '...' });
  // or delegate a full fix:
  // await childDevCycle({ repo: input.repo, project: input.project, ... });
}
```

## Worker

```ts
import { createEngineWorker } from '@agentops/engine-sdk/worker';

const worker = await createEngineWorker({
  taskQueue: 'proj-myapp',
  workflowsPath: require.resolve('./workflows'),
  activities: { /* your project activities */ },
});
await worker.run();
```

## agents.json

```json
{ "agents": [{ "name": "rollbar", "workflow": "rollbarMonitor", "schedule": "continuous", "taskQueue": "proj-myapp" }] }
```

## Deploy

Normal Deployment in the shared `proj` namespace. Mount only Temporal connection + your secrets. **No engine secrets**.

The engine stamps `project` in memo at start (from your agents.json entry) and enforces repo ownership on every privileged activity.

See `examples/project-worker/` for a full reference.
```

See the SP2 design and plan for security model and continuous vs scheduled details.
