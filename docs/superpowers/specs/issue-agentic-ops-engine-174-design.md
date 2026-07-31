# Design — issue-agentic-ops-engine-174: Automated lint enforcement for the forge/tracker SDK ban (AGENTS.md rule 4)

## Goal

AGENTS.md rule 4 says: *"Nothing outside `ports/` may import a forge/tracker SDK or call their
APIs. Nothing outside `backends/` may spawn an agent CLI."* Today this is a review-time rule only —
nothing in CI stops a `feat:` PR from adding `import { Octokit } from '@octokit/rest'` inside
`packages/activities` or `packages/gateway`. The determinism boundary (rule 1) and the purity
boundary (rule 2) are both machine-enforced in `eslint.config.js`; rule 4 is the odd one out. This
change closes that gap for the part of rule 4 that a linter can actually decide: the **forge/tracker
SDK import ban**.

## Approaches considered

**A. Shared `no-restricted-imports` list applied repo-wide, disabled inside `packages/ports/src`.**
Mirror the existing `httpClientImports` pattern in `eslint.config.js`: define a
`forgeTrackerSdkImports` array of banned SDK package names (+ `patterns` for scoped families like
`@octokit/*`, `@gitbeaker/*`), attach it via `no-restricted-imports` on the base config block so it
applies everywhere, then add one override block for `packages/ports/src/**` that lifts the ban.
Trade-off: `no-restricted-imports` options are *replaced* (not merged) per matching flat-config
block, so the existing `packages/workflows` block — which already sets its own
`no-restricted-imports` (http clients) — must be updated to concatenate both lists or it silently
loses the SDK ban. Cost: ~15 lines of config + a lint test. Low complexity, matches established
convention exactly.

**B. `import/no-restricted-paths` zones.** This is what rule 1/2 use for *cross-package* boundaries.
Rejected on capability grounds: `no-restricted-paths` targets internal source paths (`from:
'./packages/…'`), not external npm module specifiers. It cannot name `@octokit/rest`, so it cannot
express "no vendor SDK outside ports." Wrong tool for a package-name ban.

**C. A custom ESLint plugin/rule** that inspects import sources against a registry and also attempts
to flag raw REST/GraphQL calls to forge/tracker hosts ("call their APIs"). Rejected as over-built:
authoring, testing, and versioning a bespoke rule is far heavier than the problem, and the
"call their APIs" half cannot be decided lexically anyway (a `fetch` to `api.github.com` is a
runtime string, and `LinearTrackerPort` legitimately talks to Linear's GraphQL endpoint from a raw
fetch facade inside `ports`). Precision gained does not justify the maintenance surface.

## Chosen approach

**Approach A.** It is the minimum change that actually enforces the named rule, and it reuses the
exact idiom the repo already trusts for rules 1 and 2 (shared const arrays feeding
`no-restricted-imports`, plus a targeted override block). B is rejected because
`import/no-restricted-paths` structurally can't match npm package names. C is rejected as
disproportionate and because its extra ambition (detecting raw API calls) targets a boundary that is
not lexically decidable and would produce false positives on the legitimate raw-API facade that
lives *inside* `ports`.

## Scope

This is **one coherent change**: enforce the forge/tracker **SDK import** ban via ESLint. I am
deliberately *not* enforcing the two other clauses of rule 4 by lint (see Assumptions for the
reasoning): "call their APIs" and "spawn an agent CLI" are not lexically decidable without false
positives against code that legitimately does those things inside `ports/` and `activities/`
respectively. They remain review-time rules. The change is scoped to lint config + its test; no
product behavior changes.

## Assumptions

