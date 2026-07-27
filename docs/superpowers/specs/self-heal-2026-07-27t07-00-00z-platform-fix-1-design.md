# Design — self-heal-2026-07-27t07-00-00z-platform-fix-1

## Goal

The one-shot `platform()` workflow in `packages/workflows/src/platform.ts` prepares a
scratch workspace, runs the agent inside a `try`, and releases the workspace in a bare
`finally`:

```ts
} finally {
  await activities.cleanupScratchWorkspace(workspaceRef);
}
```

JavaScript `finally` semantics mean that if the `try` block is already unwinding with a
real error (e.g. `runAgent` failed) and `cleanupScratchWorkspace` then throws, the cleanup
error *replaces* the in-flight error. The genuine root cause is discarded and only the
cleanup error surfaces up to Temporal. This actually happened for workflow
`self-heal-2026-07-25T15:30:00Z-platform` on 2026-07-27: a `cleanupScratchWorkspace`
path-safety error masked the underlying `runAgent` failure, sending the investigation down
the wrong path.

Harden the cleanup so that when both the try block and cleanup fail, the **original**
error propagates and the cleanup failure is recorded (logged), not swallowed silently.
When the try block succeeded, a cleanup failure should still surface (it is then the only
error). Also review the analogous call in `platform-chat.ts`.

## Approaches considered

### A. `try/catch` inside `finally`, remember the primary error (recommended)

Keep the existing single `finally`, but (1) capture whatever the `try` block throws in a
`primaryError` variable via a `catch` that re-throws, and (2) wrap the cleanup call in its
own `try/catch`. In the cleanup `catch`: always log the cleanup error; re-throw it only if
there is no `primaryError` (i.e. the body succeeded). If a `primaryError` exists, the
logged cleanup error is swallowed so the original error continues to propagate.

- **Trade-off:** needs a `primaryError` flag and an extra `catch` on the try block, which
  is slightly more machinery than the current three lines. But it maps one-to-one onto the
  required behavior and keeps the workspace released on every path.
- **Cost/complexity:** low — a few lines localized to the existing try/finally, plus a
  workflow log import.

### B. Drop `finally`; call cleanup explicitly on both the success and failure paths

Remove the `finally` and instead call cleanup once at the end of the happy path (letting
its errors surface) and once inside a `catch (err)` that swallows/logs the cleanup error
then re-throws `err`.

- **Trade-off:** the cleanup call is duplicated at two sites, and a future edit that adds
  an early `return` inside the try (or another throw site) can bypass one of them and leak
  the workspace. The `finally` guarantee is exactly what protects against that, so removing
  it is a regression in robustness.
- **Cost/complexity:** similar line count but strictly worse invariants; rejected.

### C. Extract a shared `cleanupPreservingError` helper

Factor the "cleanup, but never let it mask a pending error" logic into a reusable helper
(in `policies` or a workflow-local util) and call it from both `platform.ts` and
`platform-chat.ts`.

- **Trade-off:** the pattern needs the pending-error context (whether the body threw),
  which a standalone helper can't observe without the caller passing it in — so the helper
  ends up as thin as the inline code while adding an indirection and a new export. With
  only one site that actually sits in an error path today, the abstraction is premature.
- **Cost/complexity:** higher (new export + its own tests) for no present payoff; rejected.

## Chosen approach

**Approach A.** It preserves the `finally` guarantee (workspace always released, including
on the `if (!payload)` early-return path further down), expresses the exact required
semantics — surface the original error, log-and-swallow the masking cleanup error, surface
cleanup errors only when the body succeeded — and stays local to the one function that has
the bug. B is rejected because dropping `finally` weakens the release guarantee; C is
rejected as premature abstraction given only one real error-path site.

## Assumptions

- **How to "record" the cleanup failure:** the goal offers "recordRunStats or a log line."
  I will use the Temporal workflow logger (`log` from `@temporalio/workflow`, which is
  determinism-safe and needs no activity round-trip) at `error` level, including the
  `taskId` and the cleanup error. `recordRunStats` is rejected for this: it demands a full
  `RunStats` shape (stage/backend/model/token counts) that has no meaningful value for a
  cleanup failure, and it is itself an activity that can fail or retry inside the failure
  path we are trying to make robust.
