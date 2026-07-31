# Plan — issue-agentic-ops-engine-175

Enforce AGENTS.md **rule 2** (`packages/policies` "no Temporal imports, no I/O") in lint, closing
the gap where a policy module could `import ... from '@temporalio/workflow'` and `pnpm lint` would
still pass. Follows the chosen design (Approach B): a new `no-restricted-imports` /
`import/no-nodejs-modules` block scoped to `packages/policies/src/**/*.ts`, mirroring the existing
workflows determinism block, plus a guard test that locks the enforcement so it can't silently
regress.

Reference: `docs/superpowers/specs/issue-agentic-ops-engine-175-design.md`.

## Preconditions

- `node_modules` is **not** installed in this workspace (verified: `ls node_modules` → absent).
  Any verification command below (`pnpm lint`, `pnpm test`, programmatic ESLint) requires
  `pnpm install` first. **Step 0** covers this; it is a prerequisite for *every* verification step,
  not an optional one.

## Steps

### Step 0 — Install dependencies (prerequisite, no code change)
- **Command:** `pnpm install`
- **Why first:** eslint, vitest, and all plugins referenced by `eslint.config.js` are absent from
  the workspace. Nothing below can be verified until deps resolve. Also confirms the toolchain is
  healthy before we touch config.
- **Verify:** `pnpm install` exits 0; `node_modules/.bin/eslint` exists; `pnpm lint` runs to
  completion on the *unchanged* tree (baseline: currently green — captures the "before" state so we
  know Step 1 is what turns policies enforcement on, not a pre-existing failure).

### Step 1 — Add the rule-2 enforcement block to `eslint.config.js`
- **File:** `eslint.config.js`
- **Change:** Insert a new flat-config block immediately after the two workflows blocks
  (after the `packages/workflows/src/**/*.test.ts` block, before the `eslint.config.js` commonjs
  block). Shape:
  ```js
  {
    files: ['packages/policies/src/**/*.ts'],
    rules: {
      // AGENTS.md rule 2: packages/policies stays pure — no Temporal imports, no I/O.
      // The `allow` array is the reviewed escape hatch for a proven-safe built-in, mirroring
      // the workflows block; empty today because policies imports only @agentops/contracts.
      'import/no-nodejs-modules': ['error', { allow: [] }],
      'no-restricted-imports': [
        'error',
        {
          paths: [...httpClientImports],
          patterns: [
            {
              group: ['@temporalio/*'],
              message:
                'AGENTS.md rule 2: packages/policies stays pure — no Temporal imports.',
            },
          ],
        },
      ],
    },
  },
  ```
  - Reuses the existing shared `httpClientImports` array (no new drift surface).
  - Uses the **object** form of `no-restricted-imports` (`{ paths, patterns }`) because the
    Temporal ban needs a gitignore-style glob (`patterns`), unlike the workflows block which only
    needs the array/`paths` form.
  - Applies to `packages/policies/src/**/*.ts` **including** `*.test.ts` (per design assumption:
    policy tests are pure unit tests with no legitimate Temporal/HTTP/Node-core need).
  - Leaves the existing `import/no-restricted-paths` policies zone (lines 60–68) untouched — it is
    the correct tool for the workspace-path bans and is complementary.
- **Verify (positive — enforcement fires):** create a throwaway file
  `packages/policies/src/__ban_probe__.ts` containing `import { proxyActivities } from '@temporalio/workflow';`
  then run `pnpm exec eslint packages/policies/src/__ban_probe__.ts`. Expect a non-zero exit with the
  rule-2 message. Repeat with `import axios from 'axios';` and `import { readFile } from 'node:fs';`
  to confirm the HTTP-client and Node-core clauses also fire. **Delete the probe file** afterward
  (it is scratch, not committed).
- **Verify (negative — no false positives):** `pnpm lint` on the real tree exits 0. The current
  policies sources import only `@agentops/contracts` and have zero `temporal` references
  (grep-confirmed in design), so the block must land green.

