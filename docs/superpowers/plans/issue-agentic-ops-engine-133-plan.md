# Plan — Task issue-agentic-ops-engine-133

**Title:** [bughunt] Deprecated `devCyclePrRepair` babysit loop ignores `babysitDecision`'s brake verdict

Design: `docs/superpowers/specs/issue-agentic-ops-engine-133-design.md` (Approach B — versioned
fix behind `patched('pr-repair-babysit-brake-v1')`). This plan turns that design into ordered,
individually-verifiable steps. No implementation code is written here.

## Context (verified against the tree)

- Buggy loop tail: `packages/workflows/src/dev-cycle-pr-repair.ts:217-272`. It branches on
  `merge_ready` (line 229) and `actionable` (line 231) only; `braked` falls through to the
  `waiting += 1` / local-cap block (lines 257-271), so the policy's immediate-brake verdict is
  discarded until the local `waiting` counter reaches `MAX_BABYSIT_WAITS` (240).
- Canonical correct handling to mirror: `packages/workflows/src/dev-cycle.ts:457-478` (the
  `braked` block) plus its mutable `let maxBabysitWaits = MAX_BABYSIT_WAITS;` at line 443.
- Existing `patched()` precedent: `dev-cycle.ts:400` (`patched('shared-pr-landing-v1')`), imported
  from `@temporalio/workflow` at `dev-cycle.ts:6`.
- Policy already returns `'braked'` correctly for unreadable CI and the round cap
  (`packages/policies/src/babysit-decision.ts:29-33`) and for the no-progress cap (line 44). No
  policy change is in scope, so AGENTS.md rule #2 (policy-semantics PR note) does not apply.
- Test file to extend: `packages/workflows/src/dev-cycle-pr-repair.test.ts`. Its
  `@temporalio/workflow` mock (lines 47-83) has **no** `patched` export yet, and the `condition`
  mock (lines 62-69) fires the cancel handler on first call — this is what drives the existing
  brake-cancel test.

## Steps

### Step 1 — Add `patched` to the test mock, defaulting to `false`

**File:** `packages/workflows/src/dev-cycle-pr-repair.test.ts`

- Add a `patched` mock fn to the `vi.hoisted(...)` block so per-test control is possible; export
  it alongside the other activity mocks.
- Add `patched` to the `vi.mock('@temporalio/workflow', ...)` factory's returned object.
- Default it to `false` (`vi.fn().mockReturnValue(false)`), and reset it in `beforeEach` (either
  via the existing `vi.clearAllMocks()` plus an explicit `patched.mockReturnValue(false)`, since
  `clearAllMocks` clears return values).

**Why first:** this de-risks everything. Adding a new export the workflow will import, before the
workflow imports it, means Step 2's `import { patched }` resolves in tests immediately. It is also
a pure test-scaffolding change with no production effect.

**Verify:** `pnpm --filter @agentops/workflows test dev-cycle-pr-repair` — the existing
brake-cancel test must stay green (it now runs with `patched → false`, i.e. the unchanged old
path). Confirms the mock wiring didn't regress anything before the source changes land.

### Step 2 — Apply the versioned brake fix in the workflow

**File:** `packages/workflows/src/dev-cycle-pr-repair.ts`

1. Add `patched` to the existing `@temporalio/workflow` import (line 1-8).
2. In the babysit setup (currently lines 213-215), before `while (true)`:
   - keep `const seen = new Set<string>();`
   - `let waiting = 0;` (unchanged)
   - add `let maxBabysitWaits = MAX_BABYSIT_WAITS;` (mutable, mirroring `dev-cycle.ts:443`)
   - add `const brakeFixEnabled = patched('pr-repair-babysit-brake-v1');`
3. In the `babysitDecision(...)` call (lines 220-227), pass `maxBabysitWaits` as the sixth arg
   instead of the bare `MAX_BABYSIT_WAITS` constant, so a resumed brake can lift the cap.
4. Restructure the loop tail (lines 229-271):
   - `merge_ready → break` (unchanged).
   - **New block, gated:** `if (brakeFixEnabled && decision === 'braked') { … }` mirroring
     `dev-cycle.ts:461-478` but using this file's inline teardown (no `dropAgentWorking()` here —
     pr-repair has none): set `state.status='blocked'` / `state.blockReason='babysit-brake'`;
     `if (await waitForResumeOrCancel()) { state.stage='failed'; state.status='failed'; await
     activities.cleanupWorkspace(state.workspaceRef, input.repo); return state; }`; on resume
     `maxBabysitWaits = Number.MAX_SAFE_INTEGER; waiting = 0; state.stage='pr_babysit'; continue;`.
   - `actionable → …` repair block (unchanged, lines 231-255).
   - **Tail:** keep the exact current `waiting += 1` + local-cap brake block (lines 257-271)
     **verbatim** as the `!brakeFixEnabled` / `waiting` fall-through. When `brakeFixEnabled` is
     true, `braked` is already handled above, so the fall-through is only ever reached for the
     genuine `waiting` verdict — the existing code is behaviorally correct there and is left byte-
     for-byte unchanged so replayed pre-patch histories (which never set the marker) reproduce the
     old command sequence exactly.
