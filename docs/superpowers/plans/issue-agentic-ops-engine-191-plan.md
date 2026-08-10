# Plan — Task issue-agentic-ops-engine-191

Goal: eliminate the unhandled promise rejection produced when `dev-cycle.ts`
fires `landingChild.signal(...)` from inside the synchronous `cancel`/`resume`
signal handlers via the fire-and-forget `void` operator.

Design: `docs/superpowers/specs/issue-agentic-ops-engine-191-design.md`
(Approach 1 — a small synchronous `forwardToLandingChild` helper that fires the
child signal and attaches a `.catch` that logs and swallows the rejection).

Scope is confined to `packages/workflows/src/dev-cycle.ts` plus its test.

## Steps

### Step 1 — Add the `forwardToLandingChild` helper and route both call sites through it

File: `packages/workflows/src/dev-cycle.ts`

- Add `log` to the existing `@temporalio/workflow` import list (lines 2–11).
  `platform.ts` already imports `log` from the same module, so this is an
  established, determinism-safe pattern (the workflow logger is a proxied sink,
  not I/O in the workflow body).
- Immediately after `landingChild` is declared (currently line 98–100) and
  before the `setHandler` calls, define a synchronous local helper:
  - `const forwardToLandingChild = (signalName: typeof prLandingCancelSignal | typeof prLandingResumeSignal): void => { ... }`
  - Read the current `landingChild` into a local const; if it is `null`, return
    immediately (nothing to forward — the child hasn't started yet).
  - Otherwise call `child.signal(signalName)` and attach
    `.catch((error) => log.warn('failed to forward signal to prLanding child', { signalName, error }))`.
  - The helper returns `void`; because the rejection is handled *inside* the
    helper, callers invoke it plainly — no `void` operator, no floating promise,
    so `no-floating-promises` is satisfied without a suppression.
- Replace `void landingChild?.signal(prLandingCancelSignal);` (line 111) with
  `forwardToLandingChild(prLandingCancelSignal);`.
- Replace `void landingChild?.signal(prLandingResumeSignal);` (line 130) with
  `forwardToLandingChild(prLandingResumeSignal);`.

Rationale for reading `landingChild` fresh inside the helper (rather than
capturing it): the handlers can fire at any time, and `landingChild` is `null`
until the landing branch assigns it (line 420). Reading it at call time
preserves the exact current semantics of `landingChild?.signal(...)` (no-op
while null, forward once assigned).

Verification:
- `pnpm --filter @agentops/workflows typecheck` — the helper's parameter type
  matches the existing `signal` signature on the `landingChild` shape (line 99),
  so this compiles with no `any`.
- `pnpm --filter @agentops/workflows lint` — confirms `no-floating-promises`
  passes with the `void` operators removed and no new suppression added.
- Manual read-through: both former `void` sites now call the helper; happy path
  (child present, signal resolves) is behaviourally identical.

### Step 2 — Extend the workflow test double so the new code path is exercisable

File: `packages/workflows/src/dev-cycle.test.ts`

`dev-cycle.ts` now imports `log`, and the regression test in Step 3 needs to
(a) not crash on the missing `log` export and (b) actually invoke the captured
signal handler with a distinguishable signal identity. Two mock changes:

- Add `log` to the `vi.mock('@temporalio/workflow', ...)` factory (currently
  lines 77–110):
  `log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }`.
  Without this, `log.warn` in the helper's `.catch` would be `undefined` and
  throw. Declare the `log` mock in the existing `vi.hoisted(...)` block (lines
  4–75) so Step 3 can assert on `log.warn`.
- Give each signal a distinct identity so a specific handler can be captured:
  change `defineSignal: vi.fn(() => 'signal')` (line 101) to
  `defineSignal: vi.fn((name: string) => name)`. `dev-cycle.ts` calls
  `defineSignal('cancel')` / `defineSignal('resume')`, so the handlers become
  addressable by name. This is safe: no existing test relies on `defineSignal`
  returning the literal `'signal'`.
- Change `setHandler: vi.fn()` (line 102) to a mock that records handlers keyed
  by their signal token, e.g. a hoisted `Map` populated by
  `setHandler: vi.fn((sig, handler) => { handlers.set(sig, handler); })`, and
  expose the map to tests. Existing tests don't invoke handlers, so recording
  them is a no-op for them.

Verification:
- `pnpm --filter @agentops/workflows test` — the five existing
  `agent:working` / PR-title / handoff tests still pass unchanged (the mock
  additions are purely additive: `log` is new, and the `defineSignal`/
  `setHandler` changes don't alter any behaviour those tests observe).

### Step 3 — Add the regression test: a rejecting child signal must not escape

File: `packages/workflows/src/dev-cycle.test.ts`

Add a `describe('devCycle child-signal forwarding')` block (patched branch, so
set `patched` → `true` and provide a `startChild` handle as the existing
handoff block does). Two cases:

1. **Cancel forwarded to an already-closed child does not reject.**
   - Arrange `startChild` to return a handle whose `signal` is
     `vi.fn().mockRejectedValue(new Error('child already completed'))` and whose
     `result()` resolves to `{ outcome: 'merged' }` only after a test-controlled
     deferred promise settles (so the workflow parks on `await handle.result()`
     with `landingChild` assigned).
   - Register a `process.on('unhandledRejection', ...)` spy for the duration of
     the test (removed in a `finally`).
   - Start `devCycle(...)` without awaiting; `await` a microtask flush (e.g.
     `await Promise.resolve()` / a small tick) so the landing branch runs to the
     point where `landingChild` is set.
   - Retrieve the captured `cancel` handler from the mock's handler map and
     invoke it. This drives `forwardToLandingChild(prLandingCancelSignal)` →
     rejecting `child.signal` → the helper's `.catch`.
   - Resolve the deferred so `result()` settles; `await` the `devCycle` promise.
   - Assert: the workflow promise resolves (no throw); the `unhandledRejection`
     spy was never called; `log.warn` was called once with the signal name.
2. **Resume forwarded to an already-closed child does not reject.** Same shape,
   invoking the captured `resume` handler and asserting the same three
   properties. (Kept as a distinct case so a regression in only one call site is
   caught.)

Verification:
- `pnpm --filter @agentops/workflows test` — both new cases pass. To confirm the
  test is a genuine guard, temporarily reverting Step 1's helper back to
  `void landingChild?.signal(...)` should make the `unhandledRejection` /
  `log.warn` assertions fail (verified locally, then reverted).

### Step 4 — Full gate + e2e

- `pnpm lint && pnpm typecheck && pnpm test` at the repo root — the full
  Definition-of-Done gate (AGENTS.md hard rule #6).
- `pnpm e2e` — required because the change touches `packages/workflows`
  (AGENTS.md hard rule #6). Expected to be unaffected: the happy path is
  behaviourally identical and no e2e exercises a rejecting child signal.

## Sequencing notes

- **Step 1 before Steps 2–3.** The source fix is the de-risking step: it is the
  actual bug fix and is independently verifiable by `lint`/`typecheck`
  (no-floating-promises satisfied) before any test scaffolding exists. Landing
  it first means a lint/typecheck failure surfaces against the smallest possible
  diff.
- **Step 2 before Step 3.** Step 3's regression test cannot run until the mock
  exposes `log` and lets a specific signal handler be captured and invoked; that
  infrastructure is Step 2. Splitting them keeps the "make the harness capable"
  change separate from the "assert the behaviour" change, so a failure in either
  is unambiguous.
- **Could Step 1 and the test steps be reordered (test-first)?** Yes, but
  writing the failing test first would require the Step 2 mock changes anyway,
  and the fix here is a one-helper change whose correctness is best demonstrated
  by the before/after in Step 3's verification note. I kept fix-first so the
  lint/typecheck signal (the primary evidence the floating promise is gone) is
  available immediately.

## Assumptions

- **Swallowing any child-signal rejection is correct, not just a specific error
  class.** Per the design, the only realistic rejection is the child having
  already completed/closed in the human-signal race window, where there is
  nothing left to cancel/resume. The helper swallows *any* rejection but records
  it via `log.warn`, so a genuinely unexpected failure stays observable in
  worker logs without failing the workflow task. I did not pattern-match a
  Temporal error class (brittle across SDK versions).
- **Reading `landingChild` at call time (inside the helper) rather than
  capturing it preserves current semantics.** The former `landingChild?.signal`
  was itself a call-time read; the helper keeps that exact timing (no-op while
  null, forward once assigned at line 420).
- **The regression test can drive the handler via the mocked `setHandler`.** In
  unit tests the real Temporal handler-dispatch machinery is mocked, so the test
  captures the handler callback from the `setHandler` mock and calls it directly.
  This exercises the exact helper code path (`forwardToLandingChild` +
  rejecting `child.signal` + `.catch`) without a live Temporal test environment.
  The `e2e` suite (Step 4) covers the real dispatch path.
- **`log` on the mock needs only `warn` for assertions**, but I include
  `error`/`info`/`debug` stubs too so any future logger use in this file doesn't
  break the mock.
- **No SLDS / README change.** This is a correctness fix to signal forwarding
  and does not alter the development lifecycle, stages, statuses, or the
  cancel/resume escape-hatch semantics, so no SLDS section update is required
  (consistent with the design's assumption).
