# Design — Task issue-agentic-ops-engine-147

**Bug:** `listAgentSchedules` in `packages/activities/src/schedule-ops.ts` reads the wrong field from
each Temporal schedule summary, always misreporting the workflow type.

## Goal

Make `listAgentSchedules` report the real workflow type of each existing agent schedule, so the
reconcile loop (`reconcileAgents`) stops treating every schedule as changed. Restated: the function
must read fields off Temporal's actual `ScheduleSummary` shape instead of an imagined one.

## Root cause

`ScheduleClient.list()` yields `ScheduleSummary` objects. Per the Temporal TS SDK
(`@temporalio/client` `schedule-types.d.ts`):

- `ScheduleSummaryStartWorkflowAction = { type: 'startWorkflow'; workflowType: string }` — `.type` is
  the *action kind* (the constant `'startWorkflow'`); `.workflowType` is the workflow name.
- `spec` lives at the **top level** of the summary (`summary.spec`), and `action` at the top level
  (`summary.action`).

`schedule-ops.ts` reads:

- `(s as any)?.action?.type` for the workflow (line 115) → always the literal `'startWorkflow'`.
- `(s as any)?.schedule?.spec` for the spec (line 111) → `schedule` is not a field on the summary, so
  this is always `undefined` and the scheduleSpec falls through to the `'continuous'` default.

Because `ExistingSchedule.workflow` is always `'startWorkflow'`, the comparison in
`reconcileAgents` (`packages/policies/src/reconcile-agents.ts:111`, `cur.workflow !== spec.workflow`)
is true for every schedule whose real workflow is anything else (e.g. `whiteboxBugHunt`). Every
reconcile therefore pushes every schedule into `toUpdate` and issues a spurious `handle.update()` —
churn on each ~15-minute reconcile, and a misleading "workflow type" in any consumer of the list.

The identical read in the *live* activity (`create-activities.ts:475`) already uses
`action.workflowType` correctly, confirming `workflowType` is the intended field. The two
implementations have diverged; the `schedule-ops.ts` copy is the stale one.

## Scope note (dead code + a sibling twin)

Two things a reviewer should know up front, both resolved deliberately below:

1. **The buggy function has no in-repo caller.** The workflow path (`config-sync.ts` →
   `acts.listAgentSchedules`) resolves to the inline activity in `create-activities.ts`, not to this
   exported standalone. `schedule-ops.ts`'s `listAgentSchedules` is a diverged duplicate exported
   from `@agentops/activities`. It is a landmine (public export, silently wrong) rather than a live
   defect. The issue explicitly asks to fix the wrong field, so this change corrects it rather than
   deleting it (see rejected Approach C).
