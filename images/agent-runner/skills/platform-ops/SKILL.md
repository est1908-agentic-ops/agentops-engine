---
name: platform-ops
description: Use when running as the platform agent (workflow type "platform") to investigate Temporal workflow failures, cluster/log state, or to reflect on a recent run — pulls workflow history via Temporal's REST API, logs via Grafana's Loki proxy, resource/cluster metrics via Grafana's Prometheus proxy, and live cluster objects via read-only kubectl. Ends with the PLATFORM_RESULT: sentinel described in this task's prompt.
---

# Platform agent operations

No cluster shell access beyond what this role's Job already grants is assumed. Investigation
goes through three channels: two HTTP APIs (Temporal REST, Grafana's datasource proxy in front
of Loki and Prometheus) and read-only `kubectl` (this role's ServiceAccount only — get/list/
watch, no exec/delete/patch/create).

## Temporal — workflow status and history

Same technique as `debug-devcycle-issue`:

```
curl -s "https://<temporal-host>/api/v1/namespaces/<namespace>/workflows/<workflowId>"
curl -s "https://<temporal-host>/api/v1/namespaces/<namespace>/workflows/<workflowId>/history?historyEventFilterType=HISTORY_EVENT_FILTER_TYPE_ALL_EVENT"
```

## Finding recent failures

Before triaging, enumerate what actually failed. Query the Temporal **visibility** API for recently-closed workflows with a failed or terminated status, over a recent time window, using the same Temporal REST base URL and auth this skill already uses for history:

```
# List workflows that Failed or were Terminated recently (adjust the window).
curl -s "https://<temporal-host>/api/v1/namespaces/<namespace>/workflows" \
  --data-urlencode 'query=ExecutionStatus="Failed" OR ExecutionStatus="Terminated"' \
  -G | jq '.executions[] | {workflowId: .execution.workflowId, type: .type.name, status: .status, closeTime: .closeTime}'
```

Filter the results to the window you care about (e.g. the last 30 minutes by `closeTime`). Note that a `devCycle` that ended **blocked** *completes* at the Temporal level rather than failing — those will not appear under `ExecutionStatus="Failed"`; a self-heal sweep focuses on Failed/Terminated first. For each failure worth acting on, then use the per-workflow history + Loki technique below to diagnose it.

**Safe actions you may take directly** (see this task's prompt for the exact allow-list):
terminate a workflow via `POST .../workflows/<workflowId>/terminate`, or send an existing
signal (`clarify`/`resume`) via `POST .../workflows/<workflowId>/signal`. Always record what you
did and why in the `actionsTaken` field of your final `PLATFORM_RESULT:` line.

## Grafana → Loki (logs)

Identical to `debug-devcycle-issue`: find the Loki datasource UID via
`/api/datasources`, then GET (never POST) `/api/datasources/proxy/uid/<uid>/loki/api/v1/query_range`
with `-G --data-urlencode`, `start`/`end` in nanoseconds since epoch.

## Grafana → Prometheus (cluster/resource state)

Same proxy pattern, different datasource UID (look for `"type": "prometheus"` in
`/api/datasources`):

```
curl -s -u '<user>:<pass>' -G "https://<grafana-host>/api/datasources/proxy/uid/<uid>/api/v1/query" \
  --data-urlencode 'query=container_memory_usage_bytes{namespace="dev-agents"}'
```

Useful queries: `container_memory_usage_bytes`, `container_cpu_usage_seconds_total`,
`kube_pod_container_status_restarts_total`, `kube_pod_status_phase`.

## kubectl (read-only)

This role's ServiceAccount token is auto-mounted the normal Kubernetes way — no separate
kubeconfig needed, `kubectl` picks it up automatically inside the pod:

```
kubectl get pods -n dev-agents
kubectl describe pod <pod> -n dev-agents
kubectl get events -n dev-agents --sort-by=.lastTimestamp
```

`get`/`describe`/`events` work; `exec`/`delete`/`patch`/`create`/`apply` do not — this
ServiceAccount's ClusterRole grants `get`/`list`/`watch` only. A permission error here is
expected for anything beyond reading; it is not a bug to work around.

## Reading repos

You have read-only clones available for any registered repo (engine, platform, or product) —
use them to trace a stack trace from Temporal/Loki output back to a source file/line, the same
way `debug-devcycle-issue`'s worked example does. You do not have push access to any repo; if
a fix is warranted, describe it in `proposedFixes` instead of committing anything.

## Checklist

- [ ] For "investigate failures": list recent failed/canceled workflows, describe + pull
      history for each, fall back to Loki logs (windowed around start/close time) per the
      history limitation `debug-devcycle-issue` documents (a still-retrying activity's
      failures never land in history).
- [ ] For "check cluster state": kubectl get pods/events in the relevant namespace, cross-check
      restart counts and resource usage against Prometheus if anything looks off.
- [ ] For "reflect on a run": pull the full trace (Temporal history + Loki), read the relevant
      source, and summarize concretely — vague "consider improving X" findings are less useful
      than "stage Y retried N times because Z, bounded by policy W".
- [ ] Always end with exactly one `PLATFORM_RESULT:` line, even when the answer is "nothing
      wrong found" — an empty `actionsTaken`/`proposedFixes` is a valid, complete answer.
