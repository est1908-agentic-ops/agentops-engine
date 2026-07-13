# Runbook: engine-worker graceful shutdown (SIGTERM handling)

Why `engine-worker` rollouts stopped causing spurious `runAgent` retries, how the fix works,
and how to diagnose it if the failure mode ever comes back.

Incident: devCycle workflow `devcycle:Agentic Ops engine:12` (run
`019f5ce3-ac98-7781-8078-fb60928d4e0d`), 2026-07-13. Fixed in `images/engine/Dockerfile` +
`charts/engine/{templates/deployment.yaml,values.yaml}`.

## The bug (pre-fix)

Every `engine-worker` rollout SIGKILLed the outgoing pod mid-activity instead of letting it
drain, so any `runAgent` call in flight during a deploy failed with a Temporal
`TIMEOUT_TYPE_HEARTBEAT` and had to be retried — burning one of only 5 retry attempts and
stalling that stage for minutes while nothing polled the underlying agent Job.

Root cause, confirmed end to end:

1. `images/engine/Dockerfile` ran the container as `CMD ["pnpm", "--filter", "@agentops/worker",
   "run", "start"]`. `pnpm run <script>` does **not** forward SIGTERM to the `tsx`/`node`
   process it spawns — pnpm swallows the signal and reports its own lifecycle failure instead.
   Confirmed live: a minimal repro with a `process.on('SIGTERM', ...)` handler never saw the
   signal under `pnpm run start`, but did under `pnpm exec <bin>` (which execs the target
   directly, no wrapper).
2. `@temporalio/worker`'s `Worker.run()` *does* install a SIGTERM handler by default and would
   gracefully stop polling + let in-flight activities finish — but it never got the chance,
   because of (1).
3. Even with the signal delivered, `charts/engine/templates/deployment.yaml` had no
   `terminationGracePeriodSeconds` override, so k8s's default 30s grace period would SIGKILL
   the pod long before a `runAgent` activity (up to 45 minutes, `whitebox-bughunt.ts`) finished.

Loki fingerprint for the pre-fix failure (worker pod logs, `{pod="engine-worker-...",
namespace="dev-agents"}`):

```
/app/packages/worker:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @agentops/worker@0.0.0 start: `tsx src/main.ts`
Command failed with signal "SIGTERM"
```

Not catastrophic — no actual CLI work was lost. `K8sJobRunner`'s Job name is deterministic per
`(taskId, stage, req.attempt, callIndex)` (a workflow-level counter, not Temporal's own retry
attempt), so the retry's job-create hit a 409 and reattached to the still-running agent Job
(`packages/backends/src/k8s/k8s-job-runner.ts`, `cleanupFailedAttempt`/409-reattach comments).
The cost was wasted wall-clock and a burned retry attempt, not lost progress.

## The fix

- **`images/engine/Dockerfile`**: `CMD` for `worker`/`gateway`/`control` changed from
  `pnpm --filter <pkg> run start` to `pnpm --filter <pkg> exec tsx src/main.ts`. Same effective
  command, but `exec` doesn't swallow SIGTERM.
- **`charts/engine/values.yaml` / `templates/deployment.yaml`**: added
  `terminationGracePeriodSeconds: 2700` (45 min) to the worker Deployment, matching the longest
  `runAgent` `startToCloseTimeout` any workflow proxies (`whitebox-bughunt.ts`). `gateway`/
  `control` are stateless HTTP services with no long-running activities, so they keep k8s's
  default 30s — only the worker needed the bump.

Both changes are required together: signal delivery without the longer grace period still gets
SIGKILLed before a long activity finishes; the longer grace period without signal delivery just
makes k8s wait pointlessly before SIGKILLing anyway.

No changes were needed in `packages/backends/src/k8s/k8s-job-runner.ts` — the 409-reattach retry
path was already correct and remains the fallback for the rare case where a pod is forced out
even after the full grace period.

## How to verify after deploy

- `kubectl -n dev-agents get deploy engine-worker -o jsonpath='{.spec.template.spec.terminationGracePeriodSeconds}{"\n"}'`
  → `2700`.
- Trigger a rollout (`kubectl -n dev-agents rollout restart deploy/engine-worker`) while a
  `runAgent` activity is in flight (check `describe` on an active `devCycle` workflow for a
  `pendingActivities` entry with `activityType.name: "runAgent"`). Watch the outgoing pod's logs
  — it should keep running/heartbeating until its activity finishes, not die with the
  `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` fingerprint above.
- Confirm via Temporal history (`debug-devcycle-issue` skill) that the workflow's `runAgent`
  activity completes on `attempt: 1`, with no `lastFailure.timeoutFailureInfo.timeoutType:
  TIMEOUT_TYPE_HEARTBEAT` on the next attempt.

## How to diagnose a recurrence

Use the `debug-devcycle-issue` skill: Temporal REST `describe`/`history` for the workflow, then
Loki via Grafana's datasource proxy for the worker pod identities involved.

1. In history, find the `ACTIVITY_TASK_STARTED` event whose `lastFailure` has
   `timeoutFailureInfo.timeoutType: TIMEOUT_TYPE_HEARTBEAT` — its `identity` field on the
   *previous* activity/workflow-task events names the pod that died.
2. Query Loki for that pod (`{pod="<name>", namespace="dev-agents"}`) windowed around the gap.
   If the `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL ... Command failed with signal "SIGTERM"`
   fingerprint reappears, this fix has regressed — check that `images/engine/Dockerfile`'s CMD
   lines still use `pnpm exec` (not `pnpm run start`) and that
   `terminationGracePeriodSeconds: 2700` is still set in `charts/engine/values.yaml` (and not
   overridden lower by an `agentops-platform` values file).
3. If the pod log instead shows normal activity but *still* dies right at the 15s heartbeat
   mark with no rollout in progress, that's a different bug (e.g. the K8s API server itself is
   slow) — see `K8sJobRunner`'s `statusPollTimeoutMs`/`pollIntervalMs` and the
   `withTimeout`/`StatusPollTimeoutError` comment in `k8s-job-runner.ts` for that failure class.
