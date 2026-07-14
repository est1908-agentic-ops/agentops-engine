# Plan — issue-agentic-ops-engine-106: bughunt workflow creates duplicated issues

Implements the design in
`docs/superpowers/specs/issue-agentic-ops-engine-106-design.md` (Approach A:
stabilize `findingFingerprint` by normalizing the `location` line/column suffix
out of the hash input). The change is confined to the pure `packages/policies`
package — no contract, port, vendor, activity, or workflow surface changes.

## Context (verified against the tree)

- `findingFingerprint` lives in `packages/policies/src/parse-findings.ts:22`:
  `sha256(`${f.location}::${f.title}`.toLowerCase().replace(/\s+/g,' ').trim())`.
- `sha256` is re-exported from `@agentops/contracts` (`sha256.ts` exports
  `sha256Hex as sha256`).
- Only caller is `packages/workflows/src/whitebox-bughunt.ts:42`
  (`dedupeFingerprint: findingFingerprint(f)`); it passes the string straight to
  the `createIssue` activity, which does the store lookup. No caller depends on
  the *value* of the hash, only that it is stable — so changing the hash input is
  safe as long as the function stays pure/total.
- `WhiteboxFinding.location` is a `z.string().min(1)` documented as
  `"src/db.ts:42"` (`packages/contracts/src/whitebox-finding.ts`).
- Existing tests: `packages/policies/src/parse-findings.test.ts` (one
  fingerprint invariant test — `detail` does not affect it).

## Steps

### Step 1 — Establish the baseline (de-risk first)
- **Files:** none (read-only).
- **What:** Run the existing policies tests so we know they pass before the
  change, and capture the current fingerprint semantics we must preserve.
- **Verify:** `pnpm --filter @agentops/policies test` is green (baseline).
- **Why first:** Confirms the harness works and the pre-change behavior is green,
  so any later red is attributable to our change, not a pre-existing break.

### Step 2 — Write the tests for the new fingerprint semantics (test-first)
- **File:** `packages/policies/src/parse-findings.test.ts`.
- **What:** Add/extend the `findingFingerprint` describe block to pin the new
  contract. New assertions:
  1. **Line-number invariance:** `findingFingerprint({...f, location:'src/a.ts:1'})`
     equals the value for `'src/a.ts:42'`, for `'src/a.ts:42:7'` (line:col), and
     for a range `'src/a.ts:42-50'`.
  2. **Path with no suffix is unchanged:** `location:'src/a.ts'` hashes the same
     as `'src/a.ts:42'` (the stripped form).
  3. **Different file paths, same title → different fingerprints** (dedupe not
     made trivially coarse).
  4. **Different titles, same path → different fingerprints.**
  5. **Retained invariants:** `detail` does not affect the fingerprint (existing);
     title case and internal whitespace do not affect it.
  6. **Non-numeric trailing segment is left intact** (degrade-to-old-behavior
     guard): a `location` whose trailing `:segment` is not purely numeric (e.g.
     `'src/a.ts:foo'`) is *not* stripped, so it still hashes distinctly from
     `'src/a.ts'`.
- **Verify:** `pnpm --filter @agentops/policies test` — the new tests **fail**
  (red) against the un-changed function, confirming they actually exercise the
  new behavior. (Tests 3–5 may already pass; 1, 2, 6 must fail pre-change.)

### Step 3 — Implement the location-normalizing fingerprint
- **File:** `packages/policies/src/parse-findings.ts`.
- **What:** Introduce a small pure helper to strip a trailing position suffix from
  `location` and feed the normalized path into the existing composite hash:
  - Strip a trailing `:<n>`, `:<n>:<n>`, or `:<n>-<n>` where each `<n>` is
    purely numeric — leaving the file path. Only strip when the trailing
    segment(s) after the last relevant colon are purely numeric / `n-n`; any other
    shape (e.g. `:foo`, a path with a non-numeric colon segment) is left
    untouched.
  - Keep the existing `.toLowerCase().replace(/\s+/g,' ').trim()` normalization,
    applied to the `` `${normalizedLocation}::${title}` `` composite so title
    case/whitespace drift stays covered exactly as today.
  - Continue to exclude `detail` and `severity` from the hash.
  - Function stays pure, synchronous, and total — no new throw path; a
    surprising `location` shape degrades to today's behavior.
  - Use an anchored, non-global RegExp built per call (no shared stateful
    `g`-flag regex), consistent with the file's existing per-call regex note.
- **Verify:** `pnpm --filter @agentops/policies test` — all tests from Step 2
  now pass (green).

### Step 4 — Repo-wide gates
- **Files:** none (validation only).
- **What:** Run the full required gates from AGENTS.md hard rule 6.
- **Verify (all must be green):**
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm e2e` — required because the change touches `packages/policies`
    (per hard rule 6, e2e is required for policies changes). If e2e cannot run
    in this environment, record that explicitly rather than skipping silently.

### Step 5 — PR description note (semantic-change requirement)
- **Files:** none in-tree (goes in the PR body / commit trailer).
- **What:** Per AGENTS.md hard rule 2, a behavior change in the battle-tested
  `policies` package requires a note explaining why the new semantic is safe.
  Draft the note: dedupe becomes *more* likely to fire for the same
  file-path + normalized title; it never files a *new* duplicate it would have
  merged before, and it never merges two findings that previously deduped
  separately in a harmful way (distinct bugs in a file carry distinct titles).
  Also call out the expected one-time re-file on deploy night as old-hash
  `filed_findings` rows self-heal under the new stable hash.
- **Verify:** Note is present in the PR description; cross-check it matches the
  design's "Data flow / error handling" and "Assumptions" sections.

## Sequencing notes

- **Baseline (Step 1) before tests (Step 2)** so a red result later is
  unambiguously ours.
- **Tests before implementation (Steps 2 → 3):** the whole change is a semantic
  shift in one pure function; writing the invariants first is the cheapest way to
  pin the exact behavior (line/col/range stripping, non-numeric guard) and to
  prove the fix actually changed something.
- **Could Steps 2 and 3 be merged?** No — keeping them separate is what lets the
  Step 2 verification (tests fail pre-change) demonstrate the tests are load-bearing.
- **Repo-wide gates (Step 4) after the package is green**, not before, to avoid
  paying full-suite cost on an incomplete change; the package-level test loop in
  Steps 2–3 is the fast inner loop.

## Assumptions

- **`location` format is `path[:line[:col]]` or `path:startLine-endLine`.** Matches
  the schema's documented `"src/db.ts:42"` example. Normalization strips only a
  trailing purely-numeric `:n`, `:n:n`, or `:n-n`; any other shape is hashed
  as-is (degrades to today's behavior). Resolved from the design's Assumptions —
  no schema change is made to enforce a stricter format.
- **Same file-path + same normalized title is acceptable dedupe.** Two findings
  that collapse to the same `path::title` are treated as the same finding. Taken
  as given by the design; the tests encode it as intended behavior, not a bug.
- **No backfill of existing `filed_findings` rows.** The store self-heals on the
  next nightly run (one-time re-file). No migration or rehash step is added; this
  is out of scope per the design.
- **In-memory store fallback and tracker reconciliation are out of scope.**
  Deferred as follow-ups per the design; not touched by this plan.
- **e2e availability.** Assumed runnable in the implementation environment. If it
  is not, the implementer records the limitation explicitly in the PR rather than
  marking the gate silently skipped.
