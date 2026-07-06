# OTel Instrumentation — Design

Status: draft · 2026-07-07 · Owner: Artem
Milestone: M4, sub-project 2 of 5 (see [decomposition](2026-07-06-m4-decomposition.md))

## Context

Sub-project 1 (merged, `flair-hr/agentops-platform#16`) stood up Alloy/Prometheus/Loki/Tempo/Grafana/MailPit and pinned the concrete OTLP endpoint this sub-project targets: `alloy.platform.svc.cluster.local:4317` (gRPC, in-cluster only). Today `@opentelemetry/api` is only a transitive dependency pulled in by the Temporal SDK — no span is created anywhere in this codebase. This doc wires real tracing into the worker.

## Goal

Every `devCycle` workflow execution produces one trace, walkable in Tempo/Grafana without `kubectl`: a root span for the workflow run, one child span per stage's `runAgent` activity call (carrying token/cost/model attributes), correctly nested and timed.

## Non-goals

- **Spans from `packages/gateway` or `packages/cli`** (where workflows are *started*, not where they *run*). The decomposition doc scopes this sub-project to "the worker and agent-runner Jobs" specifically. Without a client-side span, each workflow execution becomes its own trace root rather than a child of "webhook received" — a real but acceptable gap; adding `OpenTelemetryWorkflowClientInterceptor` to those two packages later is a small, independent follow-up, not a redesign.
- **Per-LLM-call spans.** ARCHITECTURE.md §5.6 describes "stage span → CLI span → LLM-call spans." That third level isn't achievable today without a larger change — see "Why no LLM-call-level spans" below. Token/cost/model attributes are attached to the CLI-call span instead of split into child spans.
- **Instrumentation code running inside the agent-runner Job pod.** There is no such code to instrument — see below.
- **`packages/gateway`'s own HTTP server spans, Postgres query spans, or anything from sub-project 3** (the stats projection doesn't exist yet). Out of scope here.

## Design

### Why no code runs "in" the agent-runner Job

`K8sJobRunner.run()` (`packages/backends/src/k8s/k8s-job-runner.ts`) creates a K8s Job whose container command is `/bin/sh -c '...' claude ...args` — the raw CLI binary, directly, with stdout/stderr redirected to files on the shared PVC (`images/agent-runner/Dockerfile` confirms the image is just `node:22-slim` + the CLI packages, no wrapper process). There is no Node process inside that pod we control to add SDK calls to, and we don't control the CLI binaries' internals. So "spans from... agent-runner Jobs" means spans **representing** a Job's execution, created from the **worker-side code that launches and polls it** (`K8sJobRunner`/`ProcessCliRunner`, both already activity code) — not spans emitted from inside the Job pod itself. The span's duration is the Job's real wall-clock lifetime (submission to completion), which is a faithful proxy.

### Why no LLM-call-level spans

`createClaudeCliSpec`'s `buildArgs` uses `--output-format json` (`packages/backends/src/claude/claude-backend.ts:38`) — a single JSON object parsed after the process exits, with one aggregate `usage` total for however many internal turns the CLI took (up to `--max-turns 30`). There is no per-turn event stream today, so there is no data to build separate LLM-call spans from. `claude` (and presumably `pi`) support a streaming output mode (`--output-format stream-json`) that would expose per-turn events, but switching to it means rewriting `CliSpec.parseOutput`'s interface from "parse a final string" to "consume a stream," a materially bigger change than instrumentation. Named as an open question, not solved here.

### Dependency pins

OTel JS ships two release lines that don't mix at runtime: the stable 1.x/2.x core (`api`, `core`, `resources`, `sdk-trace-*`) and 0.x "experimental" exporters. `@temporalio/interceptors-opentelemetry`'s pinned version for this repo's Temporal SDK line (`^1.11.0`, matching every other `@temporalio/*` dependency already in this monorepo) depends on `@opentelemetry/{core,resources,sdk-trace-base}@^1.19.0` — the 1.x line. The **latest** `@opentelemetry/exporter-trace-otlp-grpc` (`0.220.0`) has already moved to depend on `@opentelemetry/sdk-trace@2.9.0` (the 2.x line, which changed `Resource` from a class to a factory function — a real breaking change for `makeWorkflowExporter(exporter, resource)`'s signature). Verified against the npm registry directly (not assumed): `@opentelemetry/exporter-trace-otlp-grpc@0.57.2` is the last version still depending on the 1.x line, and its dependency versions are internally consistent:

| Package | Version | Why this exact version |
|---|---|---|
| `@temporalio/interceptors-opentelemetry` | `^1.11.0` | Matches this repo's pinned `@temporalio/*` SDK line exactly (confirmed this version exists on npm) |
| `@opentelemetry/api` | `^1.9.0` | Already the transitive floor every `@temporalio/*` package requires |
| `@opentelemetry/core` | `1.30.1` | Last coherent 1.x release wave (confirmed via `exporter-trace-otlp-grpc@0.57.2`'s own `dependencies`) |
| `@opentelemetry/resources` | `1.30.1` | Same wave — this is the `Resource` type `makeWorkflowExporter` expects |
| `@opentelemetry/sdk-trace-base` | `1.30.1` | Same wave |
| `@opentelemetry/sdk-trace-node` | `1.30.1` | Same wave (confirmed this exact version exists) |
| `@opentelemetry/exporter-trace-otlp-grpc` | `0.57.2` | Last version on the 1.x line — pinning *this* pins everything above transitively too |

Pinning exact versions (not `^`) for the five OTel SDK packages above, since going even one release past `0.57.2` on the exporter silently drags in the 2.x line. `@temporalio/interceptors-opentelemetry` stays on `^` like its siblings since it's versioned in lockstep with the SDK, not with OTel's release cadence.

### Where the SDK initializes: `packages/worker/src/tracing.ts` (new)

Only the worker process needs this (not `packages/workflows` — see determinism section). Feature-detected on `OTEL_EXPORTER_OTLP_ENDPOINT` presence, the same pattern this file already uses for `KUBERNETES_SERVICE_HOST`/registry-presence: if unset, `setupTracing()` is a no-op and every `trace.getTracer(...)` call anywhere in the process returns `@opentelemetry/api`'s built-in no-op tracer — zero overhead, no connection-refused noise in local dev/tests/e2e, no new flag to remember.

When set:
1. Build a `Resource` (`service.name: 'agentops-worker'`).
2. Construct `OTLPTraceExporter` — its default constructor already reads `OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` per the OTel env-var spec, so the worker doesn't need to parse the URL itself.
3. Register a `NodeTracerProvider` globally (`provider.register()`) with a `BatchSpanProcessor(exporter)` — this is what makes `OpenTelemetryActivityInboundInterceptor`'s internal `otel.trace.getTracer(...)` call (no explicit tracer passed) resolve to a real, exporting tracer instead of the no-op default.
4. Return `{ workflowExporterSink: makeWorkflowExporter(exporter, resource), tracer, shutdown }` for `create-worker.ts` to wire in, and for `main.ts` to call `shutdown()` on process exit (flushes the `BatchSpanProcessor`'s buffer — otherwise the last batch of spans from a short-lived process can be lost, a real and easy-to-miss failure mode with batch processors).

### Worker wiring: `packages/worker/src/create-worker.ts`

```ts
Worker.create({
  ...,
  sinks: tracing ? { exporter: tracing.workflowExporterSink } : undefined,
  interceptors: {
    activityInbound: tracing ? [(ctx) => new OpenTelemetryActivityInboundInterceptor(ctx, { tracer: tracing.tracer })] : [],
    workflowModules: tracing ? [require.resolve('@agentops/workflows/lib/otel-interceptors')] : [],
  },
})
```

(Illustrative — exact shape follows `@temporalio/worker`'s `WorkerOptions.interceptors`/`sinks` types.)

### Workflow-side module: `packages/workflows/src/otel-interceptors.ts` (new)

```ts
import {
  OpenTelemetryInboundInterceptor,
  OpenTelemetryOutboundInterceptor,
  OpenTelemetryInternalsInterceptor,
} from '@temporalio/interceptors-opentelemetry/lib/workflow';

export const interceptors = () => ({
  inbound: [new OpenTelemetryInboundInterceptor()],
  outbound: [new OpenTelemetryOutboundInterceptor()],
  internals: [new OpenTelemetryInternalsInterceptor()],
});
```

This is the standard shape Temporal's own docs/samples use for workflow interceptor modules (referenced by path via `workflowModules`, since workflow code runs in an isolated V8 sandbox and can't receive live object references from the worker process).

### Determinism boundary (AGENTS.md hard rule #1)

`packages/workflows` "may not do I/O, use `Date.now()`, `Math.random()`, timers... workflow-safe utilities only." This sub-project adds two things to that package and both are deliberately chosen to satisfy that rule, not exceptions to it:

1. **`@temporalio/interceptors-opentelemetry`'s `workflow/` submodule** is purpose-built by Temporal for exactly this boundary: it doesn't call wall-clock time itself (span timestamps come from the workflow sandbox's own deterministic clock, the same one `sleep()`/`condition()` already rely on) and it doesn't do I/O — spans are serialized (`SerializableSpan`) and handed to a **sink** (`OpenTelemetryWorkflowExporter`), which is Temporal's own mechanism for a workflow to call out to real worker-side code in a replay-safe way (the sink call itself is recorded in workflow history, so replay doesn't re-execute the actual I/O, matching how activity calls already work). This is the same category of "workflow-safe utility" `@temporalio/workflow` itself already is, not a new kind of exception.
2. **Calling `trace.getActiveSpan()?.setAttributes(...)` from inside `devCycle()`** (to attach `agentops.task_id`/`agentops.repo`, so a trace is identifiable without cross-referencing Temporal's own UI) only reads/mutates an in-memory span object already made "active" by the interceptor's context manager for the duration of the call — no wall-clock read, no I/O, no randomness. `@opentelemetry/api` is added as a `packages/workflows` dependency for this; it does not import from `activities`/`ports`/`backends`.

### Attributes on the activity ("CLI") span

`packages/activities/src/create-activities.ts`'s `runAgent`, after `backend.run(...)` returns, calls:

```ts
trace.getActiveSpan()?.setAttributes({
  'gen_ai.system': req.backend,
  'gen_ai.request.model': req.model,
  'gen_ai.usage.input_tokens': result.tokensIn,
  'gen_ai.usage.output_tokens': result.tokensOut,
  'agentops.stage': req.stage,
  'agentops.attempt': req.attempt,
});
```

`gen_ai.*` are the OTel semantic-convention attribute names for LLM usage (used as plain string literals here rather than importing them from `@opentelemetry/semantic-conventions`, since the GenAI conventions are still incubating in that package across versions — pinning to literal strings avoids coupling this to a moving incubating API). This is what ARCHITECTURE.md §5.6's "LLM spans carry prompt/token/cost attributes" becomes in practice, attached to the one span we can actually observe rather than split across calls we can't see.

### Chart wiring

`charts/engine/values.yaml`: new `otelExporterOtlpEndpoint: ""` (empty by default — chart ships no assumption about whether a cluster has the observability stack; `agentops-platform`'s values override sets the real value, same pattern `temporalAddress` already uses for a fixed in-cluster DNS name). `templates/deployment.yaml`: new env entry, only rendered when non-empty:

```yaml
{{- if .Values.otelExporterOtlpEndpoint }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ .Values.otelExporterOtlpEndpoint | quote }}
{{- end }}
```

`agentops-platform`'s `clusters/ops/engine/values.yaml` gets `otelExporterOtlpEndpoint: "http://alloy.platform.svc.cluster.local:4317"` added as a follow-up PR in that repo (small, one line — not bundled into this PR, matching how `temporalAddress`'s real value already lives there, not in this chart's defaults).

## Testing strategy

- **Unit:** `create-activities.test.ts` — with an `InMemorySpanExporter` (`@opentelemetry/sdk-trace-base`) and a real `NodeTracerProvider` registered for the test, assert `runAgent` produces a span with the expected `gen_ai.*`/`agentops.*` attributes. This is a real assertion against real span objects, not a mock.
- **Integration:** a new test builds a real `Worker` (via `createWorker`) with tracing wired in and a `TestWorkflowEnvironment` (the same harness `dev-cycle.test.ts`-style tests already use), runs a short `devCycle` against the `stub` backend, and asserts the `InMemorySpanExporter` captured a `RunWorkflow` span and at least one `RunActivity` span with the right parent-child relationship. This is what actually proves the workflow-side interceptor module bundles and runs correctly inside the sandboxed workflow environment — `helm template`-style "does it render" isn't available for this problem, so an executable test is the equivalent verification.
- **Chart:** `charts/engine/tests/render.golden.yaml` updated for the new (empty-by-default, so absent) env entry; `run.sh`'s existing diff check catches regressions.
- Not verified here (no cluster access from this sandbox): that spans actually arrive in Tempo. That's an operator smoke-test once this is deployed — open the Grafana Explore view against the Tempo datasource sub-project 1 already wired and search for a trace after running a real task.

## Named risks

- **`BatchSpanProcessor` can drop the final batch on process exit** if `shutdown()` isn't called — `main.ts` needs a `SIGTERM`/`SIGINT` handler (or a `finally` around `worker.run()`) that calls it; a worker that's just `kill -9`'d still loses the tail, an accepted gap matching how graceful shutdown generally isn't handled elsewhere in this file yet either.
- **No per-LLM-call spans** (see above) — the biggest gap versus ARCHITECTURE.md's literal three-level description. Not a blocker for this sub-project's own goal (one usable trace per task), but worth flagging so a future "switch to `--output-format stream-json`" pass isn't a surprise scope addition.
- **Gateway/CLI aren't trace roots yet** — every workflow execution is its own trace rather than nested under "webhook received." Named above as a non-goal, repeated here because it's the main way this sub-project's trace tree looks different from ARCHITECTURE.md's mental model.

## Package/file summary

- **New:** `packages/worker/src/tracing.ts`, `packages/workflows/src/otel-interceptors.ts`.
- **Changed:** `packages/worker/src/create-worker.ts`, `packages/worker/src/main.ts` (shutdown hook), `packages/activities/src/create-activities.ts`, `packages/workflows/src/dev-cycle.ts` (task_id/repo attributes), `charts/engine/values.yaml` + `templates/deployment.yaml` + `tests/render.golden.yaml`, `package.json` for `worker`/`activities`/`workflows` (new deps).
- **Not in this repo:** `agentops-platform`'s `clusters/ops/engine/values.yaml` real endpoint value — separate follow-up PR there, same division of labor sub-project 1 used for cross-repo wiring.

## Open questions carried forward

- Switching `claude`'s (and `pi`'s) CLI invocation to a streaming output format to get real per-turn LLM-call spans — a materially bigger change than this sub-project, deferred.
- Adding `OpenTelemetryWorkflowClientInterceptor` to `packages/gateway`/`packages/cli` so traces root at "webhook received"/"CLI invoked" instead of at the workflow — small, independent follow-up.
- The actual `otelExporterOtlpEndpoint` value change in `agentops-platform` — separate PR in that repo, not bundled here.
