# Plan — issue-agentic-ops-engine-118

**Title:** [bughunt] `devCyclePrRepair` babysit loop discards cancel signal result, workflow never terminates on cancel

**Design authority:** `docs/superpowers/specs/issue-agentic-ops-engine-118-design.md` (Approach A — targeted one-site fix).

## Summary of the change

One source-line semantic fix plus a colocated regression test.

- `packages/workflows/src/dev-cycle-pr-repair.ts` — in the PR-babysit no-progress brake branch,
  honor the return value of `waitForResumeOrCancel()`: throw `RepairCancelledError` on cancel,
  keep the current `waiting = 0` reset on resume.
- `packages/workflows/src/dev-cycle-pr-repair.test.ts` — new file; a workflow-level regression
  test that drives the loop to a babysit brake, sends `cancel`, and asserts the workflow
  **returns** `status: 'failed'` (terminates) and calls `cleanupWorkspace`.

No changes to contracts, signals, handlers, `state` shape, activities, or the top-level `catch`.
The existing `RepairCancelledError` → top-level-catch path already produces `status: 'failed'` +
`cleanupWorkspace` + `return state`, so no new plumbing is required.

## Steps (ordered)

### Step 1 — Write the failing regression test (`packages/workflows/src/dev-cycle-pr-repair.test.ts`, new)

Author the test **first** so it captures the bug before the fix lands (it should hang/fail
against current code, pass after Step 2). Follow the mocking style of `dev-cycle.test.ts`:

- `vi.hoisted(() => {...})` to create activity mocks; `vi.mock('@temporalio/workflow', ...)`
  returning the two `proxyActivities` shapes (the `heartbeatTimeout` proxy → `{ runAgent }`,
  the other → the full-activity proxy incl. `prepareWorkspace`, `pushBranch`, `getPrFeedback`,
  `cleanupWorkspace`, `recordStageResult`, `recordRunStats`, `resolveRepoConfig`).
- Mock `runAgent` to return, by stage: `implement` → non-empty `output: 'diff'`,
  `full_verify` → `'FULL: PASS'`, `review` → `'VERDICT: PASS'`. This makes `nextRepairAction`
  return `continue`, so the repair loop `break`s on the first iteration and control reaches the
  babysit loop.
- Mock `getPrFeedback` to return a **non-mergeable, non-actionable, readable** feedback so
  `babysitDecision` returns `'waiting'` every poll: `{ ciStatus: 'pending', unresolvedThreads: 0,
  comments: [] }` (not `green` → not `merge_ready`; not `unreadable`/`failed` and no threads →
  not `actionable`/`braked`; falls through to `waiting`). This drives the loop's local `waiting`
  counter up to `MAX_BABYSIT_WAITS` (240) and hits the brake.
- Mock `sleep` → resolve immediately (so the 240 poll iterations run instantly).
- **Cancel wiring:** capture the handler registered for the `cancel` signal. Since `defineSignal`
  in the mock returns a constant token, distinguish the three signals by having `defineSignal`
  return a distinct token per call/name (e.g. return the name), and capture the handler passed to
  `setHandler` for the `cancel` token. Because `waitForResumeOrCancel()` is only reached at the
  babysit brake in this path (budget is never exceeded), make the `condition` mock invoke the
  captured `cancel` handler (setting `cancelled = true`) and then resolve — so the single
  `condition` call at the brake yields a cancel.
  - Rationale for driving cancel via the `condition` mock: `condition` is the exact suspension
    point the real workflow parks on; resolving it after flipping `cancelled` faithfully models
    "operator sends `cancel` while parked at the brake". This mirrors how `dev-cycle.test.ts`
    already stubs `condition` as an immediately-resolving `vi.fn()`.
- Provide a `config` with `brakes` (as in `dev-cycle.test.ts`) and a valid
  `DevCyclePrRepairInput` (`taskId`, `project`, `repo`, `prRef`, optional `headBranch`).
- **Assertions:**
  - The `devCyclePrRepair(...)` promise **resolves** (does not hang) — the whole point of the fix.
  - Resolved value has `status: 'failed'` and `stage: 'failed'`.
  - `cleanupWorkspace` was called (workspace cleaned up on cancel).

**Verify:** `pnpm --filter @agentops/workflows test dev-cycle-pr-repair` (or the repo's test
runner scoped to this file). Against current, unfixed code the test must **fail** (the loop resets
`waiting = 0` and re-enters the `while (true)` babysit loop → the promise never resolves; the test
observes a hang/timeout instead of a `failed` return). This confirms the test actually exercises
the bug.

