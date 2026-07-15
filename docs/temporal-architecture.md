# Temporal architecture

How a Temporal workflow, task queue, and worker combine into durable execution,
and how `agentops-engine`'s own packages sit on top of that — including where the
worker bursts out into disposable k3s `Job`s.

## The primitive: code that survives a crash

A **Workflow** is just a function — but every await point it crosses is durably
recorded. If the process running it dies mid-execution, another worker replays the
recorded history and resumes exactly where it left off. The workflow itself never
touches the outside world: every side effect — cloning a repo, calling an LLM,
opening a PR — is delegated to an **Activity**, which retries independently without
re-running anything upstream of it.

```
┌────────────┐   proxyActivities()   ┌────────────┐
│  Workflow  │ ─────────────────────▶│  Activity  │
│ deterministic,                     │ the actual │
│ no I/O                             │ side effect│
└─────┬──────┘                       └─────┬──────┘
      │                                    │
      └─────────────────┬──────────────────┘
                         ▼
             ┌───────────────────────┐
             │     Event History     │
             │ durable log both boxes│
             │ above replay from     │
             │ after a crash/redeploy│
             └───────────────────────┘
```

```ts
// packages/workflows/src/dev-cycle.ts
proxyActivities<DevCycleActivities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 5 },
});
```

## What event history stores

History is an **append-only log per workflow execution** (`workflowId` + `runId`),
owned by Temporal's History service and persisted to its backing store. On replay
the worker re-runs workflow code and uses the log to skip finished steps — it does
**not** reload workflow-local variables from anywhere else.

**In history:**

| Event kind     | What gets serialized                                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow start | Workflow type, **input args** (`TaskInput` for `devCycle`), task queue, memo, search attributes                                                                              |
| Each activity  | **Input** on schedule, **return value** (or failure) on completion — e.g. `prepareWorkspace` → `{ workspaceRef, branch }`, `runAgent` → `{ output, tokensIn, tokensOut, … }` |
| Timers         | `sleep()` in `pr_babysit` — fire time is fixed at schedule time                                                                                                              |
| Signals        | `stop`, `cancel`, `resume`, `clarify` — name + payload, replayed in order                                                                                                    |
| Workflow end   | Final **result** (`DevCycleState`) or failure                                                                                                                                |

Activity **heartbeats** (K8s Job poll progress during `runAgent`) are kept on the
activity attempt for timeout/debugging; they are not replayed like completions.

**Not in history** (side effects or derived state elsewhere):

- Live `DevCycleState` from `query('state')` — computed on read, never appended
- Git worktree contents — only the `workspaceRef` path string crosses the activity boundary; files live on the shared PVC
- PRs, issues, labels — forge/tracker APIs
- `agent_run_stats` rows — Postgres via `recordRunStats`

Inspect a run from Mission Control's Temporal link, or
`…/workflows/<workflowId>/<runId>/history` in the Temporal UI.

## The cluster: four services behind one address

Everything a client or a worker talks to is one gRPC endpoint (`TEMPORAL_ADDRESS`)
fronted by the **Frontend** service. Frontend routes workflow-state calls to
**History**, which owns each workflow's event log and state machine, and
task-dispatch calls to **Matching**, which holds every task queue and pairs queued
tasks with polling workers. Both persist to a durable store, plus a separate
**visibility** store the Web UI and "list workflows" queries hit.

```
Client SDK                                        Worker
(control, cli)                                    (packages/worker)
     │                                                  │
     ▼                                                  ▼
 Frontend ────────▶ History ────────▶ Matching ────────▶ Persistence
 (gRPC gateway)     (event log +      (holds task         (+ visibility
                      state machine)   queues)              store)
```

This chart doesn't stand up that cluster — a pre-install Helm hook just ensures its
namespace exists (`temporal operator namespace create` against `TEMPORAL_ADDRESS`,
`charts/engine/templates/temporal-namespace-job.yaml`). The Frontend/History/
Matching/Persistence cluster itself is treated as infrastructure this repo only ever
points at.

## Task queues and workers

