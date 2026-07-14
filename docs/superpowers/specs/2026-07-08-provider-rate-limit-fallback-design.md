# Provider Rate-Limit Fallback & Heartbeat Observability — Design

Status: draft · 2026-07-08 · Owner: Artem

## Context

`issue-acme-94` (`devCycle` workflow, dev-agents namespace) failed outright after the `implement` stage's `runAgent` activity exhausted all 5 Temporal retry attempts against the same error: z.ai returning `429 Your account's current usage pattern does not comply with the Fair Usage Policy...` for the `pi`/`zai/glm-5.2` call. Root-caused via `debug-devcycle-issue`: the error is a raw, untyped `ProcessCliProcessError` thrown from `pi-backend.ts`'s `parseOutput` (it re-throws pi's own `errorMessage` verbatim when a turn's `stopReason` is `error`/`aborted`), so it isn't recognized as anything special — it just retries the identical call five times over ~11.5 minutes and dies.

Two independent gaps surfaced investigating this:

1. **No fallback when a provider throttles a call.** The existing `RateWindowedBackend` (M5, [rate-window-design.md](2026-07-07-rate-window-design.md)) only *proactively* paces calls against a locally-tracked quota — it has no reaction to the provider's own 429 response, and its env-driven config (`PI_RATE_WINDOW_MAX_CALLS`/`_MS`) is unset everywhere in this repo's charts today, so it's a complete no-op for `pi`.
2. **Near-zero heartbeat detail.** `K8sJobRunner.run()` (the in-cluster path for `pi`/`claude`) already heartbeats every 3s while a Job runs — but with no payload, just a bare ping to avoid the heartbeat timeout. Every other backend (`LiteLlmBackend`, `ProcessCliRunner`, `StubBackend`) never heartbeats at all. Per `debug-devcycle-issue`'s own documented limitation, heartbeat/pending-activity detail is the *only* place a still-retrying activity's progress is visible while a workflow is open — once it closes, that state is gone. Today that channel carries nothing.

Confirmed with Artem: this specific 429 is understood to self-clear after a cooldown (not something requiring a manual request to z.ai support, despite the message's wording), and a workflow-visible `blocked` state is explicitly *not* wanted for it — visibility should go through tracing/logs (and Temporal heartbeat detail, if that's a natural fit), not workflow state, so the fix is generic across every workflow that calls `runAgent` (`devCycle`, `platform`), not just `dev-cycle.ts`.

## Goal

When `pi` gets provider-rate-limited, an in-flight call automatically retries once against a configured fallback model on the same backend (e.g. `openrouter/deepseek-v4-pro`, both natively supported by the `pi` CLI's own provider routing — no new backend integration needed), with a heartbeat + log line marking that it happened. Separately, `runAgent`'s heartbeats across all backends carry enough detail that a still-open workflow's Pending Activities view actually tells you something.

## Non-goals

- **Any `dev-cycle.ts`/`platform.ts`/contracts change.** No new `BlockReason`, no `ProductConfig` field, no workflow-level retry loop. Everything lives in `packages/backends`/`create-activities.ts`, so it applies uniformly to any workflow proxying `runAgent` — deliberately the opposite of the `budget-exceeded` precedent, which *is* workflow-visible by design because that one genuinely needs a human.
- **A human-in-the-loop resume path for this error.** Per Artem's confirmation this self-clears; if that assumption ever proves wrong, Temporal's existing `maximumAttempts: 5` + backoff on `agentActivities` is still the outer bound — no new one is introduced here.
- **Fixing `RateWindowedBackend`'s dormant config or its single-replica limitation.** Named in the M5 design as a deliberate cut; still unaddressed, still not this doc's problem. Turning on real quota numbers for `PI_RATE_WINDOW_MAX_CALLS`/`_MS` is a valid follow-up but needs real numbers from z.ai's plan, which nobody has today.
- **Heartbeats for `ProcessCliRunner`.** That's the local/non-cluster dev path only, not what's debugged via Temporal in production. Named as a known gap, not fixed here.
- **Generalizing detection to `claude-backend.ts` in this pass.** The shared detection utility is written so it *can* be reused there, but only `pi` is confirmed affected today; wiring `claude` is a one-line follow-up, not bundled in here to keep the diff scoped to the incident.

## Design

### Detection: `packages/backends/src/provider-rate-limit.ts` (new)

```ts
export class ProviderRateLimitedError extends Error {}

