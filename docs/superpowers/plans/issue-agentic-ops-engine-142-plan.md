# Plan — issue-agentic-ops-engine-142

**Title:** [bughunt] `prLanding` babysit/repair loops ignore cancel signal outside brake checkpoints

Implements **Approach A** from `docs/superpowers/specs/issue-agentic-ops-engine-142-design.md`:
make the two long-running loops (and the stage-agent retry loop nested in them) observe the
`cancelled` flag at their natural checkpoints, reusing the existing
`PrLandingCancelledError` → top-level `catch` → `cleanupWorkspace` teardown. No contract, signal,
handler, state-shape, or activity changes.

All production changes are in a single file: `packages/workflows/src/pr-landing.ts`. Regression
tests go in `packages/workflows/src/pr-landing.test.ts`.

## Steps

### Step 1 — Write the failing regression tests first (`packages/workflows/src/pr-landing.test.ts`)

De-risks the whole task: these tests define "cancel is honored inside the loops" precisely and
confirm the current code fails (hangs / never returns `'cancelled'`) before I touch production
code. Writing them first also forces me to validate the test-harness plumbing (capturing the
cancel handler) before depending on it in Step 2's verification.

Test-harness plumbing to add:

- **Capture the cancel signal handler.** Today the mock is `defineSignal: vi.fn(() => 'signal')`
  (returns the same token for every signal) and `setHandler: vi.fn()` (a no-op), so no handler is
  reachable from tests. Change the `defineSignal` mock to return the signal name it is given
  (`defineSignal: vi.fn((name: string) => name)`) so `defineSignal('cancel')` → `'cancel'`. Change
  the `setHandler` mock to record handlers by their token into a module-scoped map
  (e.g. `setHandler: vi.fn((token, fn) => { handlers[token] = fn; })`), exposed via `vi.hoisted`.
  Tests then call `handlers.cancel()` to fire the cancel signal. Add a `beforeEach` reset of the
  handler map. (Registration-order capture is the fallback if keying by name proves awkward, but
  name-keying is clearer — cancel is `defineSignal('cancel')` at line 39.)
  - Rationale for name-keying over order: robust to future signal reordering; the existing
    green-path tests don't inspect handlers, so returning the name instead of `'signal'` is inert
    for them (verified by re-running the existing suite in Step 3).

- **Test A — babysit-loop cancel.**
  - Input: adopt a workspace so `land()` skips `validateHead`
    (`workspace: { workspaceRef, branch, validatedHeadSha: 'abc' }` with a snapshot `headSha: 'abc'`),
    driving execution straight into `babysitAndMerge`.
  - `getPrSnapshot` returns a snapshot with `ciStatus: 'pending'`, `unresolvedThreads: 0`,
    `comments: []`, `labels: []` so `babysitDecision` returns `'waiting'` and the loop parks on the
    poll `condition`.
  - Override the `condition` mock so that when called **with a timeout** (the babysit poll,
    `DEFAULT_BABYSIT_POLL_MS`) it invokes `handlers.cancel()` then resolves — simulating a cancel
    arriving during the poll wait. (Calls without a timeout keep resolving immediately.)
  - Assertions: `prLanding(...)` **resolves** (does not hang) with `outcome: 'cancelled'` and
    `phase: 'done'`; `cleanupWorkspace` called exactly once; `mergePr` **not** called.
  - Guard against a false pass from an accidental hang: rely on vitest's per-test timeout; a
    pre-fix run must time out / fail, a post-fix run must pass quickly.

- **Test B — repair-loop cancel.**
  - Input: a non-adopted (prepared) workspace or a validatedHeadSha mismatch so `land()` enters
    `validateHead`; snapshot green enough to reach the agent stages.
  - Make `runAgent` return a failing `full_verify` verdict (`'FULL: FAIL'`) so `nextRepairAction`
    returns `continue` and the repair loop iterates (brakes in `baseConfig` are generous:
    `maxImplementAttempts: 3`, `maxIterations: 10`). To fire cancel at an iteration boundary, have
    the `runAgent` mock call `handlers.cancel()` on the `implement`-stage call (which runs near the
    end of the first repair iteration, before `pushBranch` / the next loop head). The next
    iteration's loop-head check then throws.
  - Assertions: `prLanding(...)` resolves with `outcome: 'cancelled'`, `phase: 'done'`;
    `cleanupWorkspace` called once; the loop did not run unbounded (e.g. `runAgent` implement-stage
    calls bounded to 1, and `mergePr` not called).

- **Verification:** `pnpm --filter @agentops/workflows test -- pr-landing` (or repo-root
  `pnpm test`). Confirm Test A and Test B **fail against current code** (hang/timeout or wrong
  outcome). This is the step's pass condition: the tests must be red before Step 2.

### Step 2 — Add the three cancel checkpoints (`packages/workflows/src/pr-landing.ts`)

Three edits, each a pure boolean check throwing the existing `PrLandingCancelledError` — no
reordering of any activity or timer call, so determinism/replay is preserved.

1. **Babysit poll (loop at line 261, wait at line 264).** Change
   `await condition(() => woke, DEFAULT_BABYSIT_POLL_MS)` to
   `await condition(() => woke || cancelled, DEFAULT_BABYSIT_POLL_MS)`, and immediately after it add:
   ```ts
   if (cancelled) throw new PrLandingCancelledError();
   ```
   Because `cancelled` latches, this single post-poll check catches both a cancel arriving during
   the poll (predicate wakes the wait immediately) and one that arrived during the previous
   iteration's post-poll work (next poll resolves instantly, then throws).

