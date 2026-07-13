# Runbook: repo-sourced project-worker pipeline (dev-agents)

How to monitor, test, and debug the pipeline that deploys **Tier-2 project workers**
from a `worker` block in each project's `agents.json` — no per-project platform YAML.

Design: [`docs/superpowers/specs/2026-07-12-project-worker-onboarding-design.md`](../superpowers/specs/2026-07-12-project-worker-onboarding-design.md).
First proven end-to-end on dev-agents 2026-07-13 (a `broccoliSmoke` run completing on `proj-broccoli`).

## The chain (what to picture)

```
project repo agents.json  ──(worker block)──▶  gateway  POST /api/v1/getparams.execute
        │                                        (reads the block via the per-project
        │                                         SCM token; bearer ARGOCD_PLUGIN_TOKEN)
        │                                               │
        │                                               ▼
        │                                   ArgoCD ApplicationSet "project-workers"
        │                                   (plugin generator) ─▶ project-worker Helm chart
        │                                               │
        │                                               ▼
        │                                   <project>-worker Deployment (ns dev-agents)
        │                                   polling Temporal task queue proj-<project>
        └──(agents array)──▶ ConfigSync ─▶ Temporal Schedules
                             (reconcile:all every 15 min → configSync per project →
                              agent:<project>:<name> schedules → dispatched onto proj-<project>)
```

One shared Temporal namespace (`dev-agents`); everything runs in the `dev-agents` k8s namespace.
The generator endpoint is on the **gateway** (which holds the private key + reads repos), NOT
the encrypt-only `control` — see the spec's Option A / §6.2.

## Access (this cluster)

- **kubectl** if the session has it (most reliable). Otherwise pod logs via Grafana/Loki through
  the `debug-devcycle-issue` skill (Loki datasource proxy).
- **temporal CLI** / Temporal REST for schedules + workflow runs (namespace `dev-agents`).
- **gh**: `est1908` account for `est1908-agentic-ops/agentops-{engine,platform}`; `artem-broccoli`
  for `broccoli-hr/broccoli`. The active gh account flips mid-session — re-assert with
  `gh auth switch --user <acct>` right before each gh call (a flip shows up as spurious 404s).

## Health checks

| # | Component | How | Healthy |
|---|---|---|---|
| 1 | Gateway generator endpoint | `kubectl -n dev-agents logs deploy/engine-gateway` | startup line `ArgoCD project-workers generator ENABLED`; no sustained `failed to read worker block … serving last-good` |
| 2 | ApplicationSet | `kubectl get applicationset project-workers -n argocd -o yaml` | `status`: `ErrorOccurred=False`, `ParametersGenerated=True`; each `project-worker-<proj>` Application `Synced`+`Healthy` |
| 3 | Worker Deployment | `kubectl -n dev-agents get deploy <proj>-worker -o wide` + logs | `Running`, 0 crashloops, expected image, logs show connected + polling `proj-<proj>` |
| 4 | Reconcile / ConfigSync | `temporal schedule describe --schedule-id reconcile:all --namespace dev-agents` | has **next-action times** + recent LastRun (fires every 15 min) |
| 4b | Agent schedules | `temporal schedule list --namespace dev-agents \| grep 'agent:<proj>:'` | one per scheduled agent, unpaused, with next-run times |
| 5 | Plugin token secret | `kubectl get secret argocd-plugin-token -n argocd` | present; value matches the gateway's `ARGOCD_PLUGIN_TOKEN` (dev-agents/argocd-plugin-token) |

## End-to-end test (does the worker actually serve its queue?)

Trigger a project's smoke agent instead of waiting for its schedule:

```sh
export TEMPORAL_ADDRESS="${TEMPORAL_ADDRESS:-localhost:7233}"; NS=dev-agents
SID=agent:broccoli:smoke-test

temporal schedule describe --schedule-id "$SID" --namespace "$NS"   # unpaused, broccoliSmoke, proj-broccoli
temporal schedule trigger  --schedule-id "$SID" --namespace "$NS"   # fire now (ad-hoc action)
temporal workflow list --namespace "$NS" --query 'WorkflowType="broccoliSmoke"' --order-by-start-time desc | head
temporal workflow result --workflow-id <id-from-list> --namespace "$NS"
```

**Pass:** status `COMPLETED`, result `{ "ok": true, "message": "…" }` — proves reconcile → schedule →
the project's own worker (polling `proj-<project>`) ran its bundled workflow code and returned.

Bypass the schedule (test the worker in isolation):

```sh
temporal workflow start --type broccoliSmoke --task-queue proj-broccoli \
  --workflow-id smoke-manual-1 --namespace "$NS" \
  --input '{"repo":"broccoli-hr/broccoli","project":"broccoli","message":"manual test"}'
temporal workflow result --workflow-id smoke-manual-1 --namespace "$NS"
```

> Scope note: `broccoliSmoke` returns `{ok:true}` — it proves the **worker-serves-its-queue** half of
> Tier-2, not the **delegate-back-to-engine** path (`engineActivities()`/`childDevCycle()` + the
> project-identity authz). Exercise that with a workflow that makes an `engineActivities()` call.

## Known failure modes → fix (from the 2026-07-13 bring-up)

- **Schedules exist but never fire** (no next-action times, 0 actions). The ScheduleSpec must use
  `cronExpressions: string[]` + top-level `timezone` — a `{ cron: { cronString } }` shape is silently
  ignored by the Temporal client (fixed in engine #52; centralized in `cronScheduleSpec()`).
  `ensureReconcileSchedule` is **create-or-ignore**, so an already-existing broken `reconcile:all`
  does NOT self-repair: `temporal schedule delete --schedule-id reconcile:all` then restart
  `engine-worker` so it recreates it correctly.
- **ApplicationSet generator 401 / `Secret "argocd-plugin-token" not found`.** The argocd-namespace
  token Secret is GitOps-managed by the `project-workers-secret` ArgoCD app (selfHeal). If the gateway
  returns 401, it's holding a stale token env — `kubectl rollout restart deploy/engine-gateway -n dev-agents`
  so it re-reads the Secret. The token must match on both sides (argocd/argocd-plugin-token[`token`] ==
  dev-agents/argocd-plugin-token[`ARGOCD_PLUGIN_TOKEN`]).
- **A new project's worker never appears.** Its `agents.json` has no `worker` block, or the gateway
  can't read the repo (SCM token) — the generator omits it. Check gateway logs + the block is committed.
- **A worker got pruned.** The generator returned `[]` for it (worker block missing at generation
  time). Ensure the project's `worker` block lands before the generator runs.
