# Design — issue-agentic-ops-engine-175

## Goal

AGENTS.md **rule 2** states that `packages/policies` "stays pure — No Temporal imports, no I/O".
The repo's `eslint.config.js` enforces *part* of this: an `import/no-restricted-paths` zone stops
`packages/policies/src` from importing the internal workspace packages
(`activities`, `ports`, `backends`, `workflows`). But it does **not** stop a policy file from
importing the Temporal SDK directly (`@temporalio/workflow`, `@temporalio/common`, `@temporalio/*`).
The determinism block that bans I/O clients and Node core modules is scoped to
`packages/workflows/src/**` only, so policies has no equivalent guard.

Result: the "no Temporal imports" half of rule 2 is documentation-only — a contributor could add
`import { proxyActivities } from '@temporalio/workflow'` to a policy module and `pnpm lint` would
pass. This change closes that gap by making the Temporal-import ban lint-enforced, matching how
rule 1 is enforced for workflows.

## Approaches considered

### A. Extend the existing `import/no-restricted-paths` zone
Add `@temporalio/*` to the policies `from` list of the existing zone (lines 60–68).
- **Trade-off / why rejected:** `import/no-restricted-paths` matches **filesystem paths**, not
  npm package specifiers. Its `from` entries are resolved as directories relative to the config.
  It is the wrong mechanism for banning a node_modules package by name/scope and would not reliably
  match `@temporalio/*` specifiers. Mixing a package-name ban into a path-based rule is also
  confusing for the next reader.

