# Design — self-heal-2026-07-14t03-30-00z-platform-fix-1

## Problem

`packages/workflows/src/dev-cycle.ts` (~line 397) passes `title: input.goal`
verbatim to `activities.openPr`. GitHub rejects PR titles longer than 256
characters, so `openPr` fails deterministically and the activity exhausts its
retries (`RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED`) whenever a devCycle goal is
long. This blocks an otherwise-complete, verified fix on a prior branch from
ever landing. The full goal text is already preserved in the PR body via
`buildRichPrBody`, so only the *title* needs to be bounded.

## Constraints

- **Determinism boundary** (AGENTS.md rule 1): the fix lives in
  `packages/workflows`, so it may only use pure, workflow-safe string operations
  — no I/O, no `Date.now()`/`Math.random()`, no activity imports. Plain string
  slicing satisfies this.
- The PR body (`buildRichPrBody`) must stay unchanged; it retains the full goal.
- GitHub's hard limit is 256 characters; we target a safe cap at/under 256.

## Candidate approaches

### A. Inline truncation at the `openPr` call site
Replace `title: input.goal` with an inline `input.goal.slice(...)` expression.
- **Pros:** smallest diff.
- **Cons:** logic is not independently testable, mixes formatting concerns into
  the call site, and duplicates intent if a title is ever needed elsewhere. The
  regression test would have to drive the whole workflow just to observe a
  string slice.

### B. Local pure helper `buildPrTitle(goal)` in dev-cycle.ts (recommended)
Add a small pure function beside the existing `buildRichPrBody` that derives a
bounded title from the goal; call it where `title:` is set.
- **Pros:** cohesive — title derivation sits next to body derivation, both
  building the PR from the goal. Easy to unit-test directly and to assert
  through the existing workflow test. No cross-package churn.
- **Cons:** one more local function (trivial).

### C. Pure helper in `packages/policies` with dedicated unit tests
Put the title-derivation function in the pure `policies` package.
- **Pros:** first-class unit tests in the package built for pure functions.
- **Cons:** `policies` encodes repair-loop / verdict / brake / babysit
  *semantics*, not PR string formatting — this would dilute that package's
  purpose and add cross-package wiring for a single-use presentation helper.
  Over-engineered for the scope.

## Recommendation

**Approach B.** It keeps the change to a single file and a single coherent
concern (constructing the PR from the goal), is directly unit-testable, and
avoids polluting `policies`. A is rejected for poor testability/cohesion; C is
rejected as over-engineering that misuses the `policies` package.

## What will change

- **`packages/workflows/src/dev-cycle.ts`**
  - Add a pure helper `buildPrTitle(goal: string): string`:
    - If `goal` is within the cap, return it unchanged (common case).
    - Otherwise truncate to a safe length and append a single-character ellipsis
      `…`, preferring to cut at the last whitespace before the cap so the title
      doesn't end mid-word (falling back to a hard cut when there's no nearby
      space). Total length stays `<= 256`.
  - Also collapse/trim so a multi-line goal yields a single-line title (take the
    first line / trim), since PR titles are single-line; the full multi-line
    goal remains in the body.
  - Use `buildPrTitle(input.goal)` in place of `title: input.goal` at the
    `activities.openPr` call. Define the cap as a named constant
    (e.g. `MAX_PR_TITLE_LENGTH = 256`).
- **`packages/workflows/src/dev-cycle.test.ts`**
  - Add a regression test that runs the workflow with a very long
    `input.goal` (well over 256 chars) and asserts `openPr` was called with a
    `title` whose length is `<= 256`. Keep existing label tests passing.

No contract, port, activity, or `policies` changes. `buildRichPrBody` is
untouched.

## Assumptions

- **Cap value:** GitHub's documented PR-title limit is 256 characters; I cap at
  256 (inclusive) counting the ellipsis, rather than a lower "safe" number, to
  preserve as much of the goal as possible while staying valid.
- **Ellipsis character:** use the single-char `…` (U+2026) so it costs one
  character against the cap; length is measured in JS string `.length` (UTF-16
  code units), which is what GitHub's limit is effectively counted against for
  the ASCII-dominant goals seen here. Edge cases with astral characters near the
  boundary are not worth special-casing for this fix.
- **Word-boundary truncation is a nicety, not a requirement:** if no whitespace
  exists in the truncation window, a hard cut is acceptable.
- **Multi-line goals:** collapse to the first line/trimmed single line for the
  title; the body already carries the complete goal, so no information is lost.
- **No new prompt/contract needed:** this is presentation logic on an existing
  field, not a new data shape, so `contracts` and `packages/prompts` are
  untouched.

## Self-review

- No placeholders; all touched files and the constant are named.
- No contradictions: body handling is explicitly unchanged; only the title is
  bounded.
- Scope is one coherent change: derive a length-safe PR title from the goal,
  plus its regression test.

## Brainstorm Summary
**Approaches considered:** (A) inline truncation at the openPr call site, (B) a local pure `buildPrTitle` helper in dev-cycle.ts next to `buildRichPrBody`, (C) a pure helper moved into `packages/policies` with its own unit tests.
**Chosen approach:** (B) a local pure `buildPrTitle(goal)` helper used where the `openPr` title is set.
**Why (decisive reasons):** Keeps the fix in one file and one concern (building the PR from the goal), is directly unit-testable, and stays within the workflow determinism boundary using pure string ops. A hurts testability/cohesion; C misuses `policies` (repair/verdict/brake semantics, not string formatting) and adds needless cross-package churn.
**Key risks/assumptions:** Cap at 256 chars (GitHub's limit) with a single-char `…` ellipsis, prefer cutting on a word boundary, collapse multi-line goals to one line; the full goal stays in the PR body via `buildRichPrBody` (unchanged).
