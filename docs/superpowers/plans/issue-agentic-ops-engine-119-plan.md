# Plan — issue-agentic-ops-engine-119

Turns the design (`docs/superpowers/specs/issue-agentic-ops-engine-119-design.md`, Approach A)
into an ordered implementation plan. Two defects in
`packages/workflows/src/dev-cycle-pr-repair.ts`:

1. The `pr_babysit` loop discards `babysitDecision`'s `'braked'` verdict (treats it as
   `'waiting'`), so `ciStatus === 'unreadable'` and the babysit-round cap never block for a
   human — the workflow polls forever.
2. `stopSignal` sets `_stopRequested`, which is never read — the documented `stop` operator
   control is dead.

Both are fixed by aligning the babysit loop and signal handling with the already-correct,
spec-blessed `packages/workflows/src/dev-cycle.ts`. No `contracts` or `policies` change: the
pure `babysitDecision` policy already computes `'braked'` correctly; only the caller ignores it.
`pending`, `blocked`, and `babysit-brake` are already in the fixed vocabulary
(`TaskStatusSchema` / `BlockReasonSchema` in `packages/contracts/src/stage.ts`).

## Steps

### Step 1 — Wire `stopRequested` and lift the babysit round cap on resume (signal plumbing)

File: `packages/workflows/src/dev-cycle-pr-repair.ts`

- Rename the local `_stopRequested` → `stopRequested` (line 62); the `setHandler(stopSignal, …)`
  (line 65) keeps setting it — it is now read (Step 3).
- Extend the `resumeSignal` handler (lines 67–70) to mirror `dev-cycle.ts` (lines 113–125): when
  `state.blockReason === 'babysit-brake'`, lift the round cap
  (`effectiveBrakes = { ...effectiveBrakes, maxBabysitRounds: Number.MAX_SAFE_INTEGER }`) before
  setting `state.status = 'running'` / `state.blockReason = null`. This is required so a `resume`
  after a round-cap brake does not immediately re-brake on the next poll (see Assumptions —
  design gap). `effectiveBrakes` is already a mutable `let` in scope.

Why first: it de-risks the rest. `stopRequested` and the resume escape-hatch are the mechanisms
Steps 2–3 depend on; getting the identifier rename and handler shape right up front means the
loop edits in Steps 2–3 compile against their final form. No behavior is observable yet on its
own.

Verify: `pnpm --filter @agentops/workflows typecheck` — passes with no unused-variable error for
`stopRequested` once Step 3 reads it (run the typecheck after Step 3; this step is not
independently green because the renamed variable is not yet read). Manual: re-read the handler
against `dev-cycle.ts` lines 113–125 for parity.

### Step 2 — Act on the `'braked'` verdict in the babysit loop

File: `packages/workflows/src/dev-cycle-pr-repair.ts`

- Promote the no-progress cap to a mutable local so resume can lift it: replace the bare
  `let waiting = 0;` (line 209) region with `let waiting = 0;` **and** `let maxBabysitWaits =
  MAX_BABYSIT_WAITS;` (mirrors `dev-cycle.ts` lines 411–415).
- In the `babysitDecision(...)` call (line 215), pass `maxBabysitWaits` instead of the constant
  `MAX_BABYSIT_WAITS` as the 6th argument, so the resume escape-hatch actually takes effect.
- After the `if (decision === 'merge_ready') break;` (line 217) and before the `actionable`
  branch, add an explicit braked branch mirroring `dev-cycle.ts` lines 433–450:
  ```ts
  if (decision === 'braked') {
    state.status = 'blocked';
    state.blockReason = 'babysit-brake';
    if (await waitForResumeOrCancel()) {
      throw new RepairCancelledError();   // cancel → top-level catch → failed + cleanupWorkspace
    }
    maxBabysitWaits = Number.MAX_SAFE_INTEGER; // resumed: stop auto-braking on no-progress
    waiting = 0;                                // (round cap lifted by resumeSignal, Step 1)
    state.stage = 'pr_babysit';
    continue;
  }
  ```
  Note: `dev-cycle.ts` handles cancel inline (sets failed + `cleanupWorkspace` + returns);
  `dev-cycle-pr-repair.ts` already funnels cancel through `RepairCancelledError` → the top-level
  `catch` (lines 253–259) which does exactly failed + `cleanupWorkspace`. Throwing keeps the
  existing single cancel path (consistent with the budget-exceeded block at line 113) rather than
  duplicating cleanup inline.
