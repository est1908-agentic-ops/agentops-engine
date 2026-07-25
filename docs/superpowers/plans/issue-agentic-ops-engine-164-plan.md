# Plan — Task issue-agentic-ops-engine-164

**[bughunt] Determinism-lint rules don't cover `fetch` / `axios` / `crypto.randomUUID` in `packages/workflows`**

Design: `docs/superpowers/specs/issue-agentic-ops-engine-164-design.md` (Approach A — extend the
existing stock ESLint rules in `eslint.config.js`, de-duplicated into shared constants, plus tests
and a docs touch-up). This plan turns that design into ordered, individually-verifiable steps.

## Baseline (already verified)

- `grep -rnE "fetch|axios|randomUUID|crypto" packages/workflows/src` (excluding `*.test.ts`)
  returns **no matches** → the new rules cannot break existing production workflow code.
- `axios`/`node-fetch`/`undici`/`got`/`superagent`/`request` are not repo dependencies, so the
  `no-restricted-imports` ban cannot break an existing import.

## Steps (ordered)

### Step 1 — Extend `determinism-lint.test.ts` with failing cases first (TDD)

**File:** `packages/workflows/src/determinism-lint.test.ts`

Add new `it(...)` cases in the existing structure (inline `code`, lint via `eslint.lintText`
against the virtual `packages/workflows/src/__lint_fixture__.ts` path, filter `results[0].messages`
by `ruleId`, assert counts and message substrings). Each case keeps the existing `30_000` timeout.

Cases to add:
- **`fetch('...')`** against a non-test fixture path → exactly one `no-restricted-globals` error;
  assert message contains `AGENTS.md rule 1`.
- **`crypto.randomUUID()`** (global) against a non-test fixture path → assert a
  `no-restricted-properties` error fires for `crypto.randomUUID` (message contains `AGENTS.md rule 1`).
  Note: because global `crypto` is also banned via `no-restricted-globals`, this snippet may also
  produce a `no-restricted-globals` error — the test asserts the `no-restricted-properties` error is
  present (`toHaveLength(1)` filtered by that ruleId) rather than asserting total message count, so
  the two rules co-existing does not make the test brittle.
- **`crypto.getRandomValues(new Uint8Array(1))`** → one `no-restricted-properties` error.
- **`import axios from 'axios'`** against a non-test fixture path → exactly one
  `no-restricted-imports` error; assert message contains `AGENTS.md rule 1`.
- **False-positive guards:**
  - a local `function fetch() {}` shadow + call → **no** `no-restricted-globals` error (documents the
    known/accepted blind spot as intended behavior: shadowing is legitimate).
  - `const o = { randomUUID() { return '' } }; o.randomUUID();` → **no** `no-restricted-properties`
    error (property ban is scoped to `object: 'crypto'`).
  - existing `import { defineWorkflow } from '@temporalio/workflow'` guard stays green (unchanged).