export function isProviderRateLimitMessage(message: string): boolean {
  return /\b429\b/.test(message) && /(fair usage policy|rate limit|request frequency)/i.test(message);
}
```

Deliberately narrower than "contains 429" alone — a bare 429 without one of those phrases stays a generic `ProcessCliProcessError`, since not every 429 a CLI surfaces is this specific throttle-and-recover class of failure.

### Wiring into `pi-backend.ts`

In `parseOutput`, where a `stopReason: 'error'`/`'aborted'` turn currently always throws `ProcessCliProcessError(lastAssistantMessage.errorMessage ?? ...)` (line 84): check `isProviderRateLimitMessage(errorMessage)` first and throw `ProviderRateLimitedError(errorMessage)` instead when it matches, falling through to the existing `ProcessCliProcessError` otherwise.

### `RateLimitFallbackBackend` (`packages/backends/src/rate-limit-fallback/rate-limit-fallback-backend.ts`, new)

A decorator implementing `AgentBackend`, structurally symmetric to `RateWindowedBackend`:

```ts
export class RateLimitFallbackBackend implements AgentBackend {
  constructor(
    private readonly inner: AgentBackend,
    private readonly fallbackModel: string,
    private readonly backendName: string,
    private readonly heartbeat: (details: unknown) => void = (d) => Context.current().heartbeat(d),
  ) {}