- Replace the fall-through brake block (lines 239–245):
  ```ts
  waiting += 1;
  if (waiting >= MAX_BABYSIT_WAITS) { … }
  ```
  with a plain `waiting += 1;` (the `'waiting'` decision path). The manual threshold check is now
  owned by the policy via the `'braked'` branch, so the duplicate is deleted.

Verify:
- `pnpm --filter @agentops/workflows typecheck`.
- New unit behavior covered in Step 4 (braked-on-`unreadable` blocks; round-cap braked + resume
  continues). Manual diff-read against `dev-cycle.ts` lines 417–477 for structural parity.

### Step 3 — Honor `stop` at between-round checkpoints (graceful pause → `pending`)

File: `packages/workflows/src/dev-cycle-pr-repair.ts`

- At the top of the main repair `while (true)` loop (line 154, before `state.stage = 'implement'`),
  add:
  ```ts
  if (stopRequested) { state.status = 'pending'; return state; }
  ```
- At the top of the babysit `while (true)` loop (line 212, as the first statement, before
  `await sleep(...)`), add the same check.
- Do **not** call `cleanupWorkspace` on the stop path — a `stop` is a pause; the workspace is left
  intact for a later `resume`/re-run, matching `dev-cycle.ts` (lines 286–289), whose stop path
  returns `pending` without cleanup (unlike its cancel/fail path).

Why after Step 2: Step 2 finalizes the babysit loop body; adding the stop checkpoint on top of the
settled loop avoids re-editing the same region twice. Could be reordered before Step 2 (they touch
adjacent but distinct lines) — kept after so the babysit loop's control flow is final before
inserting the early-return, reducing merge-conflict risk within the file.

Verify:
- `pnpm --filter @agentops/workflows typecheck` — now green (the renamed `stopRequested` from
  Step 1 is read here, clearing the unused-variable error).
- Behavior covered in Step 4 (stop → `pending`).

### Step 4 — Tests

File: `packages/workflows/src/dev-cycle-pr-repair.test.ts` (new).

Use the `TestWorkflowEnvironment.createTimeSkipping()` + `Worker` pattern from
`packages/workflows/src/self-heal.test.ts` (not the module-mock pattern of `dev-cycle.test.ts`):
the fixes are fundamentally about **signals** (`stop`, `resume`, `cancel`), blocking, and
`state` queries, which the module-mock harness cannot exercise (its `setHandler`/`condition` are
no-ops). The Temporal test env runs the real workflow with real signal handlers, so it genuinely
verifies the braked/stop behavior end-to-end. Stub `DevCycleActivities` (like self-heal stubs
`PlatformActivities`), passing `config` in the input so `resolveRepoConfig` is skipped. Provide
stub `runAgent` returning `FULL: PASS` / `VERDICT: PASS` so the workflow reaches `pr_babysit`
quickly; make `getPrFeedback` a call-count-driven stub returning changing verdicts.

Cases:
1. **Braked on `unreadable` → blocked, resumable.** `getPrFeedback` returns
   `{ ciStatus: 'unreadable', unresolvedThreads: 0, comments: [] }` while blocked, then `green`
   after resume. Start the workflow, poll `handle.query('state')` until
   `status === 'blocked' && blockReason === 'babysit-brake'`, assert that, send
   `handle.signal('resume')`, switch the stub to green, assert the run resolves with
   `status === 'done'`. This is the core regression: pre-fix the workflow never blocks on
   `unreadable` (it counts it as `waiting`).
2. **Round-cap braked → blocked, resume lifts the cap and continues.** `config.brakes
   .maxBabysitRounds = 1`. Feedback sequence: failed CI with an unresolved thread (→ `actionable`,
   `babysitRounds` → 1), then still-failing feedback (→ `braked` because `rounds >= cap`). Assert
   `status === 'blocked'` / `blockReason === 'babysit-brake'`, `signal('resume')`, then serve
   `green`, assert `status === 'done'` — proving the resumed run does **not** immediately re-brake
   (validates Step 1's `maxBabysitRounds` lift + Step 2's `maxBabysitWaits` lift).
3. **`stop` → `pending`.** Serve `waiting` feedback (`ciStatus: 'pending'`) so the babysit loop
   keeps looping; `handle.signal('stop')`; assert the run resolves with `status === 'pending'`
   and that `cleanupWorkspace` was **not** called (workspace preserved for resume).
4. **`cancel` while braked → `failed` + cleanup.** Drive to the braked block as in case 1, then
   `signal('cancel')`; assert `status === 'failed'`, `stage === 'failed'`, and `cleanupWorkspace`
   was called (validates the `RepairCancelledError` cancel path from Step 2).