### Step 2 — Add the guard test that locks the enforcement
- **File (new):** `packages/policies/src/eslint-purity.test.ts`
- **Change:** A vitest test that drives ESLint's programmatic API over in-memory fixture strings and
  asserts the rule-2 block fires. Sketch:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { ESLint } from 'eslint';

  const lintPolicyFixture = async (code: string) => {
    const eslint = new ESLint({ cwd: process.cwd() });
    // filePath must match the packages/policies/src/**/*.ts glob so the rule-2 block applies.
    const [result] = await eslint.lintText(code, {
      filePath: 'packages/policies/src/__fixture__.ts',
    });
    return result.messages;
  };

  describe('AGENTS.md rule 2 — packages/policies purity is lint-enforced', () => {
    it('bans @temporalio/* imports', async () => {
      const messages = await lintPolicyFixture(
        "import { proxyActivities } from '@temporalio/workflow';\n",
      );
      expect(messages.some((m) => /rule 2/i.test(m.message) && m.ruleId === 'no-restricted-imports'))
        .toBe(true);
    });

    it('bans HTTP clients', async () => {
      const messages = await lintPolicyFixture("import axios from 'axios';\n");
      expect(messages.some((m) => m.ruleId === 'no-restricted-imports')).toBe(true);
    });

    it('bans Node core modules', async () => {
      const messages = await lintPolicyFixture("import { readFile } from 'node:fs';\n");
      expect(messages.some((m) => m.ruleId === 'import/no-nodejs-modules')).toBe(true);
    });

    it('allows @agentops/contracts (no false positive)', async () => {
      const messages = await lintPolicyFixture(
        "import { StageSchema } from '@agentops/contracts';\n",
      );
      expect(messages.some((m) => m.ruleId === 'no-restricted-imports')).toBe(false);
      expect(messages.some((m) => m.ruleId === 'import/no-nodejs-modules')).toBe(false);
    });
  });
  ```
  - Uses `lintText` with a `filePath` under `packages/policies/src/` so the flat config selects the
    new block. The fixture is an **in-memory string**, so it never trips `pnpm lint` on the real
    tree (no committed file that imports Temporal).
  - The "allow @agentops/contracts" case guards against over-broad bans (false positives).
- **Verify:** `pnpm test` — the four cases pass. Then, as a mutation check, temporarily comment out
  the new `no-restricted-imports` block in `eslint.config.js` and re-run `pnpm test`; the temporal
  and http cases must **fail** (proving the test actually detects a regression), then restore the
  block. This confirms the guard has teeth rather than passing vacuously.
- **Coverage note:** the file is a `*.test.ts`, so it is excluded from the policies 100%-coverage
  source set (`vitest.coverage.config.ts` excludes `packages/policies/src/**/*.test.ts`) and does
  not perturb `pnpm test:policies-coverage` thresholds. It is picked up by the main run because the
  root vitest `include` matches `packages/*/src/**/*.test.ts`.

### Step 3 — Full definition-of-done gate
- **Commands:** `pnpm lint && pnpm typecheck && pnpm test`
- **Change:** none — this is the DoD gate from AGENTS.md rule 6.
- **Verify:** all three exit 0. `e2e` is **not** required: this change touches only lint config and
  a test, with zero product/runtime code in workflows/policies/activities/backends (rule 6 scopes
  the e2e requirement to those runtime surfaces; a static-analysis guard changes no runtime
  behavior). Note this reasoning in the PR description.

## Sequencing notes

- **Step 0 (install) is non-negotiably first** because the workspace ships without `node_modules`;
  every later verification is impossible otherwise. It also establishes the green baseline that lets
  us attribute any new lint output to Step 1.
- **Config (Step 1) before test (Step 2):** the test asserts against the config's behavior. Writing
  the test first would give a red suite with nothing to make it green, and the probe-file check in
  Step 1 already de-risks the config in isolation before we depend on it from a test. This is the
  de-risking-first ordering.
- **Could Step 1 and Step 2 be a single commit?** They will likely be committed together (one
  coherent feature: "enforce rule 2"), but they are planned as separate steps because each has its
  own distinct verification (probe file + `pnpm lint` for config; `pnpm test` + mutation check for
  the guard). Keeping them separate steps ensures neither's verification is skipped.
- **Step 3 last** because it is the aggregate gate; running it earlier would just re-run subsets
  already covered.

## Assumptions

Design-level assumptions (I/O clause included, test files covered, `@temporalio/*` as a glob, a
regression test is in scope) are inherited from the design spec and not re-litigated here. Plan-stage
resolutions:

- **Guard-test harness = programmatic `ESLint.lintText` from the `eslint` package** (the design left
  the exact harness open). Chosen over a committed `// should error` fixture because a real committed
  file importing Temporal would itself fail `pnpm lint`, defeating the purpose; an in-memory string
  keeps the tree green while still exercising the real flat config. `eslint` is already a root
  devDependency, so no new dependency is added.
- **Guard-test location = `packages/policies/src/eslint-purity.test.ts`.** The root vitest `include`
  only matches `packages/*/src/**/*.test.ts` (and `packages/cli/src/**`), so a repo-root test would
  not be collected; placing it in `policies` is both collectable and semantically where the rule
  lives. Verified it does not affect the policies coverage gate (excluded as a `*.test.ts`).
- **`no-restricted-imports` object form (`{ paths, patterns }`).** The Temporal ban requires a glob
  (`@temporalio/*`), which only the `patterns` key supports; the workflows block's array form can't
  express it. I reuse `httpClientImports` under `paths` in the same object so the HTTP ban and
  Temporal ban share one rule invocation.
- **Probe files for the positive check are scratch, not committed.** Deleted at the end of Step 1;
  the persistent regression guard is the Step 2 test, not a committed fixture.
- **e2e is out of scope for the DoD gate** (Step 3 rationale above): no runtime surface changes.