  async run(req: BackendRunRequest): Promise<AgentRunResult> {
    try {
      return await this.inner.run(req);
    } catch (err) {
      if (!(err instanceof ProviderRateLimitedError)) throw err;
      const details = {
        event: 'provider-rate-limited',
        backend: this.backendName,
        taskId: req.taskId,
        stage: req.stage,
        primaryModel: req.model,
        fallbackModel: this.fallbackModel,
        message: err.message,
      };
      this.heartbeat(details);
      console.warn(JSON.stringify(details));
      return this.inner.run({ ...req, model: this.fallbackModel });
    }
  }
}
```

One retry against the fallback model, same backend instance (so `pi`'s own `openrouter` provider routing handles auth via the `OPENROUTER_API_KEY` already present in the `pi-credentials` secret — confirmed live on `agentops-platform`'s `main`, no provisioning needed). If the fallback also throws, or none is configured, the original (or fallback's) error propagates untouched into the same generic path every other backend error already takes in `create-activities.ts` — no new `ApplicationFailure` type. Temporal's existing `maximumAttempts: 5` + default backoff on `agentActivities` then retries the *whole* activity, which tries primary-then-fallback again each time — bounded, no new bookkeeping.

The heartbeat is the "Temporal warning" — visible live in Pending Activities while the workflow is open. The paired `console.warn` exists because heartbeat/pending-activity detail is ephemeral (gone once the workflow closes, per `debug-devcycle-issue`'s documented limitation) — this incident would not have been fully diagnosable from heartbeat alone once `issue-acme-94` was already closed; the log line lands in Loki via the existing stdout pipeline and survives.

### Wiring: `packages/worker/src/main.ts`

`buildBackends` gains `wrapWithRateLimitFallback(backend, envPrefix, name)`, reading `${envPrefix}_RATE_LIMIT_FALLBACK_MODEL`; unset means passthrough (unwrapped), same convention as `wrapWithRateWindow`. Applied to `pi` (both local and in-cluster branches) as the outermost wrapper — i.e. `wrapWithRateLimitFallback(wrapWithRateWindow(new K8sJobRunner(...), 'PI', 'pi'), 'PI', 'pi')` — so a proactive `RateWindowExceededError` (thrown *before* the inner backend is even called) is unaffected by this layer; only an actual provider-side `ProviderRateLimitedError` from a real call triggers the fallback.

### Heartbeat enrichment

**`create-activities.ts::runAgent`** — one heartbeat immediately before dispatching to `backend.run(...)`:

```ts
Context.current().heartbeat({ phase: 'started', taskId: req.taskId, stage: req.stage, attempt: req.attempt, callIndex: req.callIndex, backend: req.backend, model: req.model });
```

Guarantees every activity attempt shows identity detail in Temporal's UI immediately, regardless of backend — today `StubBackend`/`LiteLlmBackend`/`ProcessCliRunner` never heartbeat at all, so an attempt using them shows nothing until it resolves.

**`K8sJobRunner.run()`** — the existing bare `this.heartbeat()` call inside the poll loop (line 208) becomes `this.heartbeat(details)`, where `details` carries the *previous* iteration's known Job status (a `lastStatus` variable seeded `undefined` on iteration 1, updated after each `readNamespacedJobStatus` call):

```ts
{ phase: lastStatus ? 'polling' : 'job-created', jobName, taskId: req.taskId, stage: req.stage, elapsedMs: this.now() - start, timeoutMs: req.limits.timeoutMs, jobStatus: lastStatus }
```

Heartbeat stays the first statement in the loop body (unchanged position) so cancellation is noticed just as fast as today — only its argument changes, using state already known from the *prior* tick rather than blocking on a fresh status read first.

**`LiteLlmBackend.run()`** — one heartbeat immediately before the `fetch` call, same shape as the `create-activities.ts` one minus backend-specific fields. No mid-flight loop to enrich (single request/response), but it's currently completely dark; this at least confirms the activity reached the point of calling out.

## Testing strategy

- `provider-rate-limit.test.ts`: `isProviderRateLimitMessage` against the real z.ai message, a bare unrelated "429" (should not match), and a non-429 "rate limit" phrase (should not match).
- `pi-backend.test.ts`: new case asserting `ProviderRateLimitedError` (not `ProcessCliProcessError`) on a `stopReason: 'error'` turn whose `errorMessage` matches the pattern.
- `rate-limit-fallback-backend.test.ts`: delegates straight through on success; on `ProviderRateLimitedError`, heartbeats with expected details and retries once against the fallback model; on fallback failure, propagates the fallback's error; on a non-rate-limit error, propagates without touching the fallback at all.
- `k8s-job-runner.test.ts`: existing heartbeat-count assertions extended to check heartbeat *argument* shape/content across a multi-poll run (job-created → polling with prior status).
- `litellm-backend.test.ts`: one new case asserting a heartbeat fires before the fetch call, via an injectable heartbeat function (mirroring `K8sJobRunner`'s `opts.heartbeat` pattern).
- `create-activities.test.ts`: one new case asserting the pre-dispatch heartbeat fires with the expected identity fields.
- No new e2e scenario — nothing here changes workflow-visible behavior (per the non-goals), so there's nothing an e2e test would newly prove.

## Named risks

- **Fallback quality/cost are unvalidated.** `openrouter/deepseek-v4-pro` hasn't been evaluated against `zai/glm-5.2` for this pipeline's stages — this design makes the *mechanism* available and correct, not a claim that the fallback model produces equivalent results. Worth an `EvalRun`-style comparison later (M9 territory), not blocking this fix.
- **One fallback attempt, not a fallback chain.** If the fallback model is itself rate-limited or fails, the error just propagates — no cascading list of fallbacks. Matches the actual ask (one specific fallback), avoids speculative generality.
- **Heartbeat detail size.** `jobStatus`/identity fields are small, well under Temporal's heartbeat payload limits, but this hasn't been measured against a real payload from a busy cluster; if a future workflow needs to embed something large here, it should go to a log line instead, not the heartbeat.

## Package/file summary

- **New:** `packages/backends/src/provider-rate-limit.ts`, `packages/backends/src/rate-limit-fallback/rate-limit-fallback-backend.ts` (+ tests for both).
- **Changed:** `packages/backends/src/pi/pi-backend.ts`, `packages/backends/src/k8s/k8s-job-runner.ts`, `packages/backends/src/litellm/litellm-backend.ts`, `packages/backends/src/index.ts` (exports), `packages/activities/src/create-activities.ts` (+ test), `packages/worker/src/main.ts`.

## Open questions carried forward

- Whether to wire `isProviderRateLimitMessage` into `claude-backend.ts` too (named as a non-goal here, not because it's wrong, just unconfirmed as affected yet).
- Whether `PI_RATE_LIMIT_FALLBACK_MODEL` should default to `openrouter/deepseek-v4-pro` in the chart, or stay operator-set with no default (leaning the latter, consistent with how `RATE_WINDOW` env vars default to "off" rather than guessing a number) — a chart change, not a code question, left for implementation.