2. **Repair loop head (`validateHead`, `while (true)` at line 200).** Add at the very top of the
   loop body (before `state.phase = 'validating'`):
   ```ts
   if (cancelled) throw new PrLandingCancelledError();
   ```
   Stops the loop between verify/review/implement/push cycles instead of running another full
   iteration.

3. **Stage-agent retry head (`runStageAgent`, `while (true)` at line 141).** Add at the top of the
   retry loop body (before the `try`):
   ```ts
   if (cancelled) throw new PrLandingCancelledError();
   ```
   Honors a cancel that arrived while a prior agent call was running, before dispatching the next
   agent call.

No other edits: the top-level `catch (err instanceof PrLandingCancelledError)` (lines 428–432)
already sets `phase: 'done'`, `outcome: 'cancelled'`, and the `finally` (line 437) already calls
`cleanupWorkspace` — identical to the existing budget-exceeded checkpoint at line 165.

- **Verification:** `pnpm --filter @agentops/workflows test -- pr-landing` — Test A and Test B now
  pass; all pre-existing `prLanding` tests (adopt/cleanup, external-workspace verify+merge,
  automerge:disable manual, externally-merged, forbidden-blocked) stay green.

### Step 3 — Full gate + regression sweep

Run the repo's definition-of-done gate to confirm nothing else regressed and the harness change to
the test mocks (Step 1) didn't disturb other suites.

- **Verification:**
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test` (whole suite — includes `packages/contracts` pr-landing schema tests and
    `packages/policies` tests, which must remain green and are untouched by this change).
  - `pnpm e2e` — required by AGENTS.md rule 6 for changes touching `packages/workflows`. Run it;
    if the environment cannot run e2e (no Temporal test server available in this unattended
    sandbox), record that under Assumptions and rely on the workflow unit tests plus lint/typecheck
    as the gate.

## Sequencing notes

- **Tests before the fix (Step 1 before Step 2), deliberately.** The task is a behavioral bug in a
  cooperative-cancel protocol; a red-then-green test is the only way to prove the loops actually
  ignored cancel before and honor it after. Writing tests first also surfaces the handler-capture
  plumbing risk early — if `defineSignal`/`setHandler` can't be made to expose the cancel handler,
  I learn it before editing production code, not after.
- **The three production edits are one step, not three.** They are the same one-line idiom applied
  at three loop checkpoints in the same file and are verified by the same test run; splitting them
  would create steps whose individual verification is just "part of the suite passes." They share a
  single logical change ("loops observe `cancelled`") and land together.
- **Full gate last (Step 3).** The `lint`/`typecheck`/`e2e` sweep only makes sense once the source
  and tests are final; running it earlier would just re-run on stale code.
- **Could Step 1's harness change and Step 2 be swapped?** No — the harness change (capturing the
  cancel handler) is a prerequisite for Test A/B to fire cancel at all, so it must precede the fix
  it verifies.

## Assumptions

- **Cancel terminates as `outcome: 'cancelled'`, not `failed` or a new status.** Follows the file's
  own existing cancel convention (`waitAtBrake` and the budget checkpoint already produce
  `'cancelled'`); introduces no new `PrLandingState` vocabulary (AGENTS.md fixed-vocabulary rule).
- **Cooperative checkpoints suffice; no mid-activity preemption.** Cancel is honored at loop/poll
  boundaries (latency ≤ one iteration, ≤ ~5s on the babysit poll), matching the repo-wide idiom and
  the issue framing ("outside brake checkpoints" = the loop bodies). Approach B
  (`CancellationScope`) is explicitly out of scope.
- **A single latched post-poll check covers both "cancel during poll" and "cancel during prior
  iteration"** in `babysitAndMerge` — no separate top-of-loop guard is needed there because the poll
  predicate includes `cancelled` and the flag latches. The repair and stage-agent loops have no
  poll, so each gets an explicit head-of-loop check.
- **`getPrSnapshot` labeled `pending` (no threads/comments) yields `babysitDecision === 'waiting'`**,
  the state that parks the babysit loop on the poll for Test A. (Not green → not `merge_ready`;
  readable/under caps → not `braked`; no failure/threads → not `actionable`; falls through to
  `waiting`.)
- **Name-keyed handler capture is safe for the existing tests.** Changing the `defineSignal` mock to
  return the signal name (instead of the constant `'signal'`) and recording handlers in `setHandler`
  is inert for the current green-path tests, which never inspect handlers — verified by the Step 3
  sweep. If name-keying proves awkward, fall back to capturing by `setHandler` registration order
  (cancel is registered first, at line 91).
- **e2e may be unrunnable in this unattended sandbox.** If `pnpm e2e` cannot start its Temporal test
  environment here, the change is still fully exercised by the workflow unit tests (which mock the
  Temporal SDK) plus lint/typecheck; I will note the skip explicitly rather than claim e2e passed.

## Self-review

- Every step names a concrete verification command (`pnpm test` filtered / full, `lint`,
  `typecheck`, `e2e`) with an explicit pass condition.
- Step 1 is genuinely one step (tests + the harness plumbing they require); Step 2 is one logical
  change applied at three checkpoints; Step 3 is the gate. No step hides a second unrelated step.
- Scope matches the design: three cancel checkpoints in `pr-landing.ts` + regression tests; no
  contract/signal/state changes; preemptive cancellation deferred.