Verify: `pnpm --filter @agentops/workflows test` — all four cases green. (Time-skipping advances
the `sleep(DEFAULT_BABYSIT_POLL_MS)` polls automatically.)

### Step 5 — Full green gate + spec sync

- Run the repo-wide gate: `pnpm lint && pnpm typecheck && pnpm test`.
- Run `pnpm e2e` (AGENTS.md DoD requires e2e for changes touching `workflows`).
- No spec deviation to record beyond the resume-handler gap already captured in this plan's
  Assumptions; if the implementation diverges from the design spec, update
  `docs/superpowers/specs/issue-agentic-ops-engine-119-design.md` in the same PR (AGENTS.md
  convention). The `policies`-behavior-change note in AGENTS.md hard-rule #2 does **not** apply —
  `packages/policies` is untouched.

Verify: all three gate commands and `pnpm e2e` exit 0.

## Sequencing notes

- **Signal plumbing (Step 1) before loop edits (Steps 2–3).** The rename `_stopRequested →
  stopRequested` and the resume-handler cap-lift are the primitives the loop branches rely on;
  fixing them first means Steps 2–3 edit against final signatures. The trade-off is that Step 1 is
  not independently green (the renamed variable is unused until Step 3 reads it) — accepted,
  because the alternative (add the read first) would leave a dangling reference. Typecheck is run
  as a gate at the end of Step 3, when the file is internally consistent.
- **Braked verdict (Step 2) before stop checkpoints (Step 3).** Both edit the babysit loop region.
  Doing the larger structural change (the braked branch + brake-block replacement) first, then
  inserting the small stop early-return on the settled loop, avoids editing the same lines twice.
  Reorderable in principle; kept this way to minimize intra-file churn.
- **Tests (Step 4) after all source edits.** The four cases each depend on a different one of the
  three source changes, so they're written once the behavior is in place rather than interleaved.
- **e2e (Step 5) last.** It's the slowest gate and only meaningful once unit tests pass.

## Assumptions

- **Design gap: resume must lift the round cap, not just the no-progress cap.** The design's
  "Files changed" lists lifting `maxBabysitWaits` inline in the braked branch but does not mention
  the `resumeSignal` handler. Mirroring `dev-cycle.ts` fully requires the handler to lift
  `effectiveBrakes.maxBabysitRounds` on a `babysit-brake` resume (dev-cycle lines 120–122);
  otherwise a resume after a *round-cap* brake immediately re-brakes on the next poll.
  **Resolution:** Step 1 extends the `resumeSignal` handler accordingly. This is faithful to the
  design's stated intent ("mirror `dev-cycle.ts` lines 433–450" — which relies on the handler's
  cap-lift) and introduces no new vocabulary. If a reviewer considers this a spec deviation, the
  design spec should be updated to name the handler change (AGENTS.md docs convention).
- **Cancel handling via existing `RepairCancelledError`.** `dev-cycle.ts` handles cancel inline in
  the braked branch (failed + `cleanupWorkspace` + return). `dev-cycle-pr-repair.ts` already routes
  every cancel through `RepairCancelledError` → its top-level `catch` (which does the identical
  failed + `cleanupWorkspace`). **Resolution:** the braked branch `throw`s `RepairCancelledError`
  on cancel rather than duplicating cleanup inline — consistent with the workflow's existing
  budget-exceeded block (line 113) and avoiding a second cleanup code path.
- **Stop checkpoint granularity.** `stop` pauses between rounds (top of the main repair loop and
  top of the babysit loop), not mid-agent-run — matching `dev-cycle.ts`, which checks
  `stopRequested` only at stage boundaries and returns `status = 'pending'`.
- **Stop leaves the workspace intact.** No `cleanupWorkspace` on the stop path (pause, not
  terminate) — matching `dev-cycle.ts`'s `pending` return.
- **Test harness choice.** Signals/blocking/queries drive these fixes, so tests use
  `TestWorkflowEnvironment` (per `self-heal.test.ts`) rather than the module-mock harness of
  `dev-cycle.test.ts`, whose no-op `setHandler`/`condition` cannot fire or observe signals. This
  is a faithful reading of the design's "follow the Temporal test-env / mock-activity patterns" —
  the test-env pattern is the one that exists in this package for signal-driven workflows.
- **No `contracts`/`policies` change.** `babysitDecision` already returns `'braked'` for both
  sub-causes and is unit-tested (`packages/policies/src/babysit-decision.test.ts`); the fix is
  purely in the workflow caller. `pending`/`blocked`/`babysit-brake` already exist in the fixed
  vocabulary. The determinism boundary (AGENTS.md #1) is respected — no I/O, clock, or randomness
  added.
