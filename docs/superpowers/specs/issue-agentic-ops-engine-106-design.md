# Design — issue-agentic-ops-engine-106: bughunt workflow creates duplicated issues

## Goal

The `whiteboxBugHunt` workflow runs on a nightly schedule (`nightly-bughunt`,
`0 2 * * *` in `agents.json`) and files a tracker issue per finding. It is
supposed to deduplicate: a bug found last night should not be filed again
tonight. In practice it re-files the same bug across runs, producing duplicate
issues. The goal is to make cross-run dedupe actually hold for a bug that
persists in the code, without introducing false-merges of genuinely distinct
bugs.

## Root cause

Dedupe works like this today:

1. `whiteboxBugHunt` (`packages/workflows/src/whitebox-bughunt.ts`) parses
   findings and, per finding, calls the `createIssue` activity with
   `dedupeFingerprint: findingFingerprint(f)`.
2. `createIssue` (`packages/activities/src/create-activities.ts:294`) looks the
   fingerprint up in the `FiledFindingStore` keyed by `(project, fingerprint)`.
   A hit returns `{ deduped: true }` and files nothing; a miss creates the issue
   and records the fingerprint.
3. `findingFingerprint` (`packages/policies/src/parse-findings.ts:22`) is
   `sha256(`${location}::${title}`.toLowerCase().replace(/\s+/g,' ').trim())`.

The store and the lookup are correct. The **fingerprint is unstable across
runs**, so the same underlying bug hashes differently each night and the lookup
misses:

- `location` carries a line number by contract (`WhiteboxFindingSchema`
  documents it as `"src/db.ts:42"`). Any edit above the bug — including edits
  from *other* PRs the engine itself merges — shifts that line number, so
  `src/db.ts:42` becomes `src/db.ts:57` and the hash changes even though the
  bug and the file are identical.
- To a lesser degree, LLM title wording drifts between runs; case and
  whitespace are already normalized, but word-level rephrasing is not.

Line-number drift is the deterministic, every-code-change driver of the
duplicates and is the primary target of this change.

## Approaches considered

### A. Stabilize the fingerprint (normalize `location`, keep normalized title)
Change `findingFingerprint` to strip the `:line[:col]` / `:startLine-endLine`
suffix from `location` before hashing, so the fingerprint is derived from the
file path + normalized title. The dedupe machinery (store, activity, workflow)
is untouched.

- **Trade-off:** Reduces granularity within a file — the fingerprint no longer
  distinguishes two findings that share the same file path *and* a title that
  normalizes to the same string. That collision is narrow (identical file +
  effectively identical title) and, when it happens, dedupe is the desired
  outcome anyway. Word-level title drift can still cause a miss; this shrinks
  the duplicate surface to that residual case rather than eliminating it.
- **Cost:** Small. One pure function + its tests. No contract, port, or
  activity change.

### B. Reconcile against the tracker before filing (search existing issues)
Before creating, query the tracker for an open issue with a matching
title/label and skip if found, instead of (or in addition to) the store lookup.

- **Trade-off:** Makes dedupe robust even when the store is empty, but requires
  a new `search`/`findByTitle` capability on `TrackerPort` (touching
  `ports/`, both the GitHub and Linear adapters, and `contracts`), adds a
  tracker API call per finding, and still misses on title drift unless we add
  fuzzy matching. Larger blast radius across the vendor boundary for a problem
  whose dominant cause (line numbers) is cheaper to fix directly.
- **Cost:** High relative to the payoff.

### C. Fingerprint fix + harden the in-memory store fallback
`buildFiledFindingStore` (`packages/worker/src/main.ts:320`) silently returns an
`InMemoryFiledFindingStore` when `ENGINE_DB_HOST` is unset; that store resets
every worker restart, disabling cross-run dedupe entirely. Combine Approach A
with making that fallback loud (log a warning / refuse to run bughunt without a
persistent store).

- **Trade-off:** Addresses a second, orthogonal duplicate source, but bundles a
  deployment/wiring behavior change with the fingerprint fix — two concerns in
  one PR, and the fallback change risks breaking local/test setups that rely on
  the in-memory store.
- **Cost:** Medium, and mixes scopes.

## Chosen approach

**Approach A** — stabilize `findingFingerprint` by normalizing `location`.

Why it wins:

- It targets the deterministic root cause. Line-number drift fires on *every*
  code change to a scanned file; it is the mechanism that turns a nightly
  re-scan of a persistent bug into a duplicate. Fixing the hash input fixes the
  duplicates at their source.
- It is minimal and stays inside the pure `policies` package — no contract,
  port, vendor, or activity surface changes, so it is easy to reason about and
  test exhaustively (Hard rule 2).
- **B** was rejected because it pushes changes across the vendor/port boundary
  (Hard rule 4) and adds per-finding API calls for a problem the fingerprint
  fix already resolves for the common case; a tracker-search fallback is a
  reasonable *future* hardening, not required here.