- **Test-file scope guard:** `import axios from 'axios'` against a `*.test.ts` fixture path
  (`packages/workflows/src/__lint_fixture__.test.ts`) → **no** `no-restricted-imports` error
  (proves the HTTP-client ban is production-only, per the design's test-scope decision), while a
  `fetch('...')` in that same test-file path **does** still error on `no-restricted-globals`
  (proves globals/properties are mirrored into the test block).

**Verify:** `pnpm test --filter @agentops/workflows` (or the repo's workflows test command) — the
new cases **fail** now (rules not yet added), confirming they actually exercise the gap. This is the
de-risking step: it proves the tests are meaningful before the config changes make them pass.

### Step 2 — Extend the determinism rules in `eslint.config.js`, de-duplicated into shared constants

**File:** `eslint.config.js` (repo root)

1. Introduce two `const` rule-value arrays near the top of the module (after the `require`s), e.g.
   `determinismGlobals` and `determinismProperties`, holding the banned-globals / banned-properties
   entries currently hand-repeated in the two workflow blocks.
2. Populate `determinismGlobals` with the existing entries (`Date`, `setTimeout`, `setInterval`)
   **plus** new entries:
   - `{ name: 'fetch', message: 'Use Temporal activities for I/O — AGENTS.md rule 1.' }`
   - `{ name: 'crypto', message: 'Non-deterministic in workflow code — AGENTS.md rule 1.' }`
3. Populate `determinismProperties` with the existing entries (`Math.random`, `Date.now`) **plus**:
   - `{ object: 'crypto', property: 'randomUUID', message: 'Non-deterministic in workflow code — AGENTS.md rule 1.' }`
   - `{ object: 'crypto', property: 'getRandomValues', message: 'Non-deterministic in workflow code — AGENTS.md rule 1.' }`
4. Replace the inline `no-restricted-globals` / `no-restricted-properties` arrays in **both** the
   `packages/workflows/src/**/!(*.test).ts` block and the `packages/workflows/src/**/*.test.ts`
   block with `['error', ...determinismGlobals]` / `['error', ...determinismProperties]` so both
   blocks reference one source of truth.
5. In the **non-test** block only, add a `no-restricted-imports` rule banning the HTTP-client family:
   `axios`, `node-fetch`, `undici`, `got`, `superagent`, `request`, each with a message citing
   AGENTS.md rule 1 and directing authors to Temporal activities for I/O. Do **not** add this rule to
   the test block.

Leave `import/no-restricted-paths` and `import/no-nodejs-modules` unchanged.

**Verify:**
- `pnpm test --filter @agentops/workflows` — all Step 1 cases now **pass** (rules fire / stay silent
  as asserted), and the pre-existing determinism cases stay green.
- `pnpm lint` — completes with no new errors on the real tree (baseline grep confirmed no production
  usage), proving the config is syntactically valid and doesn't regress existing files.
- Sanity check that the two blocks are truly de-duplicated: `node -e "require('./eslint.config.js')"`
  loads without throwing (config parses), and a manual read confirms both blocks spread the same
  constants.

### Step 3 — Refresh AGENTS.md rule 1 examples (docs-only)

**File:** `AGENTS.md`

Update the rule 1 example list (currently "may not do I/O, use `Date.now()`, `Math.random()`,
timers, or import from activities/ports/backends") to name the newly-covered vectors — e.g. add
`fetch`/`axios` as I/O examples and `crypto.randomUUID()` as a non-determinism example. No semantic
change to the rule; it already covers these "in spirit" (I/O + non-determinism).

**Verify:** manual read — the sentence still reads cleanly and the new examples align with the
rules added in Step 2. `pnpm lint` is unaffected (Markdown). No behavior to test.

### Step 4 — Full pre-PR gate

**Files:** none (verification only).

**Verify:** run the AGENTS.md rule-6 gate from repo root:
`pnpm lint && pnpm typecheck && pnpm test`. All green. `pnpm e2e` is **not** required here — this
change touches only lint config, its test, and docs; it does not alter workflow, policy, activity,
or backend runtime behavior (rule 6 scopes e2e to changes touching those). Note this scoping in the
PR description.

## Sequencing notes

- **Tests before config (Step 1 before Step 2)** — deliberate TDD ordering. Writing the tests first
  and watching them fail proves they exercise the real gap; if they passed before the config change,
  they'd be vacuous. This is also the de-risking step: it validates the fixture-path / ruleId-filter
  approach works for the new rules before committing to the config edit.
- **Config before docs (Step 2 before Step 3)** — the docs describe what the config now enforces;
  writing them after the rules exist avoids documenting a state that doesn't yet hold. Reorderable
  without harm (docs are independent), but this order keeps the narrative honest.
- **Gate last (Step 4)** — the combined `lint && typecheck && test` gate only makes sense once all
  edits are in place.

## Assumptions

The design already resolved the substantive open questions (which HTTP clients to ban; global
`crypto` vs. `crypto.randomUUID`; production-vs-test scope; no AGENTS.md semantic change). Plan-level
resolutions I made to keep steps concrete:

- **Assert by filtered ruleId count, not total message count.** Because global `crypto` is banned in
  `no-restricted-globals` *and* `crypto.randomUUID`/`getRandomValues` in `no-restricted-properties`, a
  `crypto.randomUUID()` snippet can raise two errors. To avoid brittleness, each new test asserts the
  count of messages **filtered to the specific ruleId under test** (matching the existing tests'
  `filter(msg => msg.ruleId === ...)` style), rather than asserting the total error count.
- **Shared-constant naming.** I use `determinismGlobals` / `determinismProperties` (the design's
  suggested names) as plain module-level `const` arrays holding only the entry objects (not the
  leading `'error'`), spread as `['error', ...determinismGlobals]` at each use site. Chosen for
  minimal diff and because it keeps the `'error'` severity visible at each block.
- **Test-file scope proof.** The design says globals/properties are mirrored to the test block but the
  HTTP-client import ban is not. I added an explicit test-file-path case for *both* halves (axios ban
  absent, fetch global present) so the scope decision is regression-locked, not just documented.
- **e2e not run.** Per rule 6's scoping ("changes touching workflows, policies, activities, or
  backends"), a lint-config + test + docs change does not require `pnpm e2e`; I record this rather
  than run a suite the change can't affect. If the repo's CI runs e2e unconditionally, that still
  passes since no runtime code changed.