2. **The scheduleSpec-nesting twin exists in both copies.** `create-activities.ts:468` also reads
   `(rec.schedule as any)?.spec`. Fixing that in the live activity is a *separate* defect (the live
   path's workflow field is already correct, so it is outside this issue's "misreporting workflow
   type" framing). It is left out of scope and flagged as follow-up rather than silently bundled.

## Approaches considered

### Approach A — Correct the field reads in `schedule-ops.ts` (recommended)

Fix `listAgentSchedules` to read the real `ScheduleSummary` shape: `s.action.workflowType` for the
workflow, and `s.spec` (top-level) for the schedule spec, keeping the existing safe fallbacks. Add a
unit test that drives the function with a realistic `ScheduleSummary` and asserts the reported
workflow type and cron.

- **Trade-off:** Leaves the two implementations duplicated, so they can drift again. Mitigated by a
  regression test that pins the correct shape.
- **Cost:** ~4 changed lines + one new test. No change to the live activity path or to typed
  contracts.

### Approach B — Fix and deduplicate (make `create-activities.ts` call the shared function)

Correct `schedule-ops.ts` as in A, then replace the inline copy in `create-activities.ts` with a call
to the shared, corrected function — eliminating the divergence that caused the bug.

- **Trade-off:** Touches the live activity path and must preserve its best-effort `try/catch` and
  slightly different `scheduleSpec` fallback (`String(spec ?? '')` vs `'continuous'`). Larger blast
  radius for a bughunt; risks changing production behavior beyond the reported defect.
- **Cost:** Moderate; requires reconciling two divergent fallbacks and re-running the e2e suite that
  covers activities/workflows.

### Approach C — Delete the dead standalone function

Since it has no in-repo caller, remove `schedule-ops.ts`'s `listAgentSchedules` entirely.

- **Trade-off:** It is a public export of `@agentops/activities`; deletion is a breaking API change,
  and the issue asks to *fix the field*, implying the function should exist and be correct. No
  regression test is possible against deleted code.
- **Cost:** Low, but wrong intent for a bughunt.

## Chosen approach

**Approach A.** It directly fixes the reported defect at the exact location named in the issue, adds
the regression test the Definition of Done requires, and stays strictly scoped — no changes to the
live activity path, contracts, or workflow behavior. Approach B is rejected as scope creep: the
duplication is real but deduplicating touches production code the issue does not implicate and would
drag in the separate scheduleSpec-nesting decision; it is recorded as a follow-up. Approach C is
rejected because it removes a public export and contradicts the issue's intent to make the function
read the correct field.

## Assumptions

- **The correct workflow field is `action.workflowType`, not `action.type`.** Verified against the
  installed `@temporalio/client@1.19.0` `ScheduleSummaryStartWorkflowAction` type and corroborated by
  the already-correct sibling in `create-activities.ts`.
- **`spec` is top-level on the summary (`s.spec`), not nested under `s.schedule`.** Verified from the
  same SDK type (`ScheduleSummary.spec?: ScheduleSpecDescription`). I include this fix because it is
  the same root cause in the same function; without it the "fixed" function still reports every spec
  as `'continuous'`. This keeps the change coherent ("read `ScheduleSummary` correctly") rather than
  half-fixing one field.
- **`taskQueue` and `paused` stay as-is.** `taskQueue` is genuinely absent from the *summary* action
  (it exists only on the fuller *description*), so it remains `undefined`; `reconcileAgents` already
  guards `cur.taskQueue !== undefined`. `paused` is not reliably present on list items across SDK
  versions and is left defaulting to `false`, matching current behavior and the sibling
  implementation. Neither is part of the reported bug.
- **The scheduleSpec-nesting bug in `create-activities.ts:468` is out of scope.** The live path's
  workflow field is already correct, so it is not the "misreporting workflow type" defect. Flagged as
  a follow-up rather than fixed here.
- **`ExistingSchedule` shape and reconcile semantics are unchanged.** No contract or policy change; per
  AGENTS.md, `packages/policies` behavior is untouched, so no policy-test or semantic-change note is
  needed.

## Design (what changes)

Single file of production change plus one test file:

- **`packages/activities/src/schedule-ops.ts` — `listAgentSchedules`:**
  - Read the spec from the summary top level: `const spec = (s as any)?.spec` (was
    `(s as any)?.schedule?.spec`). Keep the existing string / `cronExpressions[0]` /
    `cron.cronString` / `'continuous'` fallback chain unchanged.
  - Read the workflow from `(s as any)?.action?.workflowType` (was `?.action?.type`), keeping the
    `?? 'whiteboxBugHunt'` fallback for summaries where the field is momentarily absent (schedule
    listing is eventually consistent, per the SDK docs).
  - No signature, export, or type changes. The surrounding comments already describe intent; update
    the inline comment near the extraction to reflect that these read `ScheduleSummary` fields.

- **`packages/activities/src/schedule-ops.test.ts` — new test for `listAgentSchedules`:**
  - Add a suite that builds a mock `ScheduleClientLike` whose `list()` async-generates one realistic
    `ScheduleSummary` (top-level `scheduleId`, `spec.cronExpressions`, `action.type: 'startWorkflow'`,
    `action.workflowType: 'whiteboxBugHunt'`) for the target project and one for a different project.
  - Assert the returned `ExistingSchedule` reports `workflow: 'whiteboxBugHunt'` (not
    `'startWorkflow'`) and `scheduleSpec: '0 2 * * *'`, and that the foreign-project schedule is
    filtered out by the `agent:<project>:` prefix guard. This test fails against the current code and
    passes after the fix.

**Data flow after the fix:** `config-sync` workflow → (live activity, already correct) unaffected;
any consumer of the exported `schedule-ops.listAgentSchedules` now receives the true workflow type
and cron, so a downstream `reconcileAgents` no longer sees a phantom `workflow` mismatch and stops
emitting spurious updates.

**Error handling:** unchanged. The prefix filter and the `?? 'whiteboxBugHunt'` / `?? 'continuous'`
fallbacks remain, preserving best-effort behavior against partially-populated, eventually-consistent
summaries.

## Definition of done

- `pnpm lint && pnpm typecheck && pnpm test` green; new `listAgentSchedules` test included and
  passing. e2e is not required — no workflow/policy/backend behavior changes; the touched function is
  an activities-package helper with no live caller, and the live activity path is unchanged.
- No new TODOs. The out-of-scope `create-activities.ts` scheduleSpec-nesting twin is noted here as a
  follow-up, not left as an inline TODO.

## Self-review

- No placeholders or TBDs.
- No contradictions: the scope note, assumptions, and design agree that only `schedule-ops.ts` (+ its
  test) changes and the live activity path is deliberately untouched.
- One coherent change: "make `schedule-ops.ts`'s `listAgentSchedules` read the real `ScheduleSummary`
  shape." The spec-nesting fix is included only because it is the same bug in the same function; the
  separate live-activity twin and the dedup refactor are explicitly deferred, not smuggled in.

## Brainstorm Summary
**Approaches considered:** (A) fix the two wrong field reads in `schedule-ops.ts`'s `listAgentSchedules` + add a regression test; (B) also deduplicate by pointing the live `create-activities.ts` activity at the shared function; (C) delete the dead standalone export.
**Chosen approach:** A — correct `s.action.type`→`s.action.workflowType` and `s.schedule.spec`→`s.spec` to match Temporal's real `ScheduleSummary`, with a unit test.
**Why (decisive reasons):** Fixes the exact defect named in the issue with minimal blast radius; verified against `@temporalio/client@1.19.0` types and the already-correct sibling activity. B is scope creep into untouched production code; C removes a public export against the issue's intent.
**Key risks/assumptions:** The buggy function currently has no in-repo caller (a latent landmine, not a live break); the identical scheduleSpec-nesting bug in `create-activities.ts` is a separate defect left as follow-up; duplication between the two copies remains and could drift again.