`agentops-engine` isn't a message broker — it's a name Matching uses as a
rendezvous point. A worker opens a long-poll connection and blocks until Matching
has something for it. Two kinds of tasks land on the same queue: **Workflow Tasks**
(run workflow code, decide the next step) and **Activity Tasks** (run one activity
to completion). One process can poll for both — and here, does.

```
             ┌─────────────────────────┐
             │        Task Queue        │
             │      agentops-engine     │
             └────────────┬─────────────┘
                           │
             ┌─────────────┴─────────────┐
             ▼                           ▼
   ┌───────────────────┐       ┌───────────────────┐
   │  Workflow tasks    │       │  Activity tasks    │
   │  what's next?      │       │  run this one step  │
   └──────────┬─────────┘       └──────────┬──────────┘
              │                            │
              └─────────────┬──────────────┘
                             ▼
             ┌─────────────────────────┐
             │      Worker process      │
             │ one pod polls both lanes │
             │ packages/worker          │
             └─────────────────────────┘
```

This worker actually opens **two** queues at once — `agentops-engine` and the
legacy `agentops-devcycle` — during a cutover (`packages/worker/src/main.ts`), so
old and new callers are served by the same pods.

## Where agentops-engine's packages sit

Every generic term above maps onto a specific package, in the same order a task
flows through them:

| Concept        | Package / identifier                                          | Detail                                                                                                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client         | `packages/control`, `packages/cli`                            | calls `client.workflow.start(devCycle, { taskQueue: ENGINE_QUEUE })`                                                                                                                                                                                                                                 |
| Task queue     | `ENGINE_QUEUE = 'agentops-engine'`                            | + `LEGACY_ENGINE_QUEUE = 'agentops-devcycle'` — `packages/contracts/src/engine-queue.ts`                                                                                                                                                                                                             |
| Worker process | `packages/worker`                                             | `createWorker()` in `create-worker.ts`, started from `main.ts`                                                                                                                                                                                                                                       |
| Workflow code  | `packages/workflows`                                          | `devCycle`, `prLanding`, `platform`, `self-heal`, `reconcileAllProjects`, `configSync`, `whiteboxBugHunt`, `platformChat` — after `devCycle` opens a PR it hands the shared PVC worktree to a child `prLanding` run (`patched('shared-pr-landing-v1')`); only the landing child cleans that worktree |
| Activity code  | `packages/activities` → `packages/backends`, `packages/ports` | agent CLIs, LiteLLM, GitHub/Linear — never imported directly by a workflow, only proxied                                                                                                                                                                                                             |
| Query / signal | `stateQuery`, `conversationQuery` (`defineQuery`)             | `control`'s `handleGetDevCycleRun` calls `handle.query('state')` for a live snapshot; `stop`/`cancel`/`resume`/`clarify` signals push the other way, no queue involved                                                                                                                               |

## Bursting into k3s

The worker itself is boring infrastructure — a single k3s `Deployment` that never
stops polling `agentops-engine`. But the moment a `runAgent` activity actually needs
to run `claude` or `pi`, it doesn't do that in-process — `K8sJobRunner`
(`packages/backends/src/k8s/k8s-job-runner.ts`) opens the cluster's Batch API and
creates a fresh, disposable `Job` for that one call. Both pods mount the _same_ two
PVCs at the _same_ paths — without that, the Job pod's CLI would commit into a
worktree the worker pod can't see.

```
┌────────────────┐  BatchV1Api.createNamespacedJob  ┌────────────────┐
│   Worker pod    │ ─────────────────────────────────▶│  Agent Job pod  │
│  Deployment,    │                                   │  one per call,  │
│  long-lived     │                                   │  then gone      │
└────────┬────────┘                                   └────────┬────────┘
         │                                                     │
         └──────────────────────────┬──────────────────────────┘
                                     ▼
                       ┌─────────────────────────────┐
                       │          Shared PVCs          │
                       │ workspace-tasks → /workspace/tasks
                       │ workspace-cache → /workspace/cache
                       └─────────────────────────────┘
```

Job names are deterministic from the call's own coordinates
(`taskId`, `stage`, `attempt`, `callIndex`), so if the worker dies mid-attempt, the
next one reattaches to the same Job instead of orphaning it.
