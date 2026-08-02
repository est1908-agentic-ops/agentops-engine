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

## Read-only repository sessions

Use a repository session when one custom workflow needs an agent to inspect one
to five repositories. The workflow's owner project may always read its primary
repository; it may read any additional repository only when its managed-project
configuration lists that repository in `readRepositories`. The allowlist uses
short `owner/name` values and never supplies another credential. A single
workflow may create different sessions for different authorized repository sets.

For example, the project owning `acme/app` explicitly allows its worker to read
`acme/shared-contracts`:

```yaml
# managed project configuration for acme/app
project: acme-app
repo: https://github.com/acme/app
tokenSecret: acme-app-github
readRepositories:
  - acme/shared-contracts
```

The engine resolves every requested ref to an immutable commit before returning
the session. Treat the returned checkout paths and commits as an audit record,
not as branches to publish. A session is for reading and running agents only:
do not pass a GitHub token to the agent, and do not ask it to create commits,
branches, pull requests, issues, or comments.

```ts
import { engineAgent, parseAgentResult } from '@agentic-ops/engine-sdk/workflow';

export async function compareRepositories() {
  const eng = engineAgent();
  const session = await eng.createRepositorySession({
    taskId: 'compare-api-contracts',
    repositories: [
      { repo: 'acme/app', ref: 'main' }, // the owner project's primary repo
      { repo: 'acme/shared-contracts', ref: 'main' }, // explicit readRepositories entry
    ],
  });

  try {
    const first = await eng.runAgent({
      taskId: 'compare-api-contracts',
      stage: 'agent',
      attempt: 1,
      backend: 'claude',
      model: 'example-model',
      promptRef: 'generic-task.md',
      promptContext: {
        taskId: 'compare-api-contracts',
        instructions: 'Compare the API client against the shared contracts.',
        outputContract: '{"compatible":boolean,"notes":string[]}',
      },
      workspaceRef: session.workspaceRef,
      limits: { maxTokens: 12_000, timeoutMs: 20 * 60_000 },
    });
    const analysis = parseAgentResult(first.output);

    // Reuse the same session sequentially. Do not run calls concurrently on a
    // session unless a future API contract explicitly says that is supported.
    const second = await eng.runAgent({
      taskId: 'compare-api-contracts',
      stage: 'agent',
      attempt: 2,
      backend: 'claude',
      model: 'example-model',
      promptRef: 'generic-task.md',
      promptContext: {
        taskId: 'compare-api-contracts',
        instructions: 'Review the first analysis and report only actionable gaps.',
        outputContract: '{"gaps":string[]}',
      },
      workspaceRef: session.workspaceRef,
      limits: { maxTokens: 12_000, timeoutMs: 20 * 60_000 },
    });
    const review = parseAgentResult(second.output);

    // The parser returns unknown | undefined: validate analysis and review
    // against your own schema before relying on either result.
    return { analysis, review, repositories: session.repositories };
  } finally {
    // Always release the engine-managed checkout, even when an agent fails.
    await eng.cleanupRepositorySession({ workspaceRef: session.workspaceRef });
  }
}
```

`generic-task.md` accepts caller-defined `instructions` up to 32 KiB UTF-8 and
an `outputContract` up to 16 KiB UTF-8. It requires the agent's final output to
be exactly one `AGENT_RESULT: <JSON>` sentinel on its final line. The sentinel
is not proof of correctness: define the JSON contract yourself, parse with
`parseAgentResult`, then validate the unknown result before making a decision.

`runAgent` refreshes the session's idle lease. A session is pruned only after
it has been idle for **more than 24 hours** (not at the exact 24-hour mark), so
that expiry is a safety net rather than a cleanup replacement. Reuse calls in
sequence and always call cleanup in `finally`; concurrent access is not part of
this SDK contract.

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
