# Plan — self-heal-2026-07-14t03-30-00z-platform-fix-1

Implements design `docs/superpowers/specs/self-heal-2026-07-14t03-30-00z-platform-fix-1-design.md`
(Approach B: a local pure `buildPrTitle(goal)` helper in `dev-cycle.ts`).

## Summary

`packages/workflows/src/dev-cycle.ts:397` passes `title: input.goal` verbatim to
`activities.openPr`. GitHub rejects PR titles > 256 chars, so `openPr` fails
deterministically and exhausts its retries (`RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED`)
for any long goal. Fix: derive a length-bounded, single-line title from the goal via
a new pure helper; leave the full goal in the PR body (`buildRichPrBody`, unchanged).

## Steps

### Step 1 — Add the pure `buildPrTitle` helper and `MAX_PR_TITLE_LENGTH` constant

**File:** `packages/workflows/src/dev-cycle.ts`

- Add a module-level constant `const MAX_PR_TITLE_LENGTH = 256;` near the other
  top-level constants (around `MAX_VERDICT_CALLS`).
- Add a pure function `buildPrTitle(goal: string): string` beside `buildRichPrBody`
  (the file's other PR-construction helper). Behavior:
  1. Take the first line of `goal` (split on `\r?\n`, take index 0) and `.trim()`
     it, so a multi-line goal collapses to a single-line title. The full multi-line
     goal remains in the body.
  2. If the resulting single line's `.length <= MAX_PR_TITLE_LENGTH`, return it
     unchanged (common case — the existing short-goal tests must keep passing).
  3. Otherwise truncate: reserve one char for the ellipsis `…` (U+2026), so slice to
     `MAX_PR_TITLE_LENGTH - 1`. Prefer cutting at the last whitespace within that
     window (`lastIndexOf(' ')`); if a space is found at a reasonable position, cut
     there, else hard-cut at `MAX_PR_TITLE_LENGTH - 1`. Append `…`. Guarantee the
     returned length is always `<= MAX_PR_TITLE_LENGTH`.
- Uses only pure string ops — no I/O, no `Date.now()`/`Math.random()`, no activity
  imports — so it stays within the workflow determinism boundary (AGENTS.md rule 1).

**Verify:**
- `pnpm --filter @agentops/workflows typecheck` (or repo-root `pnpm typecheck`)
  compiles with no `any` and no unused-symbol errors. (The helper is exercised for
  real in Step 2; the regression test in Step 3 asserts its effect.)

### Step 2 — Use `buildPrTitle(input.goal)` at the `openPr` call site

**File:** `packages/workflows/src/dev-cycle.ts` (~line 397)

- Replace `title: input.goal,` with `title: buildPrTitle(input.goal),` in the
  `activities.openPr({ ... })` call. Nothing else in the call changes; `body: prBody`
  (built from the full goal) is untouched.

**Verify:**
- `pnpm typecheck` stays green.
- `pnpm --filter @agentops/workflows test` — existing tests
  ("stamps agent:working…", "passes issue labels to openPr", "does not pass
  labels…") still pass, confirming short goals (`goal: 'fix'`) pass through
  unchanged.

### Step 3 — Add the regression test

**File:** `packages/workflows/src/dev-cycle.test.ts`

- Add a test in the existing `describe('devCycle …')` block (or a new
  `describe('devCycle PR title length')`) that:
  1. Builds a `goal` well over 256 chars (e.g. `'x '.repeat(300)` or a long
     sentence repeated) and runs `devCycle({ ... goal, config })` with the existing
     mocked activities.
  2. Asserts `openPr` was called and reads the `title` from the mock's call args:
     `const call = vi.mocked(openPr).mock.calls.at(-1)?.[0];`
     `expect(call.title.length).toBeLessThanOrEqual(256);`
  3. Additionally asserts the title is non-empty and, since the goal is truncated,
     ends with `…` (guards against a silently-empty or full-length title).
- Optionally add a second assertion that a short goal is passed through verbatim
  (`title === goal`) to lock in the common-case behavior, if not already covered by
  existing tests.

**Verify:**
- `pnpm --filter @agentops/workflows test` — the new test passes and all prior
  tests remain green.

### Step 4 — Full green gate

**Files:** none (verification only)

**Verify (AGENTS.md Definition of Done):**
- `pnpm lint` — clean.
- `pnpm typecheck` — clean.
- `pnpm test` — all packages green.
- `pnpm e2e` — run because the change touches `packages/workflows`; must pass. If the
  e2e harness is unavailable in this environment, record that it was skipped and why,
  and rely on the unit + typecheck gates (the change is a pure, workflow-safe string
  helper with no activity/contract surface).

## Sequencing notes

- **Step 1 before Step 2**: the helper must exist before the call site references it,
  or typecheck fails. These are genuinely separate (define vs. use) but could be done
  in one edit; kept split so a compile error localizes to the definition.
- **Helper + call site (Steps 1–2) before the test (Step 3)**: the regression test
  drives the whole `devCycle` workflow and asserts on `openPr`'s title, so it only
  passes once the fix is in place. Writing it first would just be a red test with no
  intermediate value in an unattended run.
- **Could reorder?** One could write the failing test first (TDD). Not chosen here
  because the fix is a tiny, well-understood pure function and the existing suite
  already provides the harness; a red-first step adds a cycle without reducing risk.
- The whole change is confined to one source file + one test file, one package
  (`@agentops/workflows`) — no contract, port, activity, prompt, or `policies` churn,
  so no cross-package ordering concerns.

## Assumptions

- **Cap = 256 inclusive.** Following the design, cap at GitHub's documented limit
  (256) counting the `…`, rather than a lower "safe" number, to preserve as much of
  the goal as possible while staying valid.
- **Ellipsis is single-char `…` (U+2026)**, measured in JS `.length` (UTF-16 code
  units). Astral-character edge cases exactly at the boundary are not special-cased
  (design assumption); goals here are ASCII-dominant.
- **Word-boundary cut is best-effort.** If no whitespace exists in the truncation
  window, a hard cut is acceptable. I use `lastIndexOf(' ')` within the reserved
  window and fall back to a hard cut when the found space is absent or too early
  (e.g. index <= 0), so a single very long token still yields a valid title.
- **Multi-line goals collapse to the first trimmed line** for the title; the body via
  `buildRichPrBody` still carries the complete goal, so no information is lost.
- **No contract/prompt change.** This is presentation logic on an existing field, so
  `contracts` and `packages/prompts` are untouched.
- **Test data generator uses a static string** (e.g. `'lorem '.repeat(...)`), not
  `Math.random()`, keeping the test deterministic.
- **e2e may be environment-gated.** If `pnpm e2e` cannot run in the unattended
  sandbox, it will be reported as skipped-with-reason rather than silently omitted;
  the unit + typecheck gates cover this pure change.

## Self-review

- Every step names a concrete verification (typecheck / package test / full gate).
- No step hides two: Step 1 is define-helper, Step 2 is use-it, Step 3 is the test,
  Step 4 is the aggregate gate — each independently checkable.
- Scope matches the design: one pure helper + call-site swap + one regression test,
  body handling explicitly unchanged.
