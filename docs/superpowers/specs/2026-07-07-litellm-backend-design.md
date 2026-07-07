# LiteLLM-Routed Backend — Design

Status: draft · 2026-07-07 · Owner: Artem
Milestone: M5, sub-project 2 of 4 (see [decomposition](2026-07-07-m5-decomposition.md))

## Context

`agentops-platform`'s sub-project 1 stood up a real LiteLLM gateway at `litellm.platform.svc.cluster.local:4000`, routing one model (`zai-glm-4.6`) to z.ai's GLM. Nothing in `agentops-engine` calls it yet. This sub-project adds the backend that does — the first backend in this repo that isn't a CLI spawn.

## Goal

`routing.<stage> = { backend: 'litellm', model: 'zai-glm-4.6' }` in a `ProductConfig` makes `runStageAgent` call the LiteLLM proxy over HTTP and return a real `AgentRunResult`, indistinguishable in shape from what `claude`/`pi` return — the workflow, brakes, and stats recording all keep working unmodified. A budget-exceeded response from LiteLLM surfaces as a distinctly-typed error, ready for sub-project 3 to map into a workflow-level blocked reason.

## Non-goals

- **Wiring the budget-exceeded error into `create-activities.ts`/`BlockReasonSchema`/the workflow.** This doc only makes the error distinctly *typed* (`LiteLlmBudgetExceededError` vs. the generic `LiteLlmRequestError`) at the backend boundary. Consuming it — converting to `ApplicationFailure.nonRetryable`, adding a new `BlockReason`, proving it end-to-end — is sub-project 3, same "backend throws, activity boundary converts" split `WorkspaceError` already established.
- **Mapping `effort` to any LiteLLM/OpenAI request parameter.** Nothing in the `chat/completions` spec z.ai's GLM is confirmed to support maps cleanly to `ModelRef.effort` (OpenAI's `reasoning_effort` is model-specific to the o-series; guessing at a mapping that silently gets dropped or, worse, rejected by `drop_params: false`, is worse than not sending it). Revisit if a concrete model needs it.
- **Actually calling the real z.ai model.** No live cluster/LiteLLM/z.ai key from this sandbox (same posture as sub-project 1) — verified via unit tests against a mocked `fetch`, real end-to-end call is an operator/sub-project-3 e2e-test concern.
- **Retry/backoff policy tuning for LiteLLM-side errors.** `LiteLlmRequestError` is a plain `Error` — Temporal's default activity retry policy applies, same as an unconverted `ProcessCliProcessError` today. No new retry policy introduced here.

## Design

### Contract change

`packages/contracts/src/model.ts`: `ModelRefSchema.backend` gains `'litellm'`. Per the decomposition doc's cross-cutting decision, this is a *transport kind*, not a provider — `ModelRef.model` for a `litellm`-routed stage is always the LiteLLM-side `model_list` alias (`zai-glm-4.6`), never the raw provider string (`zai/glm-4.6`). That indirection lives entirely in `agentops-platform`'s `values.yaml`; adding OpenRouter or direct-Anthropic later is a `model_list` entry there, zero change here.

### `LiteLlmBackend` (`packages/backends/src/litellm/litellm-backend.ts`)

Implements the same one-method `AgentBackend` interface every other backend does — `run(req): Promise<AgentRunResult>` — but skips `CliSpec`/`ProcessCliRunner` entirely (no process to spawn) and calls `fetch` directly against `${baseUrl}/chat/completions`:

- **Request:** `POST`, `Authorization: Bearer <apiKey>`, body `{ model: req.model, messages: [{ role: 'user', content: req.prompt }] }`. `req.limits.maxTokens` (the workflow's cumulative token brake) is deliberately *not* sent as an OpenAI `max_tokens` param — that field caps a single call's output length, an unrelated concept; `claude`/`pi` don't map it into their CLI invocations either, and the brake is enforced identically regardless of backend from the *returned* `tokensIn`/`tokensOut` (`dev-cycle.ts`'s `cumulativeTokens` accumulation doesn't care which backend produced them).
- **Timeout:** `req.limits.timeoutMs` via `AbortController`, same budget every backend already respects, enforced here instead of by `ProcessCliRunner`'s kill-on-timeout since there's no child process.
- **Response parsing:** reads `response.text()` once (used for both the success and error paths, so a malformed error body doesn't crash *before* reaching the error-classification logic), then `choices[0].message.content` → `output`, `usage.prompt_tokens`/`usage.completion_tokens` → `tokensIn`/`tokensOut`.
- **Error taxonomy** — two classes, deliberately not one, because sub-project 3 needs to tell them apart:
  - `LiteLlmBudgetExceededError` — only when status is `429` *and* the body identifies itself as LiteLLM's own budget check (`error.error_class === 'BudgetExceededError'`, falling back to a message-text match if `error_class` isn't present in some proxy version) — confirmed against LiteLLM's actual documented behavior, not guessed. A plain `429` without that marker (a real provider-side rate limit, which LiteLLM also surfaces as `429`) stays a generic error — conflating the two would make a transient rate limit look like a hard budget brake.
  - `LiteLlmRequestError` — everything else: network failure, timeout/abort, non-2xx/non-budget status, unparseable body, missing `choices[0].message.content`. All plain `Error` subclasses, all activity-retryable by default (same as `ProcessCliProcessError` today).

### Wiring

`packages/backends/src/index.ts` exports the new module. `packages/worker/src/main.ts`'s `buildBackends` constructs one `LiteLlmBackend` (`LITELLM_BASE_URL` env, defaulting to the in-cluster Service address; `LITELLM_API_KEY` env, no default) and registers it under `litellm` in *both* the in-cluster and local branches — unlike `claude`/`pi`, it never switches to a `K8sJobRunner`, since there's no CLI process to run as a Job; the same HTTP call happens the same way regardless of where the worker itself runs.

## Testing strategy

Unit tests (`litellm-backend.test.ts`, 7 cases) against a mocked `fetchFn` — no live LiteLLM/z.ai call, same posture as `claude-backend.test.ts`/`pi-backend.test.ts` mocking `spawn`: successful call shape (request body/headers, response parsing), budget-exceeded vs. plain-429 discrimination, non-429 error status, network failure, malformed response body, and timeout/abort. `tsc --noEmit` and the full test file pass locally (`pnpm exec vitest run packages/backends/src/litellm/litellm-backend.test.ts` — 7 passed).

## Named risks

- **The `error_class: 'BudgetExceededError'` field's exact shape is confirmed from LiteLLM's public docs/issue tracker, not from a live call against the deployed proxy** (no live LiteLLM in this sandbox) — if a future LiteLLM version changes this shape, `isBudgetExceeded`'s message-text fallback (`/budget has been exceeded/i`) is the safety net, but sub-project 3's e2e test should assert against whatever the real deployed version actually returns before this is trusted in production.
- **`LITELLM_API_KEY` has no default and isn't validated at worker startup** — a misconfigured deploy fails at the first `litellm`-routed call (an auth error from LiteLLM, surfaced as `LiteLlmRequestError`), not at worker boot. Consistent with how `claude`/`pi`'s auth secrets aren't validated at startup either, but flagged since it's a new failure mode class (HTTP auth vs. CLI env-var auth).

## Package/file summary

- **New:** `packages/backends/src/litellm/litellm-backend.ts`, `litellm-backend.test.ts`.
- **Changed:** `packages/contracts/src/model.ts` (`backend` enum), `packages/backends/src/index.ts` (export), `packages/worker/src/main.ts` (`buildBackends` registers `litellm`).

## Open questions carried forward

- Whether `LiteLlmRequestError` on a non-budget `429` (real provider rate limit) should get its own distinct handling (backoff hint, different `BlockReason`) in sub-project 3, or stay lumped with generic request failures — current lean is "stays generic," since Temporal's default retry already handles transient failures reasonably and this doesn't need special-casing until a real rate-limit storm shows it does.
- Real `LITELLM_API_KEY` provisioning path (a virtual key created via sub-project 1's admin API, not the master key itself, for least-privilege) — deferred to sub-project 3, which is the first place a key actually needs to exist for the gate demonstration.
