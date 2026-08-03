# Design — issue-agentic-ops-engine-160

**[bughunt] Determinism lint rule doesn't cover I/O imports in `packages/workflows`**

## Goal

AGENTS.md hard rule #1 states that code in `packages/workflows` "may not do I/O, use
`Date.now()`, `Math.random()`, timers, or import from `activities`/`ports`/`backends`." The
repo-level ESLint config enforces most of this, but there is a real gap: nothing stops a workflow
file from importing a Node built-in I/O module directly (`import fs from 'node:fs'`,
`require('child_process')`, `http`, `net`, `dns`, `dgram`, `tls`, etc.). Such an import lets
workflow code perform raw side effects that break Temporal's determinism guarantee, yet
`pnpm lint` stays green.

Close that gap so the determinism boundary the docs promise is actually enforced by the linter,
and back it with a test (there is currently no test for the determinism rules at all).

### What exists today (verified)

The boundary is enforced entirely with stock rules in the single flat config at
`eslint.config.js` — there is no custom plugin:

- `import/no-restricted-paths` — blocks `packages/workflows/src` from importing
  `packages/activities/src`, `packages/ports/src`, `packages/backends/src` (and the analogous
  purity zone for `packages/policies`).
- A `files: ['packages/workflows/src/**/*.ts']` block using `no-restricted-globals`
  (`Date`, `setTimeout`, `setInterval`) and `no-restricted-properties` (`Math.random`,
  `Date.now`).

Neither mechanism restricts Node built-in modules. `packages/workflows` legitimately imports only
`@temporalio/*`, `@opentelemetry/api`, `@agentops/contracts`, and `@agentops/policies` — it
imports **no** Node built-in today, so tightening this is safe.

## Approaches considered

### A. Blocklist of I/O modules via `no-restricted-imports`

Add `no-restricted-imports` to the workflows `files` block enumerating the I/O built-ins
(`fs`, `node:fs`, `http`, `https`, `net`, `dgram`, `dns`, `child_process`, `cluster`, `tls`,
`http2`, `readline`, `os`, `worker_threads`, …), listing both bare and `node:`-prefixed forms.

- **Trade-off:** Reintroduces the exact bug class we are fixing — it is a maintained denylist, so
  any I/O module we forget, or any new one Node adds, silently slips through. Doubling every entry
  for the `node:` prefix is noisy and easy to get wrong. Lets deterministic built-ins (`node:path`)
  through, which is the only upside.
- **Cost:** Low, but ongoing maintenance and permanently incomplete.

### B. Allowlist: forbid *all* Node built-ins via `import/no-nodejs-modules` (recommended)

`eslint-plugin-import` (already a dependency, v2.32.0) ships `import/no-nodejs-modules`, which
bans importing any Node core module. Enable it in the existing
`files: ['packages/workflows/src/**/*.ts']` block with an empty `allow` list. It covers static
`import`, `require`, and the `node:` protocol form, so no per-module or per-prefix enumeration is
needed.

- **Trade-off:** Coarser — it also rejects deterministic-and-harmless built-ins like `node:path`
  or `node:util`. For a determinism boundary this is a feature, not a limitation: workflow code
  should reach nothing but Temporal APIs, contracts, and pure policies. If a genuinely safe
  built-in is ever needed, add it to the rule's `allow` option (a deliberate, reviewed one-liner).
- **Cost:** Low, and self-maintaining — future Node I/O modules are caught automatically.

### C. Custom ESLint rule/plugin

Author a repo-local rule that inspects import sources with full control (e.g. distinguish
type-only imports, dynamic `import()`, allowlist by capability).

- **Trade-off:** Maximum precision, but far more code, a plugin to wire into the flat config, and
  a rule to maintain and test — disproportionate to a boundary that a stock rule already expresses.
- **Cost:** High. Rejected as over-engineering.

## Chosen approach

**Approach B** — enable `import/no-nodejs-modules` for `packages/workflows/src`.

It directly answers the issue ("doesn't cover I/O imports") by refusing the entire category of
Node core imports rather than chasing a denylist. Approach A was rejected precisely because a
denylist recreates the gap it is meant to close and would need updating as Node evolves.
Approach C was rejected as far more machinery than a one-rule change warrants when an existing,
already-installed plugin expresses the intent exactly. The coarseness of B aligns with rule #1's
plain reading — workflow code has no business importing Node core at all — and the `allow` escape
hatch keeps it from being a dead end.

