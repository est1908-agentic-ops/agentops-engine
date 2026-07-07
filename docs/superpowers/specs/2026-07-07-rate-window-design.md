# Subscription Rate-Window Awareness — Design

Status: draft · 2026-07-07 · Owner: Artem
Milestone: M5, sub-project 4 of 4 (see [decomposition](2026-07-07-m5-decomposition.md))

## Context

ARCHITECTURE.md §5.5/§9 names a real constraint this repo has deferred since M1: subscription CLIs (`claude`, `pi`) are rate-limited per plan (e.g. "prompts per 5h/week" for Claude Max), and "the budget layer should schedule around them, not just count tokens." Nothing in code enforces this today — `claude-backend-design.md`'s own open questions explicitly deferred it to M5. Unlike sub-projects 1-3, this is entirely orthogonal to LiteLLM/budget-exceeded: the subscription lane never touches LiteLLM at all (ARCHITECTURE.md §5.5's two lanes are genuinely separate), so this doc doesn't depend on or modify anything sub-projects 1-3 built.

## Goal

`claude`/`pi` backends can be wrapped with a per-provider sliding-window call limiter, config-driven (env vars, no hardcoded quota — real numbers depend on the plan tier in use, which this sub-project doesn't know). When the window is exhausted, the *activity* retries automatically after the exact wait, transparent to the workflow — a scheduling fact, not a human-facing brake.

## Non-goals

- **A specific hardcoded quota for any plan.** No number in ARCHITECTURE.md or its research is treated as authoritative enough to bake in; the mechanism is generic, real numbers are an operator/config concern (env vars, unset = unlimited, same as today).
- **A distributed/shared rate-limiter store (Redis, Postgres).** The limiter is in-memory, per-worker-process. Correct for today's single-replica worker Deployment (ARCHITECTURE.md §5.2); if the worker ever scales to multiple replicas, each replica's window is independent and the *effective* quota multiplies by replica count — a named, deliberate limitation, not fixed here.
- **Surfacing rate-window waits as a `blocked` workflow state.** Deliberately the opposite of sub-project 3's `budget-exceeded` handling: a rate window is a mechanical scheduling constraint the system should absorb by waiting, not something a human needs to act on. No `dev-cycle.ts`/`BlockReasonSchema` change in this doc.
- **Applying this to `litellm`/`stub`/`cursor`.** `litellm` is the API-key lane (pay-per-token, no "prompts per window" concept — LiteLLM's own hard caps, sub-project 1-3, cover its budget story); `stub` is test-only; `cursor` doesn't exist (deferred, per the decomposition doc).

## Design

### `RateWindowLimiter` (`packages/backends/src/rate-window/rate-window-limiter.ts`)

A pure sliding-window counter, no Temporal/IO knowledge — an injectable clock (`now: () => number`, defaulting to `Date.now`) makes it directly unit-testable without fake timers. `msUntilSlot()` returns `0` if a call is allowed now, otherwise the exact ms until the oldest call in the window ages out. `recordCall()` records one. Both prune expired entries first, so the window is always evaluated against only the calls still within it.

### `RateWindowedBackend` (`rate-windowed-backend.ts`)

A decorator implementing `AgentBackend`, wrapping any inner backend (`claude`'s or `pi`'s `ProcessCliRunner`/`K8sJobRunner`). On `run()`: if `limiter.msUntilSlot() > 0`, throws `RateWindowExceededError` (carrying `retryAfterMs`) *without calling the inner backend* — no wasted CLI spawn/Job launch for a call that's going to be rejected anyway. Otherwise records the call and delegates.

### Activity boundary: `create-activities.ts`

A caught `RateWindowExceededError` converts to `ApplicationFailure.create({ type: 'RateWindowExceededError', nonRetryable: false, nextRetryDelay: err.retryAfterMs })` — **retryable**, unlike the `LiteLlmBudgetExceededError`/`WorkspaceError` precedents (which are definitive failures). `nextRetryDelay` (a plain number of ms, per `@temporalio/common`'s `Duration` type) overrides Temporal's own backoff calculation for that attempt, so the activity retry mechanism itself waits out the window — no workflow code touched, matching this sub-project's non-goal above. `agentActivities`' proxy has no `scheduleToCloseTimeout` set (only `startToCloseTimeout: '30 minutes'` per attempt), so a multi-hour wait between attempts doesn't violate the per-attempt timeout; each attempt itself fails fast.

### Wiring: `packages/worker/src/main.ts`

`buildBackends` gains `wrapWithRateWindow(backend, envPrefix, name)`: reads `${envPrefix}_RATE_WINDOW_MAX_CALLS`/`${envPrefix}_RATE_WINDOW_MS`; if either is unset or non-positive, returns the backend unwrapped (today's behavior, unchanged default). Applied to `claude` and `pi` in *both* the local (`ProcessCliRunner`) and in-cluster (`K8sJobRunner`) branches — the wrapping is identical either way, since it only gates the call, it doesn't care how the inner backend executes.

## Testing strategy

Unit tests: `rate-window-limiter.test.ts` (4 cases — allows up to `maxCalls`, reports a positive wait once exhausted, frees a slot once the oldest call ages out, doesn't miscompute the wait for a call that's already aged out) and `rate-windowed-backend.test.ts` (2 cases — delegates and records when free, throws without delegating when exhausted). Plus two new cases in `create-activities.test.ts`'s existing "error translation" pattern (`describe('createActivities — backend error translation')`), covering both this sub-project's `RateWindowExceededError` conversion and sub-project 3's previously-e2e-only `LiteLlmBudgetExceededError` conversion, now also unit-tested directly. `pnpm lint`/`typecheck`/`test` (255 tests, up from 247) /`e2e` (6, unchanged — this sub-project adds no new e2e scenario, since there's nothing workflow-visible to prove) all green.

## Named risks

- **In-memory, single-replica-only correctness**, named above — the only real risk in this design, and a deliberate scope cut rather than an oversight.
- **No validation that `${envPrefix}_RATE_WINDOW_MAX_CALLS`/`_MS` are sensible** (e.g., a `windowMs` of `0` after `Number()` coercion of a malformed string falls through to "unwrapped" silently, per the `<= 0` check, rather than erroring loudly on a typo'd config value). Consistent with how other env-driven config in `main.ts` (`AGENT_RUNNER_IMAGE`, secret names) isn't validated at startup either — a misconfiguration surfaces as "the limiter doesn't do anything," not a crash, which is arguably the safer failure direction for something whose whole job is not blocking real work.

## Package/file summary

- **New:** `packages/backends/src/rate-window/{rate-window-limiter,rate-windowed-backend}.ts` (+ their tests).
- **Changed:** `packages/backends/src/index.ts` (exports), `packages/activities/src/create-activities.ts` (+test), `packages/worker/src/main.ts`.

## Open questions carried forward

- None — this closes out M5's decomposition doc. Real per-plan quota numbers (if ever needed as defaults rather than pure operator config) would be the natural next question, but nothing here blocks on it.
