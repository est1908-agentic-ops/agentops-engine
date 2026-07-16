# Plan — [bughunt] prLanding babysit loop ignores cancel signal in steady state

Task: `issue-agentic-ops-engine-128`
Date: 2026-07-16
Design: `docs/superpowers/specs/issue-agentic-ops-engine-128-design.md` (Approach A)

## Summary

Two coordinated edits inside `babysitAndMerge` in `packages/workflows/src/pr-landing.ts`
plus one regression test in `packages/workflows/src/pr-landing.test.ts`. No contract
change, no `packages/policies` change. `outcome = 'cancelled'` already exists in the
`PrLandingState` schema (`packages/contracts/src/pr-landing.ts:50`).

## Steps

### Step 1 — Fix the steady-state cancel handling in `babysitAndMerge`

File: `packages/workflows/src/pr-landing.ts` (function `babysitAndMerge`, currently
lines 256-388).

Two changes, both at the top of the `while (true)` body:

1. Widen the steady-state poll predicate (line 264) so a cancel wakes the loop
   immediately instead of waiting out the 5s poll timeout:
   - from `await condition(() => woke, DEFAULT_BABYSIT_POLL_MS);`
   - to   `await condition(() => woke || cancelled, DEFAULT_BABYSIT_POLL_MS);`

2. Immediately after that wait, before the `getPrSnapshot` call (currently line 265),
   add a loop-top cancel check using the file's existing return-state idiom (identical
   teardown to `waitAtBrake`, lines 120-124):
   ```ts
   if (cancelled) {
     state.phase = 'done';
     state.outcome = 'cancelled';
     return state;
   }
   ```

No other lines in the function change. Because the check sits at the top of the loop
body — above the `merge_ready`, `braked`, `actionable`, and fall-through `waiting`
branches, all of which either `return`, `continue`, or fall through to the loop top —
every branch is covered by this single check. The `maxBabysitWaits = MAX_SAFE_INTEGER`
resume path (line 347) can no longer prevent termination on cancel.

Verification:
- `pnpm typecheck` (compiles; `cancelled` and `state` are already in scope).
- `pnpm lint`.
- Reasoning check: the diff is exactly the predicate widening + a 4-line guard; the three
  `waitAtBrake` calls, the budget-path `PrLandingCancelledError` handling, the resume
  handler, and the top-level `try/catch/finally` (including `cleanupWorkspace`) are
  byte-for-byte unchanged.
- Full behavioral proof comes from Step 2's new test plus the existing prLanding tests
  staying green (Step 3).

### Step 2 — Add a regression test for steady-state cancel

File: `packages/workflows/src/pr-landing.test.ts`.

The current mock setup needs two small adjustments so the test can deliver a cancel and
let the loop observe it:

1. Make signal/query handlers capturable. Today `defineSignal`/`defineQuery` both return
   the constant string `'signal'`/`'stateQuery'`, and `setHandler` is a bare `vi.fn()`,
   so cancel/wake/resume handlers are indistinguishable. Change the mock so
   `defineSignal` returns its `name` argument (`vi.fn((name: string) => name)`) and
   `setHandler` records handlers into a module-level map keyed by that token
   (e.g. `handlers[token] = fn`). Expose the map (via the `vi.hoisted` block, like the
   other mocks) so tests can call `handlers['cancel']()`. Existing tests are unaffected
   because none of them inspect handlers, and `setHandler` remains a spy.

