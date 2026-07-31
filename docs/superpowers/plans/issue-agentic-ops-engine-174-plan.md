# Plan — issue-agentic-ops-engine-174: Automated lint enforcement for the forge/tracker SDK ban (AGENTS.md rule 4)

Design: `docs/superpowers/specs/issue-agentic-ops-engine-174-design.md` (Approach A — a shared
`no-restricted-imports` SDK ban applied repo-wide, lifted only inside `packages/ports/src`, reusing
the existing `httpClientImports` idiom).

## Grounding facts (verified against the tree)

- `eslint.config.js` is flat-config. The **base block** (index 3, `{ plugins, settings, rules }`,
  **no `files` key**) applies to every file and today has *no* `no-restricted-imports` rule. It only
  sets `import/no-restricted-paths` (rules 1 & 2).
- Only two blocks set `no-restricted-imports` today, both scoped to workflows:
  - `packages/workflows/src/**/!(*.test).ts` → `['error', ...httpClientImports]`
  - `packages/workflows/src/**/*.test.ts` → **does not** set `no-restricted-imports` (tests are
    allowed to import `axios`; see `determinism-lint.test.ts` "should allow axios imports in test
    files"). It only sets `no-restricted-globals` / `no-restricted-properties`.
- Flat-config **replaces** (does not merge) a rule's options across matching blocks. So for a
  workflows source file, the base block's new SDK ban would be *overwritten* by the workflows block's
  `no-restricted-imports` unless that block concatenates both lists.
- The **only** current forge-SDK importer is `packages/ports/src/github/build-github-ports.ts`
  (`import { graphql } from '@octokit/graphql'` and `import { Octokit } from '@octokit/rest'`). It
  lives under `packages/ports/src/**`, so the single ports exemption covers it and `pnpm lint` stays
  green. `@octokit/*` are dependencies of `@agentops/ports` only.
- Linear uses a **raw facade** (`packages/ports/src/linear/linear-client.ts`), not `@linear/sdk`, so
  banning `@linear/sdk` is preventive and touches nothing today.
- Vitest picks up `packages/*/src/**/*.test.ts`, so a new test at
  `packages/ports/src/rule4-lint.test.ts` runs under `pnpm test` with `cwd = repoRoot`.

## Files changed, in order

### Step 1 — `eslint.config.js` (the only source change)

De-risking rationale: this is the change that all verification depends on, and it is where the one
non-obvious interaction (flat-config option replacement) lives. Do it first, in a single edit, so the
new test in Step 2 exercises the final config. There is no safe way to reorder Steps 1 and 2 — a test
written before the config would only assert the pre-change (broken) behavior.

Concrete edits:

1. **Add a shared `forgeTrackerSdkImports` object** near `httpClientImports` (top of file), shaped to
   the `no-restricted-imports` schema so it composes cleanly with `httpClientImports` (which is a
   flat array of `{ name, message }` = `paths` entries). Use:
   ```js
   // AGENTS.md rule 4 (ports, not vendors): forge/tracker SDKs may only be imported inside
   // packages/ports/src. Shared lists so blocks that must combine bans (see workflows below) don't
   // drift. NOTE: rule 4 also forbids "call their APIs" (raw fetch/GraphQL to a forge/tracker host)
   // and, outside backends/, "spawn an agent CLI". Neither is lint-enforced: both are runtime-string
   // concerns that would false-positive on the legitimate raw-GraphQL Linear facade inside ports/
   // and the node:child_process command runners inside activities/. They remain review-time rules.
   const forgeTrackerSdkPaths = [
     { name: 'octokit', message: 'Forge SDKs belong in packages/ports — AGENTS.md rule 4.' },
     { name: '@octokit/rest', message: 'Forge SDKs belong in packages/ports — AGENTS.md rule 4.' },
     { name: '@octokit/graphql', message: 'Forge SDKs belong in packages/ports — AGENTS.md rule 4.' },
     { name: '@linear/sdk', message: 'Tracker SDKs belong in packages/ports — AGENTS.md rule 4.' },
     { name: 'jira-client', message: 'Tracker SDKs belong in packages/ports — AGENTS.md rule 4.' },
     { name: 'jira.js', message: 'Tracker SDKs belong in packages/ports — AGENTS.md rule 4.' },
     { name: 'bitbucket', message: 'Forge SDKs belong in packages/ports — AGENTS.md rule 4.' },
   ];
   const forgeTrackerSdkPatterns = [
     { group: ['@octokit/*', '@gitbeaker/*'],
       message: 'Forge/tracker SDKs belong in packages/ports — AGENTS.md rule 4.' },
   ];
   ```
   (Keeping named `@octokit/rest` and `@octokit/graphql` in `paths` in addition to the `@octokit/*`
   pattern is belt-and-suspenders and gives an exact, greppable message on the two SDKs actually in
   the tree; `paths` and `patterns` coexist under one rule.)

2. **Base block** (the `{ plugins, settings, rules }` block with no `files` key): add repo-wide
   ```js
   'no-restricted-imports': ['error', { paths: forgeTrackerSdkPaths, patterns: forgeTrackerSdkPatterns }],
   ```
   This makes the ban apply everywhere by default.

3. **`packages/workflows/src/**/!(*.test).ts` block**: change its `no-restricted-imports` from
   `['error', ...httpClientImports]` to the object form that concatenates *both* bans, so the base
   block's replacement doesn't drop rule 1 or rule 4:
   ```js
   // Flat-config REPLACES (not merges) no-restricted-imports per matching block, so we must restate
   // the repo-wide rule-4 SDK ban alongside rule 1's http-client ban here or workflows loses one.
   'no-restricted-imports': ['error', {
     paths: [...httpClientImports, ...forgeTrackerSdkPaths],
     patterns: forgeTrackerSdkPatterns,
   }],
   ```
   (`httpClientImports` are `{ name, message }` = valid `paths` entries, so the merge is a plain
   array spread.)

4. **`packages/workflows/src/**/*.test.ts` block**: this block currently sets no
   `no-restricted-imports`, so it inherits the base block's rule-4 ban as-is — which is what we want
   (a workflows test importing a forge SDK *should* fail; the axios test-file exemption is a rule-1
   I/O-in-tests concern, not a vendor-coupling concern, per the design). **No change** to this block's
   `no-restricted-imports`; leaving it unset is deliberate and is asserted by a test in Step 2.

5. **Add a new override block** *after* the base block (order matters — later blocks win) that lifts
   the SDK ban inside ports:
   ```js
   {
     // AGENTS.md rule 4: packages/ports IS the sanctioned home for forge/tracker SDKs
     // (build-github-ports.ts imports @octokit/*). This is the single exemption to the repo-wide ban.
     files: ['packages/ports/src/**'],
     rules: { 'no-restricted-imports': 'off' },
   },
   ```
   Placement: put it immediately after the base block (before the ui/workflows/eslint blocks) or
   anywhere after the base block and after the workflows blocks — since ports files don't match the
   workflows globs, ordering vs. workflows is immaterial; ordering vs. the **base block** is what
   matters (must be later). I'll place it right after the base block for readability.

**Verification of Step 1:**
- `pnpm lint` — must stay green. The only forge-SDK importer is under `packages/ports/src/**` and is
  now exempt; if lint reports a rule-4 violation *outside* ports, that is a real pre-existing breach
  to report, not to suppress.
- Sanity spot-check with a throwaway file (removed after): create
  `packages/activities/src/__rule4_probe__.ts` containing `import { Octokit } from '@octokit/rest';`,
  run `pnpm eslint packages/activities/src/__rule4_probe__.ts`, confirm a `no-restricted-imports`
  error mentioning "AGENTS.md rule 4", then delete the probe. (This is just to de-risk before the
  formal test exists; the automated equivalent is Step 2.)

### Step 2 — `packages/ports/src/rule4-lint.test.ts` (new test)

Modeled on `packages/workflows/src/determinism-lint.test.ts`: `new ESLint({ cwd: process.cwd() })` +
`lintText` with a synthetic `filePath` per case, filtering `messages` by `ruleId ===
'no-restricted-imports'`. Cases:

1. **Banned outside ports** — `import { Octokit } from '@octokit/rest'` at
   `packages/activities/src/__lint_fixture__.ts` → exactly one `no-restricted-imports` error whose
   message contains `AGENTS.md rule 4`.
2. **Repo-wide coverage** — same import at `packages/gateway/src/__lint_fixture__.ts` → rejected.
3. **Ports exemption** — same import at `packages/ports/src/__lint_fixture__.ts` → **zero**
   `no-restricted-imports` errors.
4. **Scoped pattern** — `import { graphql } from '@octokit/graphql'` at
   `packages/activities/src/__lint_fixture__.ts` → rejected (proves `paths`/`patterns` catch the
   scoped family). Optionally add a `@gitbeaker/rest` case to prove the pattern alone (no `paths`
   entry) fires.
5. **False-positive guard** — `import { buildGithubPorts } from '@agentops/ports'` at
   `packages/gateway/src/__lint_fixture__.ts` → **zero** `no-restricted-imports` errors (the port
   facade is not a vendor SDK).
6. **Workflows regression — rule 4 kept** — `import { Octokit } from '@octokit/rest'` at
   `packages/workflows/src/__lint_fixture__.ts` → rejected (proves the workflows-block concatenation
   didn't drop rule 4).
7. **Workflows regression — rule 1 kept** — `import axios from 'axios'` at
   `packages/workflows/src/__lint_fixture__.ts` → still one `no-restricted-imports` error containing
   `AGENTS.md rule 1` / `Temporal activities` (proves the concatenation didn't clobber rule 1).
8. **Workflows test-file inherits rule 4** — `import { Octokit } from '@octokit/rest'` at
   `packages/workflows/src/__lint_fixture__.test.ts` → rejected (documents the deliberate decision
   that test files are NOT exempt from the SDK ban, unlike the axios/rule-1 exemption).

Each `it` gets a `30_000` timeout to match the existing lint test.

**Verification of Step 2:** `pnpm test` — the new file runs and all cases pass. Also re-run
`pnpm lint` (the new test file itself must lint clean) and `pnpm typecheck`.

### Step 3 — `AGENTS.md` (minimal doc touch)

Append a short parenthetical to rule 4 noting that the **SDK-import** half is now lint-enforced
(`eslint.config.js`, `no-restricted-imports`), while "call their APIs" and "spawn an agent CLI"
remain review-time rules. This keeps the doc honest per the "docs updated if design changed"
definition of done and mirrors how rules 1/2 are understood to be machine-enforced.

**Verification of Step 3:** manual read-back — the added clause is accurate (only the import half is
enforced) and does not over-claim. No command needed; it's prose.

## Final verification (whole change)

Run the full rule-6 gate from repo root:

```
pnpm lint && pnpm typecheck && pnpm test
```

All three must be green. `pnpm e2e` is **not** required: this change touches only lint config and a
lint test — no workflows, policies, activities, or backends runtime behavior changes (per the
AGENTS.md rule-6 e2e trigger).

## Commit

Two commits (or one), conventional-commit style, e.g.:
- `test: enforce AGENTS.md rule 4 forge/tracker SDK ban in eslint` (config + test)
- `docs: note rule 4 SDK-import ban is lint-enforced` (AGENTS.md)

## Assumptions (resolved autonomously; no reviewer available)

- **Only the SDK-import clause is lint-enforced.** The "call their APIs" and "spawn an agent CLI"
  clauses are not lexically decidable without false positives (the raw-GraphQL Linear facade inside
  `ports/`; the `node:child_process` command runners inside `activities/`). They stay review-time
  rules, documented via an in-config comment. Matches the design.
- **Banned list = curated allow-nothing, room to grow.** `octokit` / `@octokit/*` (present today),
  plus preventive `@linear/sdk`, `@gitbeaker/*`, `jira-client`, `jira.js`, `bitbucket`. Adding a
  vendor is a one-line edit to the shared const, mirroring `httpClientImports`.
- **Exemption is exactly `packages/ports/src/**`, tests included.** A test *outside* ports importing
  a vendor SDK is the coupling rule 4 forbids, so no test-wide exemption; ports' own tests live under
  `packages/ports/src/**` and are covered by the single override block. (Assumption forced by the
  design's "nothing outside ports/, full stop" reading of rule 4.)
- **Object form for `no-restricted-imports` everywhere it's set.** Because `httpClientImports` are
  `{ name, message }` entries they double as `paths` entries, so the workflows block can express both
  bans as `{ paths: [...http, ...sdk], patterns }` without restructuring the shared http list.
  Assumption: no other block needs `no-restricted-imports`; verified — only the two workflows blocks
  and (now) the base block set it, and the ports override turns it off.
- **Message wording** ends with `AGENTS.md rule 4.` to mirror the rule-1 messages and stay greppable.
- **No `e2e` run required.** Assumption grounded in AGENTS.md rule 6's own scoping (e2e only for
  workflows/policies/activities/backends changes); this change is lint-only.
