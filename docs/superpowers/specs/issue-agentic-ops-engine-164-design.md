# Design — Task issue-agentic-ops-engine-164

**[bughunt] Determinism-lint rules don't cover `fetch` / `axios` / `crypto.randomUUID` in `packages/workflows`**

## Goal

The "determinism-lint" that enforces AGENTS.md rule 1 (the workflow determinism boundary) is a
set of stock ESLint rules in the repo-root `eslint.config.js`, backed by an ESLint-driven Vitest
test. It currently catches `Date` / `Date.now()` / `Math.random()` / `setTimeout` / `setInterval`,
Node-core-module imports, and cross-package boundary imports. It does **not** catch three common
non-determinism / I/O vectors that are trivially reachable from workflow code:

1. **`fetch(...)`** — the Node 22 global `fetch` performs network I/O; not in `no-restricted-globals`.
2. **`axios`** — a third-party HTTP client. `import/no-nodejs-modules` only bans Node built-ins, so
   `import axios from 'axios'` passes lint today.
3. **`crypto.randomUUID()` / global `crypto`** — the Web Crypto global (`globalThis.crypto`) is not
   restricted. Only the *Node module* `crypto` is blocked (at import time via `import/no-nodejs-modules`);
   the global bypasses that entirely.

The goal is to close these three gaps so a violating workflow fails `pnpm lint` (and `pnpm test`),
matching the existing pattern and message style, without breaking legitimate workflow code.

## Alignment with the SLDS

This change enforces an existing hard rule more completely; it does not alter the SLDS lifecycle or
any workflow behavior. No SLDS update required.

## Approaches considered

### Approach A — Extend the existing stock ESLint rules (recommended)

Add the missing vectors to the rules already in `eslint.config.js`:
- `no-restricted-globals`: add `fetch` and `crypto`.
- `no-restricted-properties`: add `crypto.randomUUID` and `crypto.getRandomValues` (a precise message
  even when `crypto` is reached some other way).
- `no-restricted-imports`: add a new rule banning `axios` and the common HTTP-client family
  (`node-fetch`, `undici`, `got`, `superagent`, `request`) with an AGENTS.md-rule-1 message.

**Trade-off:** Uses only built-in ESLint rules and matches the established pattern exactly. It
inherits the same blind spots the current rules already have — it does not catch aliasing
(`const f = fetch; f()`) or `globalThis.fetch` / `globalThis.crypto`. That is acceptable: the lint is
a fast, cheap first line of defense, and Temporal's workflow sandbox is the real runtime backstop
(it throws on actual non-deterministic calls during replay). **Cost:** low — config edits + tests.

### Approach B — Custom ESLint plugin with full AST analysis

Write a bespoke rule (in a new tooling package) that tracks bindings and flags aliased/`globalThis`-
qualified accesses too.

