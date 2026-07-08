---
name: debug-devcycle-issue
description: Use when investigating a stuck, failed, blocked, or canceled devCycle (or any Temporal) workflow in this project's clusters — pulls workflow history via Temporal's REST API and worker/agent pod logs via Grafana's Loki datasource proxy, without needing kubectl or cluster shell access. Triggers on a Temporal Web UI link, "why did this task/issue fail", "debug this workflow", or "check the logs for <taskId>".
---

# Debugging a devCycle issue

No cluster shell access is assumed or needed. Everything here goes through two HTTP APIs: Temporal's own REST (gRPC-gateway) API, and Grafana's datasource proxy in front of Loki.

## What you need

- Namespace + workflowId + runId. A Temporal Web UI link has the shape `https://<temporal-host>/namespaces/<namespace>/workflows/<workflowId>/<runId>/<tab>` — pull all three straight out of the URL.
- The same `<temporal-host>` for the REST API (it's served off the Web UI's own host).
- A Grafana host + login for the same cluster (conventionally `grafana.<same base domain>`). Grafana requires auth here. Credentials are SOPS-encrypted in the `agentops-platform` repo at `secrets/grafana/grafana-credentials.enc.yaml` (age recipient in that repo's `.sops.yaml`) — if you have the age private key locally (check `~/.agentops/age.key`; its public key must match the recipient), decrypt directly: `SOPS_AGE_KEY_FILE=~/.agentops/age.key sops --decrypt secrets/grafana/grafana-credentials.enc.yaml`. Otherwise ask for credentials. Either way, never write the real values into this skill, code, commits, or memory — hold them in a shell variable for the session and let them go.

## Step 1 — Temporal's REST API (workflow status + history)

**Describe** (status, close time, task queue, search attributes):

```
curl -s "https://<temporal-host>/api/v1/namespaces/<namespace>/workflows/<workflowId>"
```

Gotcha: there is no `/runs/<runId>` segment in this API — this path alone returns the *current* run for that workflow ID, which is what you want in the common case (you're looking at the most recent attempt anyway).

**Full event history**:

```
curl -s "https://<temporal-host>/api/v1/namespaces/<namespace>/workflows/<workflowId>/history?historyEventFilterType=HISTORY_EVENT_FILTER_TYPE_ALL_EVENT"
```

Read the events top to bottom and watch for:

- An `EVENT_TYPE_ACTIVITY_TASK_SCHEDULED` with no matching `..._COMPLETED` / `..._FAILED` / `..._TIMED_OUT` before the workflow closes — that activity was still mid-retry when the workflow ended. Its actual failure reason is **not** in history (see the limitation below); go to Step 2.
- `EVENT_TYPE_WORKFLOW_EXECUTION_CANCEL_REQUESTED` with `identity: "webui"` — a human clicked Cancel in the Temporal UI, usually because something looked stuck.
- A `WORKFLOW_TASK_SCHEDULED` on a `TASK_QUEUE_KIND_STICKY` queue followed by `WORKFLOW_TASK_TIMED_OUT` (`TIMEOUT_TYPE_SCHEDULE_TO_START`) — the worker pod that had this workflow cached went away. It falls back to the normal queue, often picked up by a *different* pod. Compare the `identity` field's pod suffix on the events before and after: a different ReplicaSet hash means the `engine-worker` Deployment rolled (a deploy, an OOM-kill, a node drain) mid-run.
- The `identity` field on `WORKFLOW_TASK_STARTED` and activity events is `<pid>@<pod-name>` — that pod name is what you'll query logs for in Step 2.

**Limitation to know going in**: history only records an activity's *terminal* outcome (completed/failed/timed out/canceled). An activity that's retrying — failing, backing off, trying again — has its attempt count and last-failure message tracked as ephemeral "pending activity" state, visible live in the Temporal Web UI only while the workflow is **open**. Once the workflow closes (including via cancel), that state is gone and will not appear in any API response. If the thing you need to explain is "why did this keep failing on every retry," history alone won't answer it — you need the worker's own logs.

## Step 2 — Grafana → Loki (worker/agent pod logs)

Grafana's HTTP API works fine with basic auth once you have credentials; the trick is Loki sits behind Grafana's *datasource proxy*, which has its own quirks.

**Find Loki's datasource UID:**

```
curl -s -u '<user>:<pass>' "https://<grafana-host>/api/datasources"
```

Look for `"type": "loki"`, take its `"uid"`.

**Discover the label schema** (varies by chart/version — don't assume):

```
curl -s -u '<user>:<pass>' "https://<grafana-host>/api/datasources/proxy/uid/<uid>/loki/api/v1/labels"
curl -s -u '<user>:<pass>' "https://<grafana-host>/api/datasources/proxy/uid/<uid>/loki/api/v1/label/pod/values"
```

In this deployment the labels are `container`, `instance`, `job`, `namespace`, `pod`, `service_name` — there is no `app` label. The `label/pod/values` call is also the fastest way to confirm you have the exact pod name spelled right.

**Query logs — GET only.** Grafana's datasource proxy rejects POST to Loki's query endpoints (`{"message": "non allow-listed POSTs not allowed on proxied loki datasource"}`). Use `-G --data-urlencode` so curl sends a GET with a query string, not a POST body:

```
curl -s -u '<user>:<pass>' -G "https://<grafana-host>/api/datasources/proxy/uid/<uid>/loki/api/v1/query_range" \
  --data-urlencode 'query={pod="<pod-name>", namespace="<namespace>"}' \
  --data-urlencode "start=<unix-nanoseconds>" \
  --data-urlencode "end=<unix-nanoseconds>" \
  --data-urlencode "limit=200" \
  --data-urlencode "direction=forward"
```

Loki wants **nanoseconds since the epoch** for `start`/`end`, not seconds and not ISO-8601. Convert with e.g. `python3 -c "print(int(__import__('datetime').datetime(2026,7,7,6,41,0,tzinfo=__import__('datetime').timezone.utc).timestamp()*1e9))"`. Window generously — a few minutes on either side of the timestamps from Step 1 — since you don't yet know exactly when the relevant lines landed.

**Reading the result**: `.data.result[]` is one entry per matching label set (stream); each has `.values`, a list of `[nanosecond-timestamp, line]` pairs. Worker JSON logs are pretty-printed, so one log statement spans many lines/array entries (one per brace/field) — read a timestamp cluster as one contiguous block, not line-by-line. Stack traces in these logs point at real repo paths (`/app/packages/...`), so you can trace an error straight back to source.

**Gotcha — Alloy can starve itself and silently produce zero real log lines.** If a queried pod's *entire* log is just one line repeated verbatim (seen: `failed to create fsnotify watcher: too many open files`, every few seconds for the pod's whole lifetime), that is not the target container's output — it is Grafana Alloy's own `loki.source.kubernetes.pods` component failing to open a file-watch on that pod's log file (an inotify/fd exhaustion on Alloy's side, likely from high Job churn — one new pod per `runAgent` call), tagged with the target pod's labels. Confirm by querying `{container="alloy"} |= "fsnotify"` directly, or by checking whether an unrelated long-lived pod (e.g. `engine-worker-*`) shows the exact same line in the same window — if so, Loki captured *nothing real* cluster-wide for that window, not just for the pod you're investigating. There is no log-based fallback for that window; the real output for `runAgent` calls lives only in the task workspace PVC (`.agentops/output-<stage>-<attempt>-<callIndex>.json`, per `packages/backends/src/k8s/k8s-job-runner.ts`'s `agentOpsArtifactPaths`), which this skill's toolbelt (Temporal REST + Grafana proxy, no cluster shell) cannot read. Flag this as its own incident if seen — it blocks debugging, it doesn't just complicate it.

## Worked example: `issue-broccoli-94`

This is the incident that motivated writing this skill down.

1. **Describe** showed `WORKFLOW_EXECUTION_STATUS_CANCELED`, `historyLength: 13` — a short history for a `devCycle`, meaning it died early.
2. **History** showed: started → scheduled `prepareWorkspace` → nothing for ~2m47s → `EVENT_TYPE_WORKFLOW_EXECUTION_CANCEL_REQUESTED` (`identity: "webui"`) → a sticky workflow task timeout → the cancel actually got processed by a *different* `engine-worker` pod (different ReplicaSet hash) → `WORKFLOW_EXECUTION_CANCELED`. No `ACTIVITY_TASK_COMPLETED`/`FAILED` ever appeared for `prepareWorkspace`.
3. That absence was the tell: per the Step 1 limitation, a still-retrying activity's failures aren't in history. Queried Loki for both `engine-worker-*` pod identities seen in the history, windowed around the workflow's start/close times.
4. The logs showed `prepareWorkspace` retrying every ~10-30s, each attempt logging a full `WorkspaceError` with stack trace: attempt 1 failed because the workspace directory already existed (leftover from an earlier, uncleaned-up run of the same taskId); every attempt from 2 onward failed with a *different* fatal error — a dangling branch that `git worktree add -b` had created on attempt 1 before its own path check failed.
5. Traced the stack trace straight to `packages/activities/src/workspace/workspace-manager.ts:71` — confirmed by reading the source.

Root cause and fix: `WorkspaceManager.prepare` wasn't idempotent against leftover state from an incomplete previous run, and nothing bounded how many times an activity could retry an unrecoverable, identically-failing error — so a deterministic failure looked like a hang until a human noticed and canceled it by hand.

## General checklist

- [ ] Get workflowId/runId/namespace from the Temporal UI URL.
- [ ] `describe` — status, close time, `historyLength` (a suspiciously small number for how far the task should have gotten is itself a signal).
- [ ] Full history — look for scheduled-but-unresolved activities, cancel requests, sticky-queue timeouts and pod handoffs.
- [ ] If the failure reason isn't in history, pull the named worker pods' logs from Loki via Grafana, windowed around the workflow's start/close time.
- [ ] Trace the error's stack trace back to the source file/line.
- [ ] Every activity in `packages/workflows/src/dev-cycle.ts` is capped at `maximumAttempts: 5` — a workflow that looks like it hung forever waiting on one activity is a regression, not expected behavior; check whether this cap regressed or was bypassed before assuming it's a new class of bug.