- **C** was rejected for scope: the in-memory-fallback hardening is a real but
  separate issue (store availability, not fingerprint identity) and bundling it
  would make this PR two changes. It is noted below as a follow-up.

## Design

Single-package change, plus its tests.

### `packages/policies/src/parse-findings.ts`
Rework `findingFingerprint` so the hash input is location-path + normalized
title:

- Normalize `location`: strip a trailing position suffix — `:<n>`, `:<n>:<n>`,
  or `:<n>-<n>` — leaving the file path (`src/db.ts:42` → `src/db.ts`,
  `src/db.ts:42-50` → `src/db.ts`, `src/db.ts` → unchanged). Only strip a
  purely-numeric trailing segment so paths that legitimately contain a colon
  are not mangled.
- Keep the existing lowercase + whitespace-collapse + trim normalization,
  applied to the `path::title` composite so title case/whitespace drift stays
  covered as it is today.
- Continue to exclude `detail` and `severity` from the hash (already the case)
  so re-worded detail or a re-classified severity does not defeat dedupe.

The function stays pure, synchronous, and total (no throw path added).

### `packages/policies/src/parse-findings.test.ts`
This is a behavior change in the "battle-tested" `policies` package, so per
Hard rule 2 the existing test is updated and the PR description must carry a
note explaining the semantic is safe (dedupe becomes *more* likely to fire for
the same file+title; it never files a *new* duplicate it would have merged
before). Test additions:

- Fingerprint is invariant to line-number changes:
  `findingFingerprint({...f, location: 'src/a.ts:1'})` equals the value for
  `'src/a.ts:42'` and for a range `'src/a.ts:42-50'`.
- Fingerprint still differs for different file paths with the same title.
- Fingerprint still differs for different titles at the same path (dedupe is
  not made trivially coarse).
- Existing invariants retained: `detail` does not affect the fingerprint; case
  and whitespace in the title do not affect it.

### Data flow / error handling
No change to the store, the `createIssue` activity, the workflow, or any
contract/port. Existing entries in the Postgres `filed_findings` table remain
valid rows; they were written under the old hash, so the first nightly run
after deploy re-files each still-present bug once under the new stable hash and
records it — from then on dedupe holds. This one-time re-file is expected and
acceptable (it is bounded to one run and strictly better thereafter); it is
called out here so a reviewer is not surprised by a small duplicate blip on the
deploy night.

## Assumptions

- **`location` format.** Assumed to be `path[:line[:col]]` or
  `path:startLine-endLine`, matching the schema's documented `"src/db.ts:42"`
  example. Normalization strips only a trailing numeric/`n-n` segment after a
  colon; any other shape is left untouched (still hashed, just not normalized),
  so a surprising format degrades to today's behavior rather than breaking.
- **Same-file/same-title collisions are acceptable dedupe.** Two findings with
  the same file path and titles that normalize identically are treated as the
  same finding. Assumed correct: distinct bugs in one file almost always carry
  distinct titles, and when they don't, merging is the safer error than
  spamming duplicates.
- **Scope excludes the in-memory-store fallback and tracker reconciliation.**
  The in-memory `FiledFindingStore` fallback (`ENGINE_DB_HOST` unset) also
  breaks cross-run dedupe, and the store is never reconciled against the live
  tracker. Assumed out of scope for this issue and left as a follow-up, because
  the reported duplicates are explained by fingerprint drift and folding either
  in would bundle a second concern into this PR.
- **A one-time re-file on the deploy night is acceptable.** Rather than
  backfilling/rehashing existing `filed_findings` rows, the store self-heals on
  the next run. Assumed acceptable given the bounded, one-run cost.

## Self-review

- No placeholders or TBDs.
- No section contradicts another; the chosen approach's rejections match the
  approaches list.
- Scoped to one coherent change: stabilizing the finding fingerprint (function +
  tests in `packages/policies`). Adjacent duplicate sources (store fallback,
  tracker reconciliation) are explicitly deferred, not silently folded in.

## Brainstorm Summary
**Approaches considered:** (A) stabilize `findingFingerprint` by stripping the line-number suffix from `location`; (B) reconcile against the tracker by searching existing issues before filing; (C) the fingerprint fix plus hardening the silent in-memory store fallback.
**Chosen approach:** (A) — normalize `location` to its file path (drop `:line[:col]` / `:n-n`) so the dedupe fingerprint is stable across code churn.
**Why (decisive reasons):** Line-number drift is the deterministic, every-code-change cause of the duplicates; fixing the hash input resolves the common case with a minimal, pure change confined to `packages/policies`. B crosses the vendor/port boundary and adds per-finding API calls for little extra gain; C bundles an orthogonal store-fallback change.
**Key risks/assumptions:** Same file-path + same normalized title now dedupe together (intended); word-level title drift can still cause a miss (residual, not regressed); one-time re-file on deploy night as old-hash rows self-heal; in-memory-store fallback and tracker reconciliation deferred as follow-ups.
