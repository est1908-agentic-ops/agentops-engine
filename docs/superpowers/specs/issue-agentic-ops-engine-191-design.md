# Design — Task issue-agentic-ops-engine-191

## Goal

`dev-cycle.ts` fires signals at its `prLanding` child workflow from inside two
**synchronous** signal handlers using the fire-and-forget `void` operator:

```ts
setHandler(cancelSignal, () => {
  cancelled = true;
  void landingChild?.signal(prLandingCancelSignal);   // line 111
});
setHandler(resumeSignal, () => {
  ...
  void landingChild?.signal(prLandingResumeSignal);   // line 130
});
```

`ChildWorkflowHandle.signal()` returns a `Promise`. `void` suppresses the
`no-floating-promises` lint but leaves the promise's **rejection path
unhandled**. If the signal rejects — most plausibly because the child has
already completed/closed in the race window between "human sends signal" and
"handler runs" — the rejection becomes an unhandled promise rejection inside the
workflow sandbox, which can fail the workflow task and put the run into a
retry/stuck state. Goal: make forwarding these signals to the child robust so a
benign already-closed child (or any signal failure) can never produce an
unhandled rejection, while preserving current cancel/resume behavior.

## Approaches considered

1. **Attach a rejection handler to the fired promise (minimal).** Keep the
   handlers synchronous, but route both call sites through a small helper that
   fires the child signal and attaches a `.catch(...)` which swallows the
   benign already-closed case (logging it via the workflow logger for
   observability). Trade-off: the promise is still not tracked by Temporal's
   handler lifecycle, so delivery relies on the parent staying alive — but the
   parent already blocks on `await handle.result()` for the child's whole life,
   so delivery is already guaranteed in practice. Cost: tiny, ~1 file.

2. **Async signal handlers + `allHandlersFinished` gate (idiomatic).** Convert
   both handlers to `async`, `await` the child signal inside a try/catch, and
   gate every workflow `return` behind `await condition(allHandlersFinished)`.
   Trade-off: `allHandlersFinished` only tracks async signal/update handler
   executions, so this is the "textbook" way to guarantee flush + no floating
   promise. But async handlers can interleave relative to the synchronous state
   flags (`cancelled`, `stopRequested`, `effectiveBrakes`) the rest of the
   workflow reads, and every one of the several `return state` paths would need
   the new gate — a wider blast radius and a real risk of subtle ordering
   changes. Cost: medium, higher regression risk.

3. **Flag-only handlers + forward from the main coroutine.** Handlers only set
   intent flags; a concurrent watcher in the main body forwards to the child.
   Trade-off: the main body is currently blocked on `await handle.result()`, so
   this requires racing a `condition()` watcher against `result()` and
   restructuring the landing branch. Cleanest separation of "pure handler" vs
   "I/O in main", but by far the largest change for a one-line bug. Cost: high,
   most restructuring.

## Chosen approach

**Approach 1.** It fixes the actual defect — the unhandled rejection — at both
call sites with a single, well-commented helper and no change to control flow,
determinism, or the several return paths.

- Approach 2 is rejected as over-engineering for this bug: the flush guarantee
  it adds is already provided by the existing `await handle.result()` (the
  parent cannot return while the child is alive, and the child only completes
  after processing the forwarded cancel/resume), so the async-handler machinery
  buys nothing here while widening the blast radius across every `return`.
- Approach 3 is rejected for the same cost/benefit reason plus the additional
  restructuring of the landing branch it demands.

## Assumptions

- **Which signal failures are "benign".** I assume the only realistic
  rejection is the child already being completed/closed by the time the human
  signal lands (a race), and that swallowing it is correct: there is nothing
  left to cancel or resume. Rather than pattern-match a specific Temporal error
  class (which risks being brittle across SDK versions), the helper swallows any
  rejection but records it via the workflow logger (`log.warn`) so genuinely
  unexpected failures remain observable in worker logs without failing the task.
- **Scope is `dev-cycle.ts` only.** A grep shows `void landingChild?.signal(...)`
  is the only floating-promise-from-child-signal pattern in the workflows
  package. `pr-landing.ts` and the other `setHandler` sites only mutate local
  flags and perform no async work, so they are out of scope.
- **No SLDS impact.** This is a correctness fix to signal forwarding; it does
  not change the development lifecycle, stages, statuses, or the cancel/resume
  escape-hatch semantics described in the README's SLDS section, so no SLDS
  update is required.

## Design

Single coherent change, confined to `packages/workflows/src/dev-cycle.ts` plus a
test.

**`packages/workflows/src/dev-cycle.ts`**
- Add `log` to the existing `@temporalio/workflow` import (already imported by
  `platform.ts`, so the pattern is established).
- Introduce one local helper, defined after `landingChild` is declared and
  before the handlers, e.g.:
  - `forwardToLandingChild(signalName)` — reads the current `landingChild`,
    returns immediately if null, otherwise calls `child.signal(signalName)` and
    attaches a `.catch` that logs a warning and swallows the error. The helper
    returns `void`, so the handlers stay synchronous and call it plainly (no
    `void` operator, no floating promise — the rejection is handled inside).
- Replace the two `void landingChild?.signal(...)` lines (111, 130) with calls
  to the helper. Behavior on the success path is identical; the only difference
  is that a rejecting signal is now caught and logged instead of escaping.

**Data flow / error handling.** Unchanged happy path: cancel sets `cancelled`
and forwards cancel to the child; resume adjusts `effectiveBrakes`/`state` and
forwards resume. The parent continues to `await handle.result()`, so the
forwarded signal is delivered before the parent can return. New behavior only on
the rejection path: the caught error is logged and dropped, so no unhandled
rejection reaches the sandbox.

**Testing (`packages/workflows/src/dev-cycle.test.ts`).**
- Existing tests mock the child `signal` as `mockResolvedValue(undefined)` and
  keep passing unchanged.
- Add a case where the child `signal` is mocked to **reject** (simulating an
  already-completed child) when cancel/resume is delivered, asserting the
  workflow still resolves to its expected terminal `state` and that no unhandled
  rejection is produced. This is the regression guard for the bug.

**Verification.** `pnpm lint && pnpm typecheck && pnpm test` in the workflows
package; `no-floating-promises` stays satisfied without a `void` suppression.
The e2e suite applies (workflows change) and should be run.

## Brainstorm Summary
**Approaches considered:** (1) route both child-signal calls through a helper that attaches a `.catch` and keep handlers synchronous; (2) convert handlers to async and gate every return on `allHandlersFinished`; (3) make handlers flag-only and forward to the child from a concurrent watcher in the main body.
**Chosen approach:** (1) — a small `forwardToLandingChild` helper that fires the child signal and handles its rejection, replacing the two `void landingChild?.signal(...)` lines in `dev-cycle.ts`.
**Why (decisive reasons):** It fixes the real defect (unhandled rejection when signalling an already-closed child) with no control-flow or determinism change. The flush guarantee that approach 2 adds is already provided by the existing `await handle.result()`, so async handlers + `allHandlersFinished` would only widen the blast radius across every return path; approach 3 needs disproportionate restructuring for a one-line bug.
**Key risks/assumptions:** Assumes swallowing (with a `log.warn`) any signal rejection is correct because the only realistic cause is an already-completed child; scope is `dev-cycle.ts` only (other handlers do no async work); no SLDS impact.
