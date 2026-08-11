# Plan — Task self-heal-2026-08-11t19-00-00z-platform-fix-1

Broaden account-wide Claude quota-cap detection so the CLI's weekly-limit message
("You've hit your weekly limit · resets <time> (UTC)") is classified as `SessionLimitError`,
exactly like the existing session-limit case. Follows the chosen approach in
`docs/superpowers/specs/self-heal-2026-08-11t19-00-00z-platform-fix-1-design.md` (Approach 1:
broaden the shared `isSessionLimitMessage` matcher; no new error type; keep the helper name).

## Steps

### Step 1 — Broaden the matcher in `provider-rate-limit.ts` (the only logic change)
- File: `packages/backends/src/provider-rate-limit.ts`
- Change `isSessionLimitMessage`'s first test from `/session limit/i` to `/(session|weekly) limit/i`,
  keeping the mandatory `&& /\breset/i` guard unchanged.
- Refresh two comments so the code reads truthfully:
  - the `SessionLimitError` class comment: note it now covers both the "session limit" and
    "weekly limit" CLI phrasings (both account-wide, last hours/days).
  - the `isSessionLimitMessage` function: state it matches either cap phrasing plus a reset phrase,
    and preserve the "narrow on purpose" note (a `(session|weekly)` alternation, not a catch-all).
- Verify: `pnpm --filter @agentops/backends test provider-rate-limit` — existing session-limit and
  rate-limit cases must stay green after the regex edit (regression guard for this step).
  (Package filter name confirmed at implementation time from `packages/backends/package.json`.)

### Step 2 — Add unit regression tests for the weekly phrasing
- File: `packages/backends/src/provider-rate-limit.test.ts`
- In the existing `isSessionLimitMessage` describe block, add:
  - `"You've hit your weekly limit · resets 9:30am (UTC)"` → `true` (real weekly phrasing).
  - a weekly-limit variant with an explicit reset timestamp
    (`'weekly limit reached. resets at 2026-08-18T09:30:00Z'`) → `true`.
  - negative guard: `'weekly limit exceeded, contact support'` (no reset phrase) → `false`,
    mirroring the existing session-limit negative case, locking in the narrow-on-purpose behavior.
- Verify: `pnpm --filter @agentops/backends test provider-rate-limit` — all new + existing assertions green.

### Step 3 — Truthful comment in `claude-backend.ts` (comment-only, no logic change)
- File: `packages/backends/src/claude/claude-backend.ts` (the `is_error` branch, ~line 144-150)
- The branch already calls `isSessionLimitMessage(...)` → `throw new SessionLimitError(...)`; no code
  change. Update the inline comment (currently cites only "session limit · resets") to also mention
  the weekly-limit phrasing, so the branch documents both caps it now catches.
- Verify: `pnpm --filter @agentops/backends typecheck` — comment-only edit compiles; nothing to run.

### Step 4 — Add end-to-end classification test in `claude-backend.test.ts`
- File: `packages/backends/src/claude/claude-backend.test.ts` (alongside the session-limit test, ~line 229)
- Add a case: an `is_error: true` stream-JSON result carrying
  `"You've hit your weekly limit · resets 9:30am (UTC)"` → `backend.run(...)` throws `SessionLimitError`
  and not `ClaudeBackendProcessError`, mirroring the existing session-limit test structure exactly.
  This proves the fix end-to-end through `parseOutput`, not just the isolated regex.
- Verify: `pnpm --filter @agentops/backends test claude-backend` — new + existing cases green.

### Step 5 — Full definition-of-done gate
- Verify: `pnpm lint && pnpm typecheck && pnpm test` from the repo root, all green.
- e2e (`pnpm e2e`) applies per AGENTS.md because this touches `backends`; run it and confirm green.
  If the e2e harness needs credentials/services unavailable in this environment, record that it was
  unrunnable here and rely on the unit + backend suites, which fully cover the reclassification.

## Sequencing notes

- **Logic before tests (Steps 1 → 2).** The design is a one-line regex broadening whose whole risk
  is "did I break the existing session-limit / rate-limit matches?" Making the production edit first,
  then immediately running the existing suite, surfaces any regression before I add new assertions.
  I could have written the new failing tests first (strict TDD); I didn't because the existing test
  file already pins the behavior I must preserve, so it doubles as the red/green guard, and the new
  assertions are additive rather than driving a design I don't yet have.
- **Unit before end-to-end (Steps 2 → 4).** Step 2 pins the matcher in isolation; Step 4 proves the
  wiring through `parseOutput`. If Step 4 fails while Step 2 passes, the fault is in the backend
  branch/comment edit, not the regex — a cleaner failure signal than testing only end-to-end.
- **Comment touch (Step 3) is deliberately its own step** to keep the goal's named file
  (`claude-backend.ts`) explicitly accounted for, even though it carries no behavior change.
- **Full gate last (Step 5)** because AGENTS.md's definition of done requires
  `pnpm lint && pnpm typecheck && pnpm test` (+ e2e for backends changes) to pass as a whole.

## Assumptions

- **Weekly-variant reset-timestamp fixture.** The design calls for "a weekly-limit variant with an
  explicit reset timestamp" without giving exact text. I use
  `'weekly limit reached. resets at 2026-08-18T09:30:00Z'`, mirroring the existing session-limit
  timestamp test so the two caps are covered symmetrically.
- **Negative-guard wording.** For the "no reset phrase" negative case I use
  `'weekly limit exceeded, contact support'`, directly paralleling the existing
  `'session limit exceeded, contact support'` case, to lock the narrow-on-purpose guard for weekly too.
- **Helper name unchanged.** Per the design I keep `isSessionLimitMessage` (no rename), updating only
  comments — a rename would ripple through `claude-backend.ts`, `pi-backend.ts`, and their imports for
  cosmetic gain and widen the diff beyond the one coherent concern.
- **e2e may be unrunnable in this sandbox.** If `pnpm e2e` requires unavailable credentials/services,
  I will record that rather than claim it passed; the unit + backend suites cover the reclassification
  path, which is the entirety of the behavioral change.
- **Package filter name.** I assume the backends package's pnpm name is `@agentops/backends`; if the
  actual `name` in `packages/backends/package.json` differs, I use that value for the `--filter` flag.
