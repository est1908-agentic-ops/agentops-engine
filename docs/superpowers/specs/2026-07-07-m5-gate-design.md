# M5 Gate Demonstration — Design

Status: draft · 2026-07-07 · Owner: Artem
Milestone: M5, sub-project 3 of 4 (see [decomposition](2026-07-07-m5-decomposition.md))

## Context

Sub-project 2 gave `agentops-engine` a real `litellm` backend, distinctly typed budget-exceeded errors, but nothing in `dev-cycle.ts` consumes them yet — a budget-exceeded failure today would propagate uncaught and fail the whole workflow execution, not park it `blocked` with a clear reason the way `token-brake`/`iteration-brake`/`babysit-brake` already do. This sub-project wires that consumption and proves both halves of M5's actual done-when: two differently-routed tasks, and a deliberately-low budget tripping a distinct, resumable block.

## Goal

An e2e test (`TestWorkflowEnvironment`, no live LiteLLM/z.ai call) proves: (1) two `devCycle` tasks with different `routing` configs each call the backend their config names — one `stub` (standing in for `claude`), one a real `LiteLlmBackend` with a scripted `fetchFn` — and both reach `done`; (2) a task routed through `litellm` whose scripted response is a budget-exceeded `429` reaches `blocked` with `blockReason: 'budget-exceeded'`, and completes after a `resume` signal once the scripted response switches to success.

## Design

### `BlockReason` gains `'budget-exceeded'`

`packages/contracts/src/stage.ts`'s `BlockReasonSchema` — a fifth block reason, kept distinct from `'token-brake'` per the decomposition doc's cross-cutting decision (independent enforcement layers, ARCHITECTURE.md §7).

### Activity boundary: `create-activities.ts`

`runAgent` now wraps `backend.run(...)` in a `try`/`catch`: a caught `LiteLlmBudgetExceededError` converts to `ApplicationFailure.nonRetryable(err.message, 'LiteLlmBudgetExceededError')` — the exact `rethrowWorkspaceError` shape this repo already established for `WorkspaceError` (`create-activities.ts`'s existing git-spawn-failure handling), reused rather than reinvented.

### Workflow: `dev-cycle.ts`

Two additions, deliberately small relative to the size of the function they touch:

1. **`runStageAgent` retries in place on a budget-exceeded activity failure.** Workflow code sees the activity's `ApplicationFailure` wrapped in Temporal's `ActivityFailure` (`.cause` holds the original `ApplicationFailure`, confirmed from `@temporalio/common`'s failure types) — `isBudgetExceededFailure` checks `err.cause?.type === 'LiteLlmBudgetExceededError'`. On a match: set `state.status = 'blocked'`, `state.blockReason = 'budget-exceeded'`, and call the *existing* `waitForResumeOrCancel()` — same escape hatch every other block reason already uses. Unlike the brake-block loop (which relaxes a counter and lets the outer loop *re-evaluate*), this one retries the *exact same call* once resumed, since there's no counter to relax — the fix is an operator bumping the virtual key's budget or rotating it, not a workflow-side threshold.
2. **A `DevCycleCancelledError` sentinel + one wrapping `try`/`catch` around the rest of the function body.** Budget-exceeded can occur inside `runStageAgent`, which is called from many places (pre-implement stages, the main implement/verify/review loop, the babysit loop's repair call) — retrying-in-place lives inside `runStageAgent` itself so every call site gets it for free, but a *cancel* received while blocked there needs to unwind out to the same cleanup every other cancel path already performs (`state.stage/status = 'failed'`, `cleanupWorkspace`, `return state`). Throwing a small sentinel class and catching it once, at the outermost scope, does that without duplicating the cleanup at every `runStageAgent` call site. The three *pre-existing* inline `cancelled` checks (pre-implement loop, the brake-block loop, the babysit-brake block) are untouched — this only adds a fourth, new path for the one new case that can't reuse them (it needs to unwind through arbitrarily-nested call sites, not just check a flag right after a single call site).

### Test wiring: `e2e/helpers.ts`

`buildTestEnv` gains an optional `extraBackends` parameter, merged into the activities' `backends` map alongside `stub`. This is the only helper change — the new e2e test constructs a real `LiteLlmBackend` with an injected `fetchFn` (same technique the backend's own unit tests use) and passes it in, rather than adding a bespoke scriptable test double for LiteLLM.

## Testing strategy

One new e2e file, `e2e/litellm-routing-and-budget.e2e.test.ts`, two cases:

- **Different routing:** two tasks, `routing.context` set to `{ backend: 'stub', ... }` and `{ backend: 'litellm', model: 'zai-glm-4.6' }` respectively; both reach `done`. Proves routing genuinely dispatches to the named backend per task/product, the literal M5 done-when wording.
- **Budget-exceeded block + resume:** one task routed through `litellm`; the injected `fetchFn` returns a `429`/`BudgetExceededError` body on its first call and a normal success afterward. Asserts `blocked`/`budget-exceeded`, signals `resume`, asserts `done` — the same shape `brake-and-rescue.e2e.test.ts` already established for `token-brake`, extended to the new reason.

`pnpm test` (247 existing unit tests, unchanged pass count) and `pnpm e2e` (4 existing + this sub-project's new file) both green; `pnpm lint`/`pnpm typecheck` clean across all packages.

## Named risks

- **The wrapping `try`/`catch` added around most of `devCycle`'s body is a real, if narrow, control-flow change to an already-large, well-tested state machine.** Mitigated by keeping the three pre-existing inline cancel checks untouched (this doesn't replace or refactor them, only adds a new path) and by the full existing e2e suite (4 files) staying green unmodified. Still worth a second look in review given the size of the diff's context.
- **No live LiteLLM/z.ai verification** — same posture as sub-projects 1 and 2. The `429`/`BudgetExceededError` shape this test scripts is sub-project 2's documented, but not live-confirmed, understanding of LiteLLM's real behavior.

## Package/file summary

- **Changed:** `packages/contracts/src/stage.ts` (+test), `packages/activities/src/create-activities.ts`, `packages/workflows/src/dev-cycle.ts`, `e2e/helpers.ts`.
- **New:** `e2e/litellm-routing-and-budget.e2e.test.ts`.

## Open questions carried forward

- None new — sub-project 4 (subscription rate-window awareness) remains fully orthogonal and unaffected by this doc's changes.
