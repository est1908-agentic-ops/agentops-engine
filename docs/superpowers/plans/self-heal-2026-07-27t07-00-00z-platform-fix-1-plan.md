# Plan — self-heal-2026-07-27t07-00-00z-platform-fix-1

Harden the `platform()` workflow's scratch-workspace cleanup so a cleanup failure can no
longer mask a genuine in-flight error from the `try` block. Implements **Approach A** from
`docs/superpowers/specs/self-heal-2026-07-27t07-00-00z-platform-fix-1-design.md`: keep the
single `finally`, capture the try-block error in a `primaryError` flag, wrap the cleanup
call in its own `try/catch`, log any cleanup failure via the determinism-safe
`@temporalio/workflow` `log`, and re-throw the cleanup error only when the body succeeded.

## Steps

### Step 1 — Add the regression test (`packages/workflows/src/platform.test.ts`, new file)

Write the failing test first so it pins the exact bug before the fix lands, and so the fix
step has an objective pass/fail signal.

- Model the harness on `platform-chat.test.ts`: a per-test incrementing `taskQueue`,
  `TestWorkflowEnvironment.createTimeSkipping()`, a `Worker` with
  `workflowsPath: require.resolve('@agentops/workflows')`, and a stubbed
  `PlatformActivities` cast `as unknown as PlatformActivities`. Reuse the same
  `withTestEnv` helper shape.
- The stub must implement the activities `platform()` calls:
  `prepareScratchWorkspace` (returns `{ workspaceRef: 'ws-1' }`), `runAgent`,
  `recordRunStats` (no-op), `resolveRepoConfig`, and `cleanupScratchWorkspace`.
- **Test 1 — regression (primary):** `runAgent` rejects with `new Error('AGENT_BOOM')`
  and `cleanupScratchWorkspace` rejects with `new Error('CLEANUP_BOOM')`. Start the
  workflow and assert `handle.result()` rejects with a message containing `AGENT_BOOM`
  (not `CLEANUP_BOOM`). This is the behavior that is currently broken and must go
  red before Step 2, green after.
  - Note: `runAgent` uses `retry: { maximumAttempts: 5 }`, so an always-rejecting stub
    exhausts retries before the failure propagates. Under time-skipping this is fast, but
    keep the per-test timeout generous (e.g. `30_000`) as the chat tests do.
- **Test 2 — cleanup surfaces on success:** `runAgent` resolves with an output string
  `PLATFORM_RESULT: {"summary":"ok","actionsTaken":[],"proposedFixes":[]}` (parseable,
  empty `proposedFixes` so no `executeChild`/`resolveRepoConfig` fan-out runs) plus the
  usual token/wall/backend fields; `cleanupScratchWorkspace` rejects with
  `new Error('CLEANUP_BOOM')`. Assert `handle.result()` rejects with `CLEANUP_BOOM` — the
  cleanup error is the only failure and must still surface.
- **Test 3 — happy path (guards return value):** `runAgent` resolves with the same
  parseable `PLATFORM_RESULT`, `cleanupScratchWorkspace` resolves. Assert the workflow
  resolves and `result.summary === 'ok'`. Guards against the new control flow accidentally
  swallowing the normal return.