**Trade-off:** Strictly more robust, but heavy: new package, custom rule code to maintain and test,
and it contradicts AGENTS.md ("repo-level config, no per-package overrides", "do not create new
top-level packages without documenting the design"). The extra coverage guards against contrived
evasion that the Temporal sandbox already catches at runtime. **Rejected** — disproportionate cost
for a bughunt fix, and out of step with the repo's stated linting convention.

### Approach C — Standalone regex/AST determinism-lint script

A separate `determinism-lint` CLI wired as its own `package.json` script.

**Trade-off:** Duplicates what ESLint already does, is less precise than AST-based rules, and splits
the determinism policy across two mechanisms. **Rejected** — the repo has deliberately standardized
this policy inside `eslint.config.js`; a parallel checker would be a step backward.

## Chosen approach

**Approach A.** It closes exactly the three named gaps using the same built-in rules and message
convention already in the file, adds zero dependencies and zero new packages, and stays consistent
with AGENTS.md's "repo-level config" rule. B and C are rejected as over-engineered for a bughunt and
in tension with repo conventions; A's known blind spots (aliasing / `globalThis`-qualified access) are
already present for the existing `Date`/`Math` rules and are backstopped by the Temporal sandbox at
runtime — so A does not regress the guarantee, it extends it.

As part of A, the design also **de-duplicates the determinism rules** into shared constants at the top
of the config. Today the non-test block and the test block hand-repeat `no-restricted-globals` /
`no-restricted-properties`; adding three more entries to each doubles the risk of the two blocks
drifting out of sync. Extracting the shared rule objects into `const` values and referencing them from
both blocks removes that risk and keeps the change coherent (it is the direct cause of the maintenance
hazard this bug exposes).

## Assumptions

- **Which HTTP clients to ban beyond `axios`.** The issue names `axios`. I will ban the common HTTP-
  client family (`axios`, `node-fetch`, `undici`, `got`, `superagent`, `request`) so the fix isn't a
  single-name whack-a-mole, while keeping the list short and documented. None are current dependencies,
  so this cannot break existing imports. The `no-restricted-imports` message points to AGENTS.md rule 1
  and directs authors to Temporal activities for I/O.
- **`crypto` global vs. `crypto.randomUUID` specifically.** Banning the whole `crypto` global via
  `no-restricted-globals` is broader and simpler than targeting only `randomUUID`, and no legitimate
  workflow use of global crypto exists (verified: no `crypto`/`fetch`/`axios`/`randomUUID` usage in
  `packages/workflows/src`). I add both: `crypto` to `no-restricted-globals` **and**
  `crypto.randomUUID` / `crypto.getRandomValues` to `no-restricted-properties`, so the more specific,
  more actionable message fires for the exact pattern the issue calls out.
- **Scope: production workflow files vs. test files.** The determinism boundary is a *runtime* property
  of workflow code loaded into the Temporal sandbox; test files are not. To match the file's existing
  convention (which already mirrors `Date`/`Math` restrictions into the `*.test.ts` block), I mirror the
  new `fetch` and `crypto` global/property restrictions into the test block too. I do **not** apply the
  `axios`/HTTP-client `no-restricted-imports` ban to test files, because tests may legitimately import an
  HTTP client to build stubs/fixtures; restricting production files is sufficient for the boundary.
- **No AGENTS.md rewrite needed.** Rule 1 already says workflow code "may not do I/O" and must not be
  non-deterministic — `fetch`/`axios` are I/O and `crypto.randomUUID` is non-deterministic, so they are
  already covered in spirit. I will refresh the parenthetical examples in rule 1 to name these vectors
  (a one-line docs touch-up), but no semantic change to the rule.

## Design

Single coherent change. Files affected:

- **`eslint.config.js`** (repo root) — the only production change:
  - Introduce shared `const` rule objects (e.g. `determinismGlobals`, `determinismProperties`) holding
    the banned-globals and banned-properties lists, so the non-test block and test block reference one
    source of truth.
  - Extend `determinismGlobals` with `fetch` and `crypto` (AGENTS.md-rule-1 messages, matching existing
    phrasing: "Non-deterministic in workflow code" / "Use Temporal activities for I/O").
  - Extend `determinismProperties` with `crypto.randomUUID` and `crypto.getRandomValues`.
  - Add a `no-restricted-imports` rule to the non-test workflow block banning the HTTP-client package
    family, with an AGENTS.md-rule-1 message. (`import/no-restricted-paths` and `import/no-nodejs-modules`
    remain unchanged; the new rule handles third-party packages they don't cover.)
  - Test-file block references the same shared globals/properties constants (gaining `fetch`/`crypto`) but
    does not add the HTTP-client import ban.

- **`packages/workflows/src/determinism-lint.test.ts`** — extend the existing ESLint-driven suite with
  cases proving the new coverage, following the current structure (inline `code`, virtual
  `__lint_fixture__.ts` path, filter `messages` by `ruleId`, assert counts). New cases:
  - `fetch('...')` → one `no-restricted-globals` error.
  - `crypto.randomUUID()` (global) → an error on `no-restricted-properties` (and/or `no-restricted-globals`
    for `crypto`); assert the specific rule/message the design lands on.
  - `import axios from 'axios'` → one `no-restricted-imports` error.
  - False-positive guards: a local `function fetch()` shadow or an unrelated `.randomUUID` on a
    non-`crypto` object should **not** error; `import { proxyActivities } from '@temporalio/workflow'`
    stays clean (extends the existing Temporal false-positive guard).

- **`AGENTS.md`** — refresh rule 1's example list to name `fetch`/`axios`/`crypto.randomUUID` (docs-only;
  no semantic change).

### Data flow / how it's exercised

`pnpm lint` (`eslint .`, run in CI via `.github/workflows/ci.yaml`) now fails on the new vectors in any
`packages/workflows/src/**/!(*.test).ts` file. `pnpm test` runs `determinism-lint.test.ts`, which invokes
the ESLint programmatic API against in-memory fixtures and asserts the new rules fire — so the config
itself is regression-tested. Both are part of the AGENTS.md rule-6 pre-PR gate.

### Error handling / edge cases

- **No existing breakage:** verified there is no `fetch` / `crypto` / `axios` / `randomUUID` usage in
  `packages/workflows/src`, and `axios` is not a repo dependency — so no current code starts failing.
- **Known, accepted blind spots:** aliasing and `globalThis`-qualified access are not caught (same as the
  existing `Date`/`Math` rules); the Temporal sandbox catches those at replay time. This is stated, not
  silently ignored.
- **Message consistency:** all new messages cite AGENTS.md rule 1 and, for I/O vectors, direct authors to
  Temporal activities — matching the existing rule voice.

## Self-review

- No placeholders or TBDs.
- No contradictions: the test-file scope decision (mirror globals, not the import ban) is stated once in
  Assumptions and applied consistently in Design.
- Scoped to one coherent change: extending the determinism-lint coverage (config + its test + a docs
  touch-up), including the shared-constant de-duplication that directly prevents the two rule blocks from
  drifting. No unrelated work bundled.

## Brainstorm Summary
**Approaches considered:** (A) extend the existing stock ESLint rules in `eslint.config.js`; (B) build a custom AST-analyzing ESLint plugin in a new tooling package; (C) a standalone regex/AST determinism-lint script.
**Chosen approach:** (A) — add `fetch`/`crypto` to `no-restricted-globals`, `crypto.randomUUID`/`getRandomValues` to `no-restricted-properties`, and a `no-restricted-imports` ban on the axios/HTTP-client family; de-dup the rules into shared constants; add tests.
**Why (decisive reasons):** Closes the three named gaps with zero new deps/packages, matches the established pattern and AGENTS.md's "repo-level config" rule. B/C are over-engineered for a bughunt and fight repo conventions; A's blind spots (aliasing, `globalThis`) already exist for `Date`/`Math` and are backstopped by the Temporal sandbox at runtime.
**Key risks/assumptions:** Ban applies to production workflow files (globals/properties also mirrored to test files, HTTP-client import ban not); global `crypto` banned wholesale (no legit workflow use, verified); docs-only refresh of AGENTS.md rule 1 examples, no semantic change.