5. Update the top-of-function comment (lines 41-42): keep the "Deprecated … Kept replayable … do
   not rewrite this body" warning, and add one line noting the `braked` fix is gated behind
   `patched('pr-repair-babysit-brake-v1')` so in-flight histories replay unchanged.

**Verify:**
- `pnpm --filter @agentops/workflows typecheck` — proves the new `patched` import, the mutable
  `maxBabysitWaits`, and the reshaped branches type-check.
- `pnpm --filter @agentops/workflows test dev-cycle-pr-repair` — existing brake-cancel test still
  green (still `patched → false`). This is the replay-safety guard: the old path is untouched.

### Step 3 — Add coverage for both patched states

**File:** `packages/workflows/src/dev-cycle-pr-repair.test.ts`

- **New test, `patched → true` (immediate brake):** set `patched.mockReturnValue(true)`;
  `getPrFeedback.mockResolvedValue({ ciStatus: 'unreadable', unresolvedThreads: 0, comments: [] })`
  so `babysitDecision` returns `'braked'` on the first poll. The `condition` mock fires cancel on
  first call, so `waitForResumeOrCancel()` returns cancelled. Assert:
  `getPrFeedback` called exactly **once** (immediate brake, not 240 polls), `result.status ===
  'failed'`, `result.stage === 'failed'`, `cleanupWorkspace` called with `('ws', 'owner/repo')`.
- **New test, `patched → false` (old polling path preserved):** same `unreadable` feedback with
  `patched → false`. Assert the brake is reached only via the local `waiting` cap — i.e.
  `getPrFeedback` called `MAX_BABYSIT_WAITS` (240) times before termination — and still ends
  `status/stage === 'failed'`. This locks in that the ungated path is unchanged (replay safety).
- Leave the existing brake-cancel test as-is (runs under `patched → false`).

**Verify:** `pnpm --filter @agentops/workflows test dev-cycle-pr-repair` — all three tests green:
the new `patched → true` test proves the immediate brake, the new `patched → false` test proves
old behavior is intact, the existing test stays green.

### Step 4 — Full gate

**Files:** none (verification only).

**Verify (Definition of Done, AGENTS.md rule #6):**
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm e2e` — required because the change touches `packages/workflows`.

All must be green. No docs/vision change: this is a bug fix to a deprecated path and does not alter
the target lifecycle (`docs/software-lifecycle-vision.md` unchanged).

## Sequencing notes

- **Mock scaffolding (Step 1) before source (Step 2).** The workflow will `import { patched }`
  from the mocked module; adding the export first means every test run after Step 1 already has a
  valid (false-returning) `patched`, so the existing test never breaks mid-change and Step 2's
  first test run is a clean signal.
- **Source (Step 2) before new tests (Step 3).** The `patched → true` assertions (immediate brake,
  one poll) only pass once the gated branch exists; writing them earlier would just be red noise.
  I deliberately did **not** write tests first here — TDD's failing-test value is low when the
  exact target behavior is already specified byte-for-byte by `dev-cycle.ts`, and a spuriously-red
  suite mid-change obscures the one signal that matters (the existing replay-safety test staying
  green across Step 2).
- **Could Step 2 and Step 3 be merged?** No — they are genuinely two steps. Step 2's verification
  is "old test still green / typecheck passes" (regression guard); Step 3's is "new behavior
  asserted." Merging them would blur which change caused a failure.
- **e2e (Step 4) last.** It is the slowest and only meaningful once units + typecheck are green.

## Assumptions

- **`patched` per-test control via `mockReturnValue`.** The design says "add `patched` to the mock
  (default `false`)" without specifying the toggle mechanism. I resolve this as a hoisted `vi.fn()`
  reset to `false` in `beforeEach` and set to `true` inside the immediate-brake test — matching how
  the file already threads hoisted mocks and the existing `beforeEach` reset pattern.
- **Old-path assertion = poll count.** The design's `patched → false` test says "loop keeps polling;
  brake only via the local waiting cap." I make that concrete by asserting `getPrFeedback` is called
  `MAX_BABYSIT_WAITS` (240) times, which is the observable difference from the one-poll immediate
  brake. `sleep` is already mocked to resolve immediately, so 240 iterations run without real delay.
- **No `dropAgentWorking()` in the mirrored branch.** `dev-cycle.ts`'s braked teardown calls
  `dropAgentWorking()`; `dev-cycle-pr-repair.ts` has no such helper (its existing local-cap brake at
  lines 264-269 doesn't call it either). I mirror the *pr-repair* teardown shape, not `dev-cycle`'s,
  so the new branch's cancel path is identical to the code it sits beside — preserving the #120
  cancel-during-brake guarantee without introducing a symbol this file doesn't define.
- **Version id `pr-repair-babysit-brake-v1`** as stated in the design, following the existing
  `shared-pr-landing-v1` convention. Assumed unused elsewhere (grep confirms `shared-pr-landing-v1`
  is the only current marker).
- **Scope is `packages/workflows` only.** Per the design, `babysitDecision` already returns
  `'braked'` correctly, so no `packages/policies` or `packages/contracts` change — hence no
  policy-semantics PR note (AGENTS.md rule #2) is required.