2. Add one test: **"honors cancel during steady-state babysit polling"**.
   - Arrange a steady `'waiting'` snapshot: `getPrSnapshot` returns
     `greenSnapshot({ ciStatus: 'pending', unresolvedThreads: 0, comments: [] })` with
     `headSha: 'abc'`. Per `babysitDecision`, pending + no unresolved threads + no
     actionable comments yields `'waiting'`.
   - Enter the babysit loop without a prior merge/validate detour by passing
     `workspace: { workspaceRef: '/ws/t', branch: 'agentops/t', validatedHeadSha: 'abc' }`
     so `land()` skips `validateHead` (validatedHeadSha === headSha) and calls
     `babysitAndMerge` directly.
   - Override the `condition` mock for this test so that on its first invocation it calls
     the captured cancel handler (`handlers['cancel']()`, setting `cancelled = true`) and
     then resolves. The loop-top check added in Step 1 then fires on the next line.
   - Assert: `result.outcome === 'cancelled'`, `result.phase === 'done'`, and
     `cleanupWorkspace` was called exactly once.
   - Guard against regression of the "polls forever" symptom: assert `getPrSnapshot` was
     NOT called after cancel (i.e. the loop returned at the top rather than fetching a
     fresh snapshot and looping). Concretely, with cancel delivered inside the first
     `condition` call, `getPrSnapshot` should be called 0 times inside the loop; assert a
     small bounded call count so a re-introduced bug (loop keeps polling) fails the test.

Verification:
- `pnpm test packages/workflows/src/pr-landing.test.ts` — the new test passes; assert it
  FAILS against the pre-Step-1 code first (temporarily stash Step 1) to prove it is a
  real regression guard, then restore Step 1.
- The test must terminate (not hang), proving the loop exits on cancel rather than
  polling indefinitely.

### Step 3 — Full local gate

Run the repo's definition-of-done gate.

Verification:
- `pnpm lint && pnpm typecheck && pnpm test` — all green; existing prLanding tests
  (merge / merge-ready-manual / external-merge / forbidden-block) unchanged, proving the
  merge/repair/brake paths are unaffected.
- `pnpm e2e` — required because the change touches a workflow (AGENTS.md hard rule 6).

## Sequencing notes

- **Step 1 (source fix) before Step 2 (test)** even though TDD would suggest the reverse:
  the design is already settled and the fix is 4 lines, so writing the test against a
  known-good implementation is lower-friction here. To preserve the regression-guard
  value, Step 2's verification explicitly requires confirming the new test fails when
  Step 1 is reverted — recovering the TDD guarantee without reordering.
- **Test-mock plumbing (Step 2.1) is bundled into Step 2, not split out**, because the
  handler-capture change has no purpose or verification on its own; it is only meaningful
  in service of the new test and is verified by that test running.
- **Step 3 (full gate incl. e2e) last** — it is the aggregate confirmation and only makes
  sense once source + test are in place.

## Assumptions

- **Cancel outcome is `'cancelled'`, not `'failed'`.** Matches prLanding's own
  `waitAtBrake` idiom (pr-landing.ts:120-124); confirmed present in the contract
  (`packages/contracts/src/pr-landing.ts:50`). #120's `devCyclePrRepair` used `'failed'`,
  but that is a different state machine.
- **The reproducible steady state is `babysitDecision === 'waiting'`.** Verified against
  `packages/policies/src/babysit-decision.ts`: `ciStatus: 'pending'`,
  `unresolvedThreads: 0`, empty `comments` returns `'waiting'` (not merge_ready, not
  unreadable, rounds < cap, not actionable, waitingRounds < max).
- **A single loop-top check suffices.** All four decision branches return, continue, or
  fall through to the loop top, so no branch can re-loop without passing the check.
- **The existing test mock is the right harness.** The test drives `prLanding` with mocked
  `@temporalio/workflow` (no real Temporal runtime); the only new mock capability is
  capturing the cancel handler and distinguishing signals by name — a minimal, localized
  change that leaves existing tests green.
- **No new cancel plumbing.** The `cancel` signal already reaches prLanding and sets
  `cancelled` (pr-landing.ts:91-93); only the babysit loop's reading of the flag is fixed.

## Self-review

- Every step has a concrete verification method (typecheck/lint, a named test file with a
  fail-first check, and the full lint+typecheck+test+e2e gate).
- Step 2 legitimately contains mock-plumbing + a test, but they are one coherent unit (the
  plumbing has no standalone verification), so it is not two steps in disguise.
- Scope is one bug in one function plus its regression test; no unrelated work bundled.
