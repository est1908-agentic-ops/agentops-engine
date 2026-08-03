# Plan — Task issue-agentic-ops-engine-147

**Bug:** `listAgentSchedules` in `packages/activities/src/schedule-ops.ts` reads the wrong fields off
Temporal's `ScheduleSummary` — `s.action.type` (always the literal `'startWorkflow'`) instead of
`s.action.workflowType`, and `s.schedule.spec` (undefined; `schedule` is not a summary field) instead
of top-level `s.spec`. Result: the reported workflow type is always `'startWorkflow'` and the schedule
spec always falls through to `'continuous'`, so any `reconcileAgents` consumer sees a phantom
`workflow` mismatch and emits spurious `handle.update()` churn.

**Chosen approach:** Approach A from the design — correct the two field reads in place and pin the
correct `ScheduleSummary` shape with a regression test. The live activity path (`create-activities.ts`)
is already correct and stays untouched; deduplication (B) and deletion (C) are rejected as out of
scope. See `docs/superpowers/specs/issue-agentic-ops-engine-147-design.md`.

## Files changed, in order

### 1. `packages/activities/src/schedule-ops.test.ts` — add the regression test FIRST

Write the failing test before the fix so we prove it reproduces the bug, then prove the fix resolves
it. This is the de-risking step: it locks in the exact `ScheduleSummary` shape the fix must read, so
the production edit is verified rather than assumed.

- Add a new `describe('listAgentSchedules (mocked ScheduleClient)')` suite. Import `listAgentSchedules`
  from `./schedule-ops` (extend the existing import on line 3).
- Build a `ScheduleClientLike` whose `list()` is an async generator yielding two realistic summaries:
  - **Target-project summary:** top-level `scheduleId: 'agent:acme:nightly'`,
    `spec: { cronExpressions: ['0 2 * * *'], timezone: 'UTC' }`,
    `action: { type: 'startWorkflow', workflowType: 'whiteboxBugHunt', taskQueue: 'q' }`.
  - **Foreign-project summary:** `scheduleId: 'agent:other:thing'` with any action — must be filtered
    out by the `agent:<project>:` prefix guard.
- Assertions on `await listAgentSchedules('acme', client)`:
  - Returns exactly one entry (foreign project filtered out).
  - `result[0].workflow === 'whiteboxBugHunt'` (NOT `'startWorkflow'`) — this is the core regression
    assertion; fails against current code.
  - `result[0].scheduleSpec === '0 2 * * *'` (NOT `'continuous'`) — proves the top-level `spec` read.
  - `result[0].id === 'agent:acme:nightly'` and `result[0].taskQueue === 'q'`.

**Verify:** `pnpm --filter @agentops/activities test` (or repo-root `pnpm test`) — this new test FAILS
now (workflow reported as `'startWorkflow'`, scheduleSpec as `'continuous'`). Confirm the failure
before editing production code.

### 2. `packages/activities/src/schedule-ops.ts` — fix the two field reads in `listAgentSchedules`

Change lines 110 and 115 (and refresh the adjacent comment on line 109):

- Line 110: `const spec = (s as any)?.schedule?.spec;` → `const spec = (s as any)?.spec;`
  (read top-level `ScheduleSummary.spec`). Keep the `typeof spec === 'string'` /
  `spec?.cronExpressions?.[0]` / `spec?.cron?.cronString` / `'continuous'` fallback chain unchanged.
- Line 115: `const workflow = (s as any)?.action?.type ?? 'whiteboxBugHunt';` →
  `const workflow = (s as any)?.action?.workflowType ?? 'whiteboxBugHunt';`
  Keep the `?? 'whiteboxBugHunt'` fallback for eventually-consistent summaries with the field absent.
- Update the inline comment (line 109) to note these read Temporal's `ScheduleSummary` fields
  (`action.workflowType`, top-level `spec`), matching the already-correct sibling in
  `create-activities.ts:475`.
- No signature, export, `ExistingSchedule`, or contract changes. `taskQueue` and `paused` stay as-is
  (justified in the design's Assumptions).

**Verify:** re-run `pnpm --filter @agentops/activities test` — the new `listAgentSchedules` test now
PASSES; the existing `applyScheduleChanges` suite stays green.

### 3. Full gate

**Verify:** from repo root, `pnpm lint && pnpm typecheck && pnpm test` all green. e2e is not required —
no workflow/policy/backend behavior changes; the touched function is an activities-package helper with
no live in-repo caller, and the live activity path is deliberately unchanged (per design DoD).

## Sequencing rationale

- **Test before fix** de-risks the whole change: it pins the real `ScheduleSummary` shape and gives an
  objective red→green signal, so the one-line-per-field production edit is verified, not assumed. This
  is the only ordering that proves the bug reproduces.
- Steps 2 and 3 could not be reordered (can't gate before the fix exists). Step 1 could technically
  come after step 2, but writing the assertion against buggy code first is what confirms the test
  actually catches the defect rather than trivially passing.

## Assumptions

- **Correct workflow field is `action.workflowType`, not `action.type`.** Verified against
  `@temporalio/client@1.19.0` `ScheduleSummaryStartWorkflowAction` and corroborated by the
  already-correct sibling read in `create-activities.ts:475`.
- **`spec` is top-level on the summary (`s.spec`), not nested under `s.schedule`.** Same SDK type
  (`ScheduleSummary.spec`). Fixed here because it is the same root cause in the same function; without
  it the "fixed" function still reports every spec as `'continuous'`.
- **The scheduleSpec-nesting twin in `create-activities.ts:468` is out of scope.** That live path's
  workflow field is already correct, so it is not the "misreporting workflow type" defect. Recorded as
  a follow-up, not fixed and not left as an inline TODO.
- **No dedup / no deletion.** Both copies remain duplicated (Approach B rejected as scope creep into
  untouched production code); the public export is kept (Approach C rejected against the issue's intent
  to make the function read the correct field).
- **`taskQueue`/`paused` unchanged.** `taskQueue` is genuinely absent from the summary action (present
  only on the fuller description) so stays `undefined`; `paused` is not reliably on list items across
  SDK versions and stays `false` — matching current and sibling behavior. Neither is part of this bug.

## Definition of done

- `pnpm lint && pnpm typecheck && pnpm test` green, with the new `listAgentSchedules` regression test
  included and passing.
- No new TODOs; the out-of-scope `create-activities.ts` twin is noted as a follow-up here, not inline.
- No contract, policy, or workflow behavior change → no e2e requirement and no policy-semantic note.