### Step 2 — Apply the one-site fix (`packages/workflows/src/dev-cycle-pr-repair.ts`, ~line 243)

In the babysit `while` loop's no-progress brake branch, change:

```ts
state.status = 'blocked';
state.blockReason = 'babysit-brake';
await waitForResumeOrCancel();   // <-- return value discarded
waiting = 0;
```

to:

```ts
state.status = 'blocked';
state.blockReason = 'babysit-brake';
if (await waitForResumeOrCancel()) throw new RepairCancelledError();
waiting = 0;
```

This matches the file's own established cancel idiom (line ~113 in `runStageAgent`'s
budget-exceeded branch). On cancel → throw `RepairCancelledError`, caught by the top-level
`catch` which sets `stage = 'failed'`, `status = 'failed'`, calls `cleanupWorkspace`, and returns
`state`. On resume (`cancelled` false) → `waiting = 0` and the loop continues exactly as today.

**Verify:** `pnpm --filter @agentops/workflows test dev-cycle-pr-repair` — the Step 1 test now
**passes** (workflow returns `status: 'failed'` and calls `cleanupWorkspace`).

### Step 3 — Full gate

Run the repo's definition-of-done gate to confirm nothing regressed.

**Verify:**
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test` (includes the existing `packages/contracts/src/dev-cycle-pr-repair.test.ts` schema
  test, which is untouched and must still pass, plus the new workflow test).
- `pnpm e2e` — this change touches `packages/workflows`, so per AGENTS.md rule 6 the e2e suite
  must pass. Run it; if the sandbox cannot start the e2e harness, record that in the PR
  description rather than silently skipping.

## Sequencing notes

- **Test before fix (Step 1 before Step 2).** Ordered this way deliberately so the regression
  test is demonstrated to fail against the current code first — proving it pins the exact bug (a
  discarded boolean causing a non-terminating loop) rather than passing vacuously. This de-risks
  the whole task: if the test can't be made to hang on current code, the reproduction is wrong and
  I'd revisit the mock wiring before touching source.
- **Fix is a single line; not splittable.** Step 2 is one coherent edit. It could technically be
  applied before the test, but that would forfeit the fail-first signal, so it is ordered second.
- **Gate last (Step 3).** The broad lint/typecheck/test/e2e gate runs after the focused change is
  green, per the repo's definition of done.
- No step depends on the design's "Out of scope" item (the redundant local `waiting` counter vs.
  `babysitDecision`'s ignored `'braked'` return); it is intentionally left untouched to keep the
  diff minimal and avoid determinism/replay risk on a live Temporal workflow loop.

## Assumptions

- **Cancel-at-brake terminates as `status: 'failed'`** (not `done` or a new `'cancelled'` status).
  This follows the file's only existing cancel path (`RepairCancelledError` → catch → `failed`)
  and matches `dev-cycle.ts`'s babysit-cancel behavior. Carried over from the design; no new
  status vocabulary is introduced (respects the fixed `TaskStatusSchema` vocabulary rule).
- **Resume semantics unchanged.** On resume the loop keeps `waiting = 0` and continues; I do not
  adopt `dev-cycle.ts`'s "lift the cap to unbounded on resume" behavior, as that is part of the
  deferred Approach-B cleanup and not needed to fix the cancel bug.
- **New colocated test file is acceptable.** No `packages/workflows/src/dev-cycle-pr-repair.test.ts`
  exists today; I add one (workflow behavior) rather than extending the contracts schema test.
- **Driving cancel via the `condition` mock is a faithful model.** With budget never exceeded,
  `waitForResumeOrCancel()`/`condition` is reached only at the babysit brake, so having the
  `condition` mock flip `cancelled` and resolve exactly reproduces an operator cancel at the
  parked brake. If a future edit adds another `condition` call on the happy path, the test would
  need to gate the cancel to the brake-specific call; not a concern for the current code shape.
- **`babysitDecision` yields `'waiting'` for `{ ciStatus: 'pending', unresolvedThreads: 0 }`.**
  Verified against `packages/policies/src/babysit-decision.ts`: not `merge_ready` (pending ≠
  green), not `braked` (readable, rounds < cap), not `actionable` (not failed, no threads) →
  `'waiting'`, which the pr-repair loop treats as a no-progress poll and increments `waiting`.

## Self-review

- Every step has a concrete verification command/observation.
- No step is two steps in disguise: Step 1 = write test, Step 2 = one-line source edit, Step 3 =
  run the gate.
- Scope matches the design (Approach A): one semantic source fix + one regression test; the
  related loop-structure cleanup is explicitly deferred, not bundled.
