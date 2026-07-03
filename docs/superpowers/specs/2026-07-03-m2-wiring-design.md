# M2 Wiring — Design

Status: draft · 2026-07-03 · Owner: Artem
Milestone: M2, integration step (ties together [platform bootstrap](../../../../agentops-platform/docs/superpowers/specs/2026-07-03-platform-bootstrap-design.md), [platform components](../../../../agentops-platform/docs/superpowers/specs/2026-07-03-platform-components-design.md), [engine image & chart](2026-07-03-engine-image-and-chart-design.md), [K8s Job runner](2026-07-03-k8s-job-runner-design.md))

## Context

Each of M2's other four sub-projects lands independently: a bootstrap script, a set of ArgoCD-managed platform components, a Helm chart, and a new `AgentBackend` implementation. None of them, on their own, make `engine start --issue N` actually run in-cluster — that requires the worker's composition root to pick `K8sJobRunner` over `ProcessCliRunner` when it's actually running in a pod, and `TEMPORAL_ADDRESS` to point at the in-cluster Temporal instead of `localhost:7233`. This mirrors M1 wiring's shape exactly: every sub-project deferred "which implementation gets constructed where" to this step.

## Goal

`engine start --issue N`, run against the same disposable test repo M1 used, produces a real merge-ready PR where every agent CLI invocation ran as a K8s Job — on a cluster built from nothing but `docs/BOOTSTRAP.md` followed once.

## Non-goals

- Gateway/webhooks (M3) — the CLI stays the trigger.
- Exposing Temporal's gRPC frontend outside the cluster — `kubectl port-forward` is the answer for M2 (see below).
- `agent-pi` in-cluster, LiteLLM, LGTM/Alloy, MailPit, GlitchTip — all out of scope per the decomposition doc.

## Mode-selection approach

**`KUBERNETES_SERVICE_HOST` presence is the signal** — Kubernetes injects this into every pod automatically; nothing to configure, nothing to remember to set. Present → construct `K8sJobRunner` instances for `claude`/`pi`, targeting the namespace/PVC/image values read from env (populated by the Helm chart). Absent → today's `ProcessCliRunner` path, completely unchanged. Same reasoning as M1 wiring's `GITHUB_TOKEN` switch: the environment already carries the truth; a separate `--in-cluster` flag would be one more thing to keep in sync with reality for no benefit. A startup log line states which mode is active, same convention as M1.

## Components

### `packages/worker/src/main.ts` (changed)

```ts
const inCluster = Boolean(process.env.KUBERNETES_SERVICE_HOST);

const claudeSpec = ClaudeCliSpec; // from @agentops/backends, post-refactor
const piSpec = PiCliSpec;

const backends: Record<string, AgentBackend> = inCluster
  ? {
      stub: new StubBackend(),
      claude: new K8sJobRunner(claudeSpec, {
        namespace: process.env.AGENT_NAMESPACE ?? 'dev-agents',
        workspacePvcName: process.env.WORKSPACE_PVC_NAME ?? 'workspace-tasks',
        workspaceMountPath: process.env.WORKSPACE_MOUNT_PATH ?? '/workspace/tasks',
        batchApi: kc.makeApiClient(BatchV1Api),
        coreApi: kc.makeApiClient(CoreV1Api),
      }),
      pi: new ProcessCliRunner(piSpec), // no in-cluster image yet — kept local-only, unreachable via routing until M5
    }
  : { stub: new StubBackend(), claude: new ProcessCliRunner(claudeSpec), pi: new ProcessCliRunner(piSpec) };

console.log(
  inCluster
    ? 'agentops worker: IN-CLUSTER mode (KUBERNETES_SERVICE_HOST set) — claude runs as K8s Jobs'
    : 'agentops worker: LOCAL mode — claude/pi spawn as local processes',
);
```

`kc` is a `KubeConfig` loaded via `kc.loadFromCluster()` when `inCluster`, using the ServiceAccount token/CA the Helm chart's RBAC already provisions — no manual kubeconfig file, no extra secret. This composes with, not replaces, M1 wiring's existing `GITHUB_TOKEN` branch in the same file — the two switches are independent axes (where agents run vs. which GitHub credentials are used) and both can be true at once in the real in-cluster run.

### `packages/workflows/src/activities-api.ts` (changed)

`runAgent`'s `proxyActivities` call gains `heartbeatTimeout: '15s'` (five times the K8s Job runner's default 3s poll interval — generous enough to absorb one missed poll without false-triggering cancellation, tight enough that a genuinely stuck worker is detected well within any stage's `timeoutMs`). This has no effect on the local `ProcessCliRunner` path (it never calls `heartbeat()`), so it's safe to set unconditionally rather than branching on `inCluster`.

### `charts/engine`'s `values.yaml` override (in `agentops-platform`, `clusters/ops/engine/values.yaml`)

```yaml
temporalAddress: "temporal-frontend.temporal.svc.cluster.local:7233"
image:
  workerTag: "<git-sha, bumped manually per the decomposition doc's cross-cutting decision>"
  agentClaudeTag: "<git-sha>"
namespace: dev-agents
```

