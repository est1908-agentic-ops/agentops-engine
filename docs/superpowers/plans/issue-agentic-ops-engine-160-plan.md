# Plan — issue-agentic-ops-engine-160

**[bughunt] Determinism lint rule doesn't cover I/O imports in `packages/workflows`**

Implements design `docs/superpowers/specs/issue-agentic-ops-engine-160-design.md` (Approach B:
enable `import/no-nodejs-modules` for `packages/workflows/src`, plus the repo's first
determinism-rule regression test).

## Context (verified before planning)

- `eslint.config.js` is a single flat config; the workflows glob block
  (`files: ['packages/workflows/src/**/*.ts']`, currently lines 56–71) holds
  `no-restricted-globals` / `no-restricted-properties` and is where the new rule belongs. The
  `import` plugin is already registered at the top-level block (line 12), so no plugin wiring is
  needed.
- `eslint` (`^10.6.0`) and `eslint-plugin-import` (`^2.32.0`) are both root dependencies.
- Tests run under vitest; `vitest.config.ts` includes `packages/*/src/**/*.test.ts`, so a test at
  `packages/workflows/src/determinism-lint.test.ts` is auto-discovered by `pnpm test`.
- `packages/workflows/src` imports no Node core module today (checked the source list), so an
  empty `allow` list will not break the current build.

## Steps

### Step 1 — Add the lint rule to `eslint.config.js`

- **File:** `eslint.config.js`
- **Change:** In the existing `files: ['packages/workflows/src/**/*.ts']` block, add
  `'import/no-nodejs-modules': ['error', { allow: [] }]`. Because ESLint's core rules do not carry
  per-report custom messages for this rule, tie it to AGENTS.md rule #1 with a code comment
  directly above the rule entry (mirroring the style of the surrounding `message:` strings), noting
  the `allow` array is the reviewed escape hatch for a proven-safe deterministic built-in.
- **Verify:**
  1. `pnpm lint` — stays green (no existing workflow file imports Node core; this proves the change
     doesn't regress the current build). This is the primary safety check and must pass before
     proceeding.
  2. Ad-hoc probe (not committed): temporarily add `import fs from 'node:fs';` to any file under
     `packages/workflows/src`, run `pnpm lint`, confirm it now errors with `import/no-nodejs-modules`,
     then revert. Confirms the rule actually fires and that the `node:` prefix is caught by
     eslint-plugin-import 2.32.0 (the one assumption the design flagged as needing runtime
     confirmation). If the `node:` prefix is NOT caught, fall back per design: layer in a
     `no-restricted-imports` denylist as a supplement — but the committed regression test in Step 2
     will encode whichever behavior we land on.

### Step 2 — Add the regression test

- **File (new):** `packages/workflows/src/determinism-lint.test.ts`
- **Change:** A vitest test that uses ESLint's Node API against the real repo config:
  - Construct `new ESLint({ cwd: <repo root> })` (repo root resolved from `import.meta.url` /
    `process.cwd()` so the flat config and plugins load exactly as `pnpm lint` sees them).
  - Use `eslint.lintText(code, { filePath: '<repoRoot>/packages/workflows/src/__lint_fixture__.ts' })`
    so the workflows glob applies. The fixture path is virtual — no file is written to disk.
  - Assertions:
    - Case A: source with `import fs from 'node:fs';` reports ≥1 message whose `ruleId` is
      `import/no-nodejs-modules`.
    - Case B: source with bare `import fs from 'fs';` likewise reports the rule (both forms
      covered).
    - Case C (false-positive guard): source importing only `@temporalio/workflow` reports **no**
      `import/no-nodejs-modules` error.
  - Keep fixture sources minimal (a single import plus a trivial export so the file is valid TS) to
    avoid tripping unrelated rules; filter assertions on `ruleId === 'import/no-nodejs-modules'` so
    incidental messages from other rules don't make the test brittle.
- **Verify:**
  1. `pnpm test` — the new test passes and is discovered by the vitest glob.
  2. Confirm the test genuinely guards the rule: temporarily revert Step 1's rule addition, run
     `pnpm test`, confirm Cases A/B fail; restore Step 1. (Sanity that the test depends on the rule,
     not on some pre-existing behavior.)

### Step 3 — Full definition-of-done gate

- **Files:** none (verification only).
- **Verify:** Run the repo's green gate from AGENTS.md rule #6:
  `pnpm lint && pnpm typecheck && pnpm test`. `pnpm typecheck` must accept the new test file
  (correct ESLint API types / no `any`). e2e (`pnpm e2e`) is **not** required: this change touches
  only lint config and a lint test — no workflow, policy, activity, or backend runtime behavior
  changes. Note that explicitly in the PR description.

## Sequencing notes

- **Rule before test (Step 1 → Step 2).** The rule change is the de-risking step: `pnpm lint`
  staying green confirms the core assumption (no current workflow file imports Node core) and that
  the `node:` prefix is caught, which determines whether the design's fallback denylist is needed.
  The test in Step 2 is written to match the behavior confirmed in Step 1, so it must come second.
- **Could Step 2 come first (TDD-style)?** Yes — writing a failing test then making it pass is
  valid. I ordered rule-first because the design's one open runtime question (does the stock rule
  catch `node:`?) is answered fastest by a lint probe, and the answer shapes the test's exact
  assertions. Writing the test first would risk encoding an assertion the rule doesn't satisfy and
  then reworking it.
- Step 3 is last by definition — it gates the whole change.

## Assumptions

- **ESLint Node API shape in v10.** The `ESLint` class with `lintText(code, { filePath })` is the
  stable programmatic API and is exported from `eslint` in v10.6.0. If a v10 API detail differs
  during implementation (e.g. option naming), adjust the test's construction while keeping the same
  three assertions — the assertions, not the constructor call, are the contract.
- **Virtual fixture path over an on-disk file.** I use a non-existent `__lint_fixture__.ts` path
  passed to `lintText` rather than writing a temp file, so the test has no filesystem side effects
  and no cleanup. The path only needs to match the `packages/workflows/src/**/*.ts` glob for the
  rule to apply.
- **Scope is `packages/workflows` only.** `packages/policies` (rule #2) has the same latent gap;
  the design deliberately leaves it as a noted follow-up and this plan does not touch it.
- **No e2e run required.** Per Step 3 reasoning — the diff is lint-config + lint-test only, with no
  runtime surface in workflows/policies/activities/backends.