- **Verification:** `pnpm --filter @agentops/workflows test platform.test.ts` (or the
  repo's standard `pnpm test`). Test 1 (and Test 2) must FAIL against the unmodified
  `platform.ts` — confirming the test reproduces the masking bug — then pass after Step 2.
  Run it once here to confirm red.

### Step 2 — Harden the cleanup in `packages/workflows/src/platform.ts`

- Add `log` to the existing `@temporalio/workflow` import:
  `import { executeChild, log, proxyActivities, workflowInfo } from '@temporalio/workflow';`
- Declare `let primaryError: unknown;` immediately before the existing `try` (line ~38).
- Add a `catch (err) { primaryError = err; throw err; }` between the `try` body and the
  `finally`.
- Replace the bare `finally` body (`await activities.cleanupScratchWorkspace(workspaceRef);`)
  with a nested guard:
  ```ts
  } finally {
    try {
      await activities.cleanupScratchWorkspace(workspaceRef);
    } catch (cleanupErr) {
      // A cleanup throw must never mask a real in-flight failure: on 2026-07-27 a
      // cleanupScratchWorkspace path-safety error replaced the underlying runAgent
      // failure for self-heal-2026-07-25T15:30:00Z-platform and misdirected the
      // investigation. Log the cleanup error, but re-throw it only when the body
      // succeeded (then it is the sole error); otherwise let primaryError propagate.
      log.error('cleanupScratchWorkspace failed', { taskId, error: cleanupErr });
      if (!primaryError) {
        throw cleanupErr;
      }
    }
  }
  ```
- Leave the rest of `platform()` (the `if (!payload)` early return, the fix fan-out,
  the final `PlatformAgentResultSchema.parse`) unchanged. The `finally` guarantee that
  the workspace is released on every path — including the `if (!payload)` early return —
  is preserved.
- **Verification:** `pnpm --filter @agentops/workflows test platform.test.ts` — all three
  tests green. Plus `pnpm typecheck` (the `unknown` `primaryError` and the `log` import
  must type-check).

### Step 3 — Clarifying comment in `packages/workflows/src/platform-chat.ts` (no behavior change)

- At the `await activities.cleanupScratchWorkspace(workspaceRef);` call (line ~267), extend
  the existing "Reached only on real close / idle timeout / done" comment (or add one line)
  to state explicitly that this call is deliberately **outside** any error/`finally` path,
  so there is no in-flight error for a cleanup throw to mask, and the `platform.ts`
  primary-error guard is intentionally **not** replicated here — future edits that move
  this into a `finally`/`catch` must add that guard.
- No code change; this is documentation only, so no new test.
- **Verification:** `pnpm typecheck` still passes (comment-only), and existing
  `platform-chat.test.ts` remains green.

### Step 4 — Full gate + verify

- **Verification:** run the repo definition-of-done gate:
  `pnpm lint && pnpm typecheck && pnpm test`. All green.
- Because `packages/workflows` is touched, run the e2e suite per AGENTS.md
  (`pnpm test:e2e` or the repo's documented e2e command) if it is runnable in this
  environment; if it cannot run here, record that in the PR description.
- Invoke the `verify` skill to exercise the changed workflow path end-to-end (the two new
  error-path tests are the observable behavior), confirming the original error now
  escapes on a failing run.

### Step 5 — Commit

- `git add packages/workflows/src/platform.ts packages/workflows/src/platform.test.ts packages/workflows/src/platform-chat.ts`
- Commit with a message describing the error-masking fix and referencing the incident
  (`self-heal-2026-07-25T15:30:00Z-platform`).

## Sequencing notes

- **Test before fix (Step 1 → Step 2).** The whole point of the change is a behavior that
  is hard to eyeball, so the test is the de-risking artifact: writing it first proves it
  reproduces the masking (goes red on the unmodified file) and then objectively confirms
  the fix. I deliberately did *not* write the fix first — a fix-first order would leave no
  proof the test can actually fail on the buggy code.
- **`platform-chat.ts` comment last (Step 3).** It is documentation-only and independent of
  the fix; it could be done at any point, but sequencing it after the real fix keeps the
  behavioral change and its test as one reviewable unit and avoids interleaving a no-op
  edit into the risky part.
- **Gate + verify after all edits (Step 4).** Lint/typecheck/test span all three files, so
  running the full gate once at the end is cheaper than per-step and still catches
  cross-file issues (e.g. the `log` import).

## Assumptions

- **How to record the cleanup failure:** use `log.error('cleanupScratchWorkspace failed',
  { taskId, error })` from `@temporalio/workflow` (confirmed exported:
  `index.d.ts` re-exports `log` from `./logs`). Rejected `recordRunStats` — it requires a
  full `RunStats` shape (stage/backend/model/token counts) that is meaningless for a
  cleanup failure, and it is itself a retrying activity inside the very failure path we are
  hardening. Matches the design's Assumptions section.
- **`platform-chat.ts` needs no behavior change.** Its cleanup call runs only after the
  `while` loop exits normally (close / idle timeout / `done`); it is not in a `finally`
  and not on a `catch` path, and `continueAsNew` unwinds before reaching it. No in-flight
  error exists there to mask, so a cleanup failure correctly surfaces as the sole error.
  Only a clarifying comment is added.
- **A new test file is correct** (there is no existing `platform.test.ts`; only
  `platform-chat.test.ts` and `self-heal.test.ts`). Harness style is copied from
  `platform-chat.test.ts`.
- **Success-path test payload uses empty `proposedFixes`** so the test exercises only the
  try/finally/cleanup control flow without pulling in `resolveRepoConfig`/`executeChild`
  fan-out, keeping the test focused on the hardened behavior.
- **`runAgent` retry behavior:** the always-rejecting `runAgent` stub in Test 1 will
  exhaust `maximumAttempts: 5` before the error propagates; time-skipping makes this fast,
  but per-test timeouts are kept at `30_000` to match the chat tests. If retry backoff
  makes the test slow/flaky, the stub can be left as-is (the propagated activity failure
  still carries the `AGENT_BOOM` cause) — no change to production retry config, which is
  out of scope.
- **No new contracts, stages, or status vocabulary** are introduced; this is control-flow
  hardening plus a determinism-safe log line, so the `packages/workflows` determinism
  boundary (AGENTS.md hard rule 1) is preserved.