### CLI access to in-cluster Temporal

Temporal's gRPC frontend (port 7233) is not exposed outside the cluster for M2 — no ingress, no `temporal.lab` DNS entry for the gRPC port (Technitium/step-ca cover the *Web UI*'s HTTP port cleanly via ordinary ingress, but a raw gRPC TCP passthrough is more ingress machinery than M2's gate requires). The `engine` CLI runs from an operator machine via:

```bash
kubectl port-forward svc/temporal-frontend 7233:7233 -n temporal &
TEMPORAL_ADDRESS=localhost:7233 pnpm --filter cli engine start --issue owner/repo#42 --repo owner/repo --product my-product --goal "..."
```

Documented in the README as the M2 in-cluster runbook, with an explicit note that real external access (for the eventual Gateway) is M3's concern, not deferred by accident.

## Data flow (in-cluster, happy path)

1. Operator port-forwards Temporal, runs `engine start` from a laptop exactly as in M1, except `TEMPORAL_ADDRESS` now points at the forwarded port.
2. Worker (running as a pod, `KUBERNETES_SERVICE_HOST` set) picked `K8sJobRunner` for `claude` at startup.
3. `prepareWorkspace` runs inside the worker pod exactly as M1 built it — writes into the `workspace-tasks` PVC, now mounted in the pod instead of local disk.
4. Each `implement`/`review`/etc. stage's `runAgent` call: `K8sJobRunner` writes the prompt file to the same PVC, submits a `Job`, heartbeats while polling, reads the result file off the PVC on completion.
5. `pushBranch`/`openPr`/`getPrFeedback` — unchanged from M1, still executed by activity code running in the worker pod (only agent CLI execution moved to Jobs, not git/GitHub operations).
6. PR reaches merge-ready exactly as in M1's manual runbook, verified this time by also watching `kubectl get jobs -n dev-agents -w` during the run to confirm CLI calls are actually happening as Jobs, not silently falling back to local spawn.

## Testing strategy

- No new unit tests here — this doc's changes are composition-root wiring and one config line (`heartbeatTimeout`), matching M1 wiring's posture that `main.ts` itself isn't unit-tested, only what's beneath it.
- **The M2 gate itself is the verification**, run manually and documented as a runbook (README addition):
  1. Fresh host (a disposable VM, not the eventual shared host) — follow `docs/BOOTSTRAP.md` once, no improvisation, no manual `kubectl apply` outside what the doc says.
  2. Confirm every ArgoCD Application is `Healthy`/`Synced`.
  3. Port-forward Temporal, run `engine start --issue N` against the M1 test repo; confirm the PR lands with green CI.
  4. Re-run M1's brake/escalation manual test (deliberately low `maxTokens`) against the live in-cluster backend, confirm it still trips and escalates correctly.
  5. `kubectl delete` the whole cluster's data (or just re-provision the disposable VM) and repeat step 1 once more, timing it — this is the literal "wiped host rebuilds to working state" gate text.
- The existing e2e suite (memory-mode, `TestWorkflowEnvironment`) must stay green, unchanged — proof the local/demo path isn't disturbed.

## Named risks

- **First real infra milestone — a lot can go wrong on a fresh host that unit tests can't catch.** Mitigated by testing on a disposable cloud VM before ever touching a persistent shared host, and by `bootstrap.sh`'s already-decided idempotent/re-runnable property (agentops-platform's `docs/BOOTSTRAP.md`) being the actual safety net, not this doc.
- **`kubectl port-forward` as the CLI's only path to Temporal is a manual, single-operator workflow** — acceptable because M2 explicitly keeps admin-CLI triggering (M3 is when this stops mattering, via Gateway webhooks). Not a long-term answer, not meant to be one.
- **Two independent mode switches (`GITHUB_TOKEN`, `KUBERNETES_SERVICE_HOST`) in the same composition root risk an untested combination** (e.g., in-cluster but no `GITHUB_TOKEN` — memory ports + K8s Job runner, a combination nothing in M1 or M2 actually exercises end-to-end). Worth naming rather than silently allowing; not blocking M2's gate, which only requires the one combination the gate itself defines (both set).

## Package/file summary

- **Changed:** `packages/worker/src/main.ts` (in-cluster branch, `KubeConfig` construction).
- **Changed:** `packages/workflows/src/activities-api.ts` (`heartbeatTimeout` on `runAgent`).
- **Changed:** `README.md` (in-cluster runbook, port-forward instructions, the wiped-host verification steps).
- **Changed (in `agentops-platform`):** `clusters/ops/engine/values.yaml` (real `temporalAddress`, image tags, namespace).

## Open questions carried forward

- The untested `KUBERNETES_SERVICE_HOST`-without-`GITHUB_TOKEN` combination — named as a risk, not resolved; revisit if it ever matters in practice.
- Whether `heartbeatTimeout: '15s'` is the right value in practice — a starting point, tune after the manual runbook surfaces real poll-latency numbers.