- **`platform-chat.ts` needs no code change.** Its `cleanupScratchWorkspace` call
  (line 267) runs only after the `while` loop exits normally (real close / idle timeout /
  `done`) — it is *not* in a `finally` and *not* on an error/`catch` path, and the
  `continueAsNew` path unwinds before reaching it. There is no in-flight error for a
  cleanup throw to mask there, so a cleanup failure correctly surfaces as the sole error.
  I will note this in the PR description and add a short clarifying comment at that call
  site so the invariant ("not in an error path — do not copy platform.ts's guard here
  unless that changes") is explicit for future edits. No behavioral change to that file.
- **No new contract or stage vocabulary** is required; this is purely control-flow
  hardening plus logging.
- **A regression test belongs with this change.** There is currently no `platform.test.ts`
  (only `platform-chat.test.ts` and `self-heal.test.ts`), so I will add one rather than
  extend an existing file.

## Design

### Files affected

- **`packages/workflows/src/platform.ts`** (behavioral change):
  - Import `log` from `@temporalio/workflow` alongside the existing imports.
  - Introduce a `let primaryError: unknown;` before the `try`.
  - Add a `catch (err) { primaryError = err; throw err; }` to the existing `try`.
  - Replace the bare `finally` body with a nested `try/catch` around
    `cleanupScratchWorkspace`. In the `catch (cleanupErr)`: `log.error(...)` with `taskId`
    and the error; then `if (!primaryError) throw cleanupErr;` (so cleanup errors surface
    only when the body succeeded; otherwise the original `primaryError` keeps propagating).
  - Add a brief comment explaining why the original error wins (points back to the
    2026-07-25 masking incident).

- **`packages/workflows/src/platform-chat.ts`** (comment only, no behavior change):
  - Add a one-line comment at the line-267 cleanup call noting it is deliberately outside
    any error path, so the `platform.ts` guard is intentionally not replicated here.

- **`packages/workflows/src/platform.test.ts`** (new test file):
  - Stub `PlatformActivities` in the style of `self-heal.test.ts` / `platform-chat.test.ts`,
    running the workflow under `TestWorkflowEnvironment` + a `Worker`.
  - **Test 1 (regression, primary):** `runAgent` rejects with a recognizable "AGENT_BOOM"
    error and `cleanupScratchWorkspace` rejects with a distinct "CLEANUP_BOOM" error.
    Assert the workflow rejects with the **agent** error, not the cleanup error — proving
    the original cause is no longer masked.
  - **Test 2 (cleanup surfaces on success):** `runAgent` returns a parseable
    `PLATFORM_RESULT` and `cleanupScratchWorkspace` rejects. Assert the workflow rejects
    with the cleanup error (it is the only failure). This pins the "surface cleanup error
    only when the body succeeded" half of the contract.
  - (Optional, if cheap) a happy-path assertion that a successful run with a successful
    cleanup returns the expected summary — mirrors existing coverage and guards against the
    new control flow accidentally swallowing the return value.

### Data flow / control flow

Unchanged externally: `platform()` still returns a `PlatformAgentResult` on success and the
workspace is still released on every exit path. The only observable difference is *which*
error escapes when cleanup fails during an already-failing run: now the original
try-block error, with the cleanup error captured in the workflow logs instead of lost.

### Error handling summary

| Body result | Cleanup result | Propagated error | Logged |
|---|---|---|---|
| success | success | none (normal return) | — |
| success | throws | cleanup error | cleanup error (also thrown) |
| throws  | success | original body error | — |
| throws  | throws  | original body error | cleanup error (swallowed) |

### Determinism / repo-rule check

- `log` from `@temporalio/workflow` is the SDK's workflow-safe logger; no `Date.now()`,
  `Math.random()`, I/O, or activity/ports imports are added, so the `packages/workflows`
  determinism boundary (AGENTS.md hard rule 1) holds.
- No new contract shapes, stages, or status vocabulary (hard rules 3 and the stage-naming
  convention) — nothing to add there.
- SLDS lifecycle is unaffected: this is defensive error handling inside an existing
  workflow, not a change to the development lifecycle.
- Definition of done: new + existing unit tests, `pnpm lint && pnpm typecheck && pnpm test`
  green; e2e applies (workflows touched) and should be run.

### Scope

This is one coherent change: harden a single cleanup site against error masking, add its
regression test, and leave a clarifying comment at the analogous (currently safe) site. No
unrelated work is bundled in.

## Brainstorm Summary
**Approaches considered:** (A) keep the `finally` but capture the try-block error and wrap the cleanup call in its own try/catch; (B) drop `finally` and call cleanup on both success and catch paths; (C) extract a shared cleanup-preserving helper for both platform workflows.
**Chosen approach:** (A) — a `primaryError` flag plus a nested try/catch inside the existing `finally`.
**Why (decisive reasons):** It keeps the `finally` guarantee that the workspace is always released, maps exactly onto the required semantics (surface the original error, log-and-swallow the masking cleanup error, surface cleanup errors only on success), and stays local to the one buggy function. B weakens the release guarantee; C is premature abstraction with only one real error-path site.
**Key risks/assumptions:** Cleanup failures are recorded via the determinism-safe `@temporalio/workflow` `log` (not `recordRunStats`). `platform-chat.ts`'s cleanup is not in an error path, so it gets only a clarifying comment, no behavior change. A new `platform.test.ts` adds the regression coverage.