### B. Add a dedicated `no-restricted-imports` block for `packages/policies/src` (recommended)
Add a new flat-config block keyed on `files: ['packages/policies/src/**/*.ts']` that sets
`no-restricted-imports` with a `patterns` entry banning `@temporalio/*` (and, symmetrically to
the workflows block, reuse the shared `httpClientImports` list and ban Node core via
`import/no-nodejs-modules`). This mirrors the structure already used for the workflows determinism
block, keeping the two hard-rule enforcements visually parallel.
- **Trade-off:** Slightly more config than the minimum, but it enforces rule 2 fully ("no Temporal
  imports, **no I/O**") instead of only the Temporal half, and reuses existing shared arrays so
  there is no new drift surface.

### C. Custom local ESLint rule / dependency-cruiser
Write a bespoke rule (or add `dependency-cruiser`) to assert package purity.
- **Trade-off / why rejected:** Heavyweight for a one-package, one-scope ban. Adds a new dev
  dependency and a new config surface the repo doesn't currently use. `no-restricted-imports`
  already expresses this cleanly.

## Chosen approach

**Approach B.** It uses the ESLint mechanism actually designed for banning package specifiers
(`no-restricted-imports` with gitignore-style `patterns`), it is the same shape as the existing
workflows determinism block so the config stays internally consistent, and it lets us enforce the
whole of rule 2 (Temporal **and** I/O) rather than the Temporal clause alone. A is rejected because
`import/no-restricted-paths` cannot reliably match an npm scope; C is rejected as
disproportionate tooling for a single ban.

## Assumptions

- **Scope of the ban includes I/O, not just Temporal.** The issue title names the Temporal-import
  ban specifically, but rule 2 reads "no Temporal imports, no I/O" as one sentence, and the parallel
  workflows block already bans HTTP clients + Node core. I assume enforcing the full sentence in one
  block is intended and lower-risk than leaving the I/O half unenforced. If a reviewer wants the
  narrowest possible change, the HTTP/Node-core lines can be dropped without affecting the Temporal
  ban.
- **Apply the ban to test files too.** Policy tests are pure unit tests; there is no legitimate
  reason for a `packages/policies/src/**/*.test.ts` to import Temporal or an HTTP client. Unlike the
  workflows block (which splits test vs non-test because tests legitimately need Node core for the
  harness), the policies ban applies uniformly to `packages/policies/src/**/*.ts`. `import/no-nodejs-modules`
  is the one nuance — if a policy test ever needs a Node built-in it would trip; I assume none do
  (confirmed: policies has only `@agentops/contracts` as a dependency and no current Node-core usage),
  and an `allow: []` escape hatch mirrors the workflows convention if that changes.
- **Ban `@temporalio/*` as a glob, not an enumerated list.** Any Temporal subpackage
  (`@temporalio/workflow`, `/common`, `/activity`, …) violates rule 2, so a single `@temporalio/*`
  pattern is more future-proof than listing packages.
- **A regression test belongs with this change.** To prevent the enforcement itself from silently
  regressing, I assume adding a lint-fixture/assertion is in scope (see Design).

## Design

Single coherent change, confined to lint configuration plus a guard test. No product/runtime code
changes.

**Files affected:**

- `eslint.config.js`
  - Add a new flat-config block after the workflows determinism blocks:
    - `files: ['packages/policies/src/**/*.ts']`
    - `no-restricted-imports`: `patterns: [{ group: ['@temporalio/*'], message: 'AGENTS.md rule 2: packages/policies stays pure — no Temporal imports.' }]`, plus `paths: [...httpClientImports]` reusing the existing shared array (with an I/O-oriented message referencing rule 2).
    - `import/no-nodejs-modules: ['error', { allow: [] }]` to enforce the "no I/O" clause, mirroring the workflows block's reviewed-escape-hatch comment.
  - Add a short comment tying the block to AGENTS.md rule 2, matching the rule-1 comment style.
  - The existing `import/no-restricted-paths` policies zone (internal-package ban) is left unchanged
    — it remains the correct tool for the workspace-path bans and is complementary to the new block.

- A guard test verifying the enforcement fires. Preferred location: alongside existing repo tests
  (e.g. `packages/policies/src/eslint-purity.test.ts` or a lint fixture under the same package),
  using vitest to run ESLint's API over an in-memory fixture string that imports `@temporalio/workflow`
  and asserting at least one error with the rule-2 message. This locks the behavior so a future
  config refactor that drops the block fails CI. (Exact harness — programmatic `ESLint` from the
  `eslint` package vs a committed `// should error` fixture — is an implementation detail for the
  plan stage.)

**Data flow / behavior:** none at runtime — this is a static-analysis guard. `pnpm lint` gains the
ability to reject a Temporal or I/O import inside `packages/policies/src`. Existing policy sources
already comply (grep confirms zero `temporal` references and only `@agentops/contracts` as a
dependency), so the change is green on the current tree.

**Error handling:** N/A (config). The failure mode we care about is a *false negative* (ban not
firing), which the guard test addresses; false positives are bounded because the ban is scoped to a
single package that today imports nothing but `@agentops/contracts`.

**Docs:** AGENTS.md rule 2 already describes the intended constraint, so no wording change is
required; the change makes the doc enforceable rather than altering it. Per DoD, no behavior/design
doc update is needed beyond this spec.

## Self-review

- No placeholders or TBDs (the one deferred item — exact test harness — is explicitly flagged as a
  plan-stage detail, not a gap in the design).
- No contradictions: the recommended approach, assumptions, and file list agree that the ban lives
  in a new `no-restricted-imports`/`no-nodejs-modules` block and that the existing path-based zone
  stays.
- Scope: one coherent change — enforce AGENTS.md rule 2 in lint. The I/O-clause inclusion is a
  deliberate widening within the same rule, documented under Assumptions with a fallback to the
  narrow version.

## Brainstorm Summary
**Approaches considered:** (A) widen the existing path-based `import/no-restricted-paths` zone; (B) add a dedicated `no-restricted-imports` + `no-nodejs-modules` block for `packages/policies/src`; (C) a custom rule / dependency-cruiser.
**Chosen approach:** B — a new ESLint block scoped to `packages/policies/src/**` banning `@temporalio/*` (glob) plus the shared HTTP-client and Node-core bans, mirroring the existing rule-1 workflows block, with a guard test.
**Why (decisive reasons):** `no-restricted-imports` is the mechanism actually designed to ban npm specifiers (path-based zones can't match the `@temporalio/*` scope); reusing the shared arrays avoids drift; enforcing the full "no Temporal, no I/O" sentence closes the whole rule-2 gap.
**Key risks/assumptions:** Ban is widened to cover I/O and test files (fallback: drop HTTP/Node-core lines for the Temporal-only minimum); current policies tree already complies, so the change lands green.