## Assumptions

- **No legitimate Node built-in is needed in workflow code today.** Verified: `packages/workflows`
  imports zero Node core modules. So an empty `allow` list will not break the current build. If a
  safe, deterministic built-in is required later, the fix is to add it to `allow` with a comment —
  not to weaken the rule.
- **Scope is `packages/workflows` only.** `packages/policies` (rule #2, "stays pure") has the same
  latent gap, but the issue is titled and framed around workflows. Extending the rule to policies
  is a coherent follow-up, deliberately left out to keep this change single-purpose. Noted here so
  it is not forgotten.
- **A test belongs with this change.** The definition of done requires tests and none exist for the
  determinism rules. I add one lint-fixture test rather than relying on manual `pnpm lint`.
- **`import/no-nodejs-modules` covers the `node:` prefix and `require`** in
  eslint-plugin-import 2.32.0. If verification during implementation shows a prefix form is missed,
  Approach A's `no-restricted-imports` denylist is layered in as a supplement — but B is expected
  to suffice.

## Design

### Components / files affected

1. **`eslint.config.js`** — In the existing `files: ['packages/workflows/src/**/*.ts']` config
   object (the block that already holds `no-restricted-globals` / `no-restricted-properties`), add:

   ```
   'import/no-nodejs-modules': ['error', { allow: [] }]
   ```

   with an accompanying message/comment tying it to AGENTS.md rule #1. The `import` plugin is
   already registered in the config, so no new plugin wiring is required. No other config block
   changes.

2. **New test: `packages/workflows/src/determinism-lint.test.ts`** — A vitest test (discovered by
   `vitest.config.ts`'s `packages/*/src/**/*.test.ts` glob) that uses ESLint's Node API
   (`new ESLint({ cwd: <repo root> })`) to lint in-memory source via
   `lintText(code, { filePath: 'packages/workflows/src/__lint_fixture__.ts' })`, applying the real
   repo config. It asserts:
   - a workflow-path source that imports `node:fs` (and a second case using bare `fs`) reports an
     `import/no-nodejs-modules` error;
   - a clean workflow-path source (importing only `@temporalio/workflow`) reports no errors,
     guarding against false positives.

   This both proves the gap is closed and becomes the first regression test for the determinism
   boundary. `eslint` is a root dev dependency and resolvable from the workspace root, so the test
   needs no new package dependency; if module resolution from within the package proves awkward
   during implementation, the fallback is to place the test under the repo `e2e/`-style root
   location — but the package `src` location is preferred so it runs in the standard `pnpm test`.

### Data flow / behavior

No runtime/product behavior changes — this is lint-time enforcement only. After the change,
`pnpm lint` fails on any Node core import within `packages/workflows/src`, matching the documented
determinism boundary. Existing workflow files are unaffected (none import Node core).

### Error handling

Not applicable to product code. The ESLint message will point to AGENTS.md rule #1 so a developer
who hits it understands why and knows the sanctioned alternative (proxied Temporal activities) and
the `allow` escape hatch for a proven-safe deterministic built-in.

## Self-review

- No placeholders or TBDs.
- No contradictions: verified-current state, chosen rule, and test all agree that workflows import
  no Node core today.
- Single coherent change: one lint rule addition plus its first regression test. The `policies`
  extension is explicitly called out as out-of-scope follow-up rather than silently bundled.

## Brainstorm Summary
**Approaches considered:** (A) a maintained `no-restricted-imports` denylist of Node I/O modules; (B) forbid *all* Node built-ins in `packages/workflows/src` via the already-installed `import/no-nodejs-modules`; (C) a custom ESLint plugin.
**Chosen approach:** (B) — enable `import/no-nodejs-modules` (empty `allow`) for the workflows file glob, plus the repo's first determinism-rule test.
**Why (decisive reasons):** A denylist recreates the very gap being fixed and needs upkeep as Node grows; a custom rule is disproportionate machinery. B is one line using an existing plugin, self-maintaining, and matches rule #1's plain reading that workflow code should import no Node core; the `allow` option is the escape hatch.
**Key risks/assumptions:** Workflows import no Node built-in today (verified), so an empty allowlist is safe; scope is workflows only (`policies` has the same gap, left as a noted follow-up); assumes `import/no-nodejs-modules` catches the `node:` prefix and `require` in eslint-plugin-import 2.32.0, with the denylist as a fallback if not.
