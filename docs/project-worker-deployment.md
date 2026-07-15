# Deploying a Tier-2 project worker

A Tier-2 project (a custom Temporal workflow shape, e.g. a Rollbar monitor) runs
in its **own worker** that polls its own task queue and delegates privileged work
back to the engine (see [Authoring project workflows](authoring-project-workflows.md)).
This doc covers **deploying** that worker.

## Model (why there's no per-project ArgoCD Application to hand-write)

- The worker is deployed by the generic `project-worker` Helm chart
  (`oci://gitactions.est1908.top/agentic-ops/project-worker`), rendered per project
  by one ArgoCD `ApplicationSet` in `agentops-platform`
  (`clusters/ops/project-workers/`).
- Temporal is a single shared namespace; the worker "registers" simply by polling
  its task queue `proj-<project>`. The engine reconciler starts the project's
  workflow **by name on that queue**; the worker (the only process polling it) runs it.

## Onboarding (repo-sourced — the end state)

Everything about your worker lives in **your repo's `agents.json`** — no platform PR:

1. Author the worker (`worker.ts` using `@agentic-ops/engine-sdk/worker`; see
   [docs/project-worker/](project-worker/)) and add a `worker` block to `agents.json`:
   ```jsonc
   {
     "agents": [
       { "name": "rollbar", "workflow": "rollbarMonitor", "schedule": "continuous" }
       // taskQueue omitted -> defaults to proj-<project> (the queue your worker polls)
     ],
     "worker": {
       "image": "<registry>/<repo>/agentops-worker:<tag>",  // written by your CI on release
       "externalSecrets": ["rollbar-token"]                  // K8s Secret names (your own externals)
       // replicas defaults to 1; taskQueue defaults to proj-<project>
     }
   }
   ```
2. Your CI builds the image and writes its tag into `agents.json`'s `worker.image`
   (git-write-back — the deployed image is auditable in your repo history). Avoid a
   mutable `:latest`; use the immutable per-build tag/digest so ArgoCD detects changes.
3. The engine's `control`/gateway surfaces your `worker` block to the ArgoCD
   ApplicationSet plugin generator, which deploys the `project-worker` chart on the
   next reconcile. ConfigSync schedules your agents on `proj-<project>`.

The `worker` block's **presence is what marks your project Tier-2**. A config-only
(Tier-1) project omits it, and its agents run on the shared engine fleet.

### How the worker spec reaches ArgoCD (and why it isn't on `control`)

The ArgoCD plugin generator calls the **gateway** endpoint
`POST /api/v1/getparams.execute`, which reads each managed project's `agents.json`
`worker` block using the per-project token the registry already holds. It is hosted
on the gateway — not the browser-facing `control` — because `control` is deliberately
**encrypt-only** (it holds only the public key and cannot decrypt project tokens);
moving the repo read there would reopen that attack surface. The endpoint serves a
**last-good cache**, so a transient GitHub/registry read failure never prunes a live
worker.

## What the worker pod gets — and does NOT get

- **Gets:** Temporal connection (the shared namespace), `PROJECT_TASK_QUEUE`, the
  OTLP endpoint, and any `externalSecrets` you declare (your own externals,
  provisioned as SOPS secrets in `agentops-platform`).
- **Does NOT get:** any engine credential (agent OAuth, per-project SCM tokens).
  Privileged work is delegated to the engine via `engineActivities()` /
  `childDevCycle()` — that omission is the security boundary.