- **Only the SDK-import clause is lint-enforced.** *Assumption:* the issue title ("Forge/tracker SDK
  ban") points at the import half, and that is the half a linter can decide deterministically. The
  "call their APIs" clause (raw `fetch`/GraphQL to a forge/tracker host) is a runtime-string concern
  and would false-positive on `packages/ports/src/linear/linear-client.ts`, which is a deliberate
  raw-GraphQL facade living *inside* `ports`. The "spawn an agent CLI" clause can't be distinguished
  from the legitimate `node:child_process` spawns in `packages/activities` (git / workspace command
  runners) by any lexical signal, so a blanket child-process ban would break activities. Both are
  left as review-time rules; I add a short comment in `eslint.config.js` recording *why* they are
  not linted, so a future reader doesn't assume rule 4 is fully covered.
- **Banned-SDK list is a curated allow-nothing list with room to grow.** *Assumption:* the concrete
  forge/tracker SDKs worth naming today are the GitHub Octokit family (`octokit`, `@octokit/*` — the
  only forge SDK actually present in the tree, used by `build-github-ports.ts`), plus forward-looking
  entries for likely trackers/forges the repo could adopt: `@linear/sdk` (Linear currently uses a
  raw facade, not the SDK, so this is preventive), `@gitbeaker/*` (GitLab), `jira-client` / `jira.js`
  (Jira), and `bitbucket`. The list is a shared const so adding a vendor is a one-line change,
  matching the `httpClientImports` precedent.
- **The ban applies to test files too, exempting only `packages/ports/src/**`.** *Assumption:* rule
  4 says "nothing outside ports/", full stop; a test outside `ports` importing a vendor SDK is
  exactly the coupling the rule prevents. Because `ports` tests live under `packages/ports/src/**`,
  the single ports override block already exempts them. (This differs from rule 1, which exempts
  `axios` in test files because I/O-in-tests is fine — a different concern from vendor coupling.)
- **Message format mirrors the existing rule-1 messages** ("… — AGENTS.md rule 4.") so failures are
  self-explaining and greppable, consistent with the determinism messages.

## Design

Components/files affected:

1. **`eslint.config.js`** (the only source change):
   - Add a shared `const forgeTrackerSdkImports` array near the existing `httpClientImports`
     declaration — objects `{ name, message }` for exact package names and a `patterns` entry
     (`{ group: ['@octokit/*', '@gitbeaker/*'], message: … }`) for scoped families. Each message
     ends with "AGENTS.md rule 4." and points at `packages/ports`.
   - In the **base config block** (the one with no `files` key), add
     `'no-restricted-imports': ['error', { paths: [...forgeTrackerSdkImports.paths], patterns: [...] }]`
     so the ban applies repo-wide. (Concretely: split the shared value into `paths`/`patterns`
     shape that `no-restricted-imports` expects, or keep two arrays — an implementation detail, not
     a design decision.)
   - Update the existing **`packages/workflows/src/**` block** and its **`*.test.ts` sibling** so
     their `no-restricted-imports` concatenate `httpClientImports` *and* the forge/tracker SDK
     entries — because flat-config replaces (does not merge) rule options per matching block, this
     is required to keep workflows covered by both rule 1 and rule 4. This is the one non-obvious
     interaction and is called out with a comment.
   - Add a new **override block `files: ['packages/ports/src/**']`** that sets
     `'no-restricted-imports': 'off'` (or re-scopes it to drop only the SDK entries). This is the
     single sanctioned exemption; `build-github-ports.ts` and future port implementations import
     their vendor SDK here legitimately.
   - Add a brief comment block documenting that the "call their APIs" and "spawn an agent CLI"
     clauses of rule 4 are enforced by review, not lint, and why.

2. **`packages/ports/src/rule4-lint.test.ts`** (new test, modeled on
   `packages/workflows/src/determinism-lint.test.ts`): uses `new ESLint({ cwd: repoRoot })` +
   `lintText` against synthetic fixtures to assert:
   - `import { Octokit } from '@octokit/rest'` in a fixture under `packages/activities/src/…`
     produces a `no-restricted-imports` error whose message contains "AGENTS.md rule 4".
   - the same import under `packages/gateway/src/…` is also rejected (proves repo-wide coverage).
   - the same import under `packages/ports/src/…` produces **no** such error (proves the exemption).
   - a scoped-pattern case (`@octokit/graphql`) is caught by the `patterns` entry.
   - a false-positive guard: importing `@agentops/ports` (the port facade) from
     `packages/gateway/src/…` is **not** flagged (only vendor SDKs are banned, not the port layer).
   - a workflows-block regression guard: a forge SDK import under `packages/workflows/src/…` is
     rejected (proves the concatenation in the workflows block didn't drop rule 4), and an `axios`
     import there still triggers rule 1 (proves rule 1 wasn't clobbered).

3. **`AGENTS.md`** (optional doc touch, no behavior change): note next to rule 4 that the SDK-import
   half is now lint-enforced, mirroring how rules 1/2 are understood to be enforced. Kept minimal.

Data flow / error handling: none at runtime — this is static analysis wired into the existing
`pnpm lint` gate (rule 6 of AGENTS.md). Verification is `pnpm lint` (must stay green: the only
current forge-SDK importer is `packages/ports/src/github/build-github-ports.ts`, which the exemption
covers) plus `pnpm test` for the new lint test. If `pnpm lint` surfaces an unexpected violation
outside `ports`, that is a real pre-existing rule-4 breach to be reported, not worked around.

## Brainstorm Summary
**Approaches considered:** (A) a shared `no-restricted-imports` SDK ban applied repo-wide and lifted only inside `packages/ports/src`, reusing the existing rule-1 idiom; (B) `import/no-restricted-paths` zones; (C) a custom ESLint plugin that also flags raw API calls.
**Chosen approach:** A.
**Why (decisive reasons):** B structurally can't match npm package names (it targets internal source paths); C is disproportionate and its raw-API detection isn't lexically decidable (it would false-positive on the legitimate raw-GraphQL Linear facade inside `ports`). A is the minimum change and matches how rules 1/2 are already enforced.
**Key risks/assumptions:** Only the *SDK-import* clause is lint-enforced — "call their APIs" and "spawn an agent CLI" stay review-time rules (not lexically decidable without false positives), documented in-config. Flat-config replaces rather than merges `no-restricted-imports`, so the `packages/workflows` block must concatenate the http-client and SDK lists or it silently loses one — covered by a regression test.
