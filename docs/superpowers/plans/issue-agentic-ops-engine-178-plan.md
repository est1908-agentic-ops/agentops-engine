# Plan — Task issue-agentic-ops-engine-178

**[bughunt] SpawnCommandRunner executes project-supplied init commands via `shell: true`**

Design: `docs/superpowers/specs/issue-agentic-ops-engine-178-design.md` (Approach A —
scrub the child environment to a minimal allowlist while keeping `shell: true`).

## Summary of the change

`SpawnCommandRunner.run()` (`packages/activities/src/workspace/spawn-command-runner.ts:27`)
spawns project-supplied `initCommands` with `env: process.env`, handing untrusted project
input the worker's full secret environment. Fix: build the child env from an explicit
allowlist of non-secret vars instead of inheriting `process.env`. One production file, its
test, and a one-line doc note. No contract, workflow, policy, or wiring changes.

## Steps

### Step 1 — Add the allowlist and scrub the env in `SpawnCommandRunner`
**File:** `packages/activities/src/workspace/spawn-command-runner.ts`

- Add a module-level `INIT_COMMAND_ENV_ALLOWLIST` constant listing the non-secret var names:
  `PATH`, `HOME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TERM`, `SHELL`. Export it so tests can
  reference it rather than hard-coding the list twice.
- Add an optional `envAllowlist?: string[]` field to `SpawnCommandRunnerOptions` (keeps the
  existing injectable `spawn` seam; defaults to `INIT_COMMAND_ENV_ALLOWLIST`). Store it on the
  instance.
- Add a private helper `buildEnv()` that returns a fresh object containing only the allowlisted
  keys whose value is actually present (not `undefined`) in `process.env`. Skipping `undefined`
  avoids handing the child empty overrides for vars the worker doesn't have.
- In `run()`, replace `env: process.env` with `env: this.buildEnv()`. Leave `cwd`, `shell: true`,
  the stdout/stderr accumulation, and the `error`/`close` resolution logic untouched.

**Verify:** `pnpm --filter @agentops/activities typecheck` (or repo-root `pnpm typecheck`) passes;
new code introduces no `any`. Full assertion of behaviour happens in Step 2.

### Step 2 — Test the env scrubbing
**File:** `packages/activities/src/workspace/spawn-command-runner.test.ts`

- Extend the existing `fakeSpawn` usage (it already captures `calls[].options`) — no harness
  change needed.
- Add a test: seed a representative secret into `process.env` (e.g.
  `process.env.GITHUB_TOKEN = 'secret-should-not-leak'`) and a known allowlisted var (ensure
  `process.env.PATH` is set), run a command, then assert on `calls[0].options.env`:
  - it **excludes** `GITHUB_TOKEN` (`expect(env).not.toHaveProperty('GITHUB_TOKEN')`),
  - it is **not** the same reference as `process.env` (`expect(env).not.toBe(process.env)`),
  - it **includes** `PATH` when present.
  Clean up the seeded var in a `finally`/`afterEach` so the suite stays hermetic (no secrets
  left in the process env for other tests — honours AGENTS.md rule 5).
- Optionally add a test using the `envAllowlist` constructor override to assert only the
  requested keys pass through, proving the filter is allowlist-driven (not a denylist).
- Keep the existing assertions (`shell === true`, `cwd` forwarded, exit-code, `spawnFailed`,
  spawn-error hang-prevention) unchanged; they must stay green.

**Verify:** `pnpm --filter @agentops/activities test spawn-command-runner` — new tests pass, all
pre-existing tests still green.

### Step 3 — Document the minimal env in project-config docs
**File:** `docs/project-config.md` (the `initCommands` bullet at line ~93)

- Append a sentence to the `initCommands` description: init commands run with a minimal
  environment (no inherited engine secrets) and must declare any vars they need inline — mirror
  the existing verify-command environment guidance so the two read consistently.

**Verify:** manual read-through — the note is accurate and matches the implemented allowlist
posture. `pnpm lint` (prettier/markdown) passes.

### Step 4 — Full definition-of-done gate
- Run `pnpm lint && pnpm typecheck && pnpm test` at repo root — all green.
- Run `pnpm e2e`. Activities are touched, so AGENTS.md rule 6 requires it; expect no behavioural
  change since only the child env of init commands changed (real init commands like `pnpm install`
  don't rely on inherited engine secrets).

**Verify:** all four commands exit 0. If e2e surfaces a real init command that depended on an
inherited benign var, add that var to the allowlist (still non-secret) rather than reverting the
scrub — and record it.

## Sequencing notes

- **Step 1 before Step 2** is the de-risking order: the production change is the whole fix and
  the smallest surface; writing it first lets the test assert against real behaviour rather than
  a mock. The test is meaningless without the code, so it cannot lead.
- **Step 3 (docs) is independent** and could go first or last; placed after the code so the note
  describes the shipped allowlist exactly, avoiding a doc/code drift if the allowlist is adjusted
  during Step 4.
- **Step 4 is deliberately last** — the DoD gate validates the composed change end-to-end; running
  it earlier would just re-run on an incomplete change.
- No step is really two steps: Step 1 is one cohesive edit to one function + its options; Step 2 is
  test-only; Step 3 is docs-only.

## Assumptions

- **Allowlist contents** (design §Assumptions): `PATH`, `HOME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`,
  `TERM`, `SHELL`. Assumed non-secret and sufficient for typical tooling (node, pnpm, git,
  corepack). Projects needing another benign var set it inline in the command string. If e2e
  proves a common var is required, it is added to the allowlist in Step 4 (must remain non-secret).
- **`envAllowlist` override is test-affordance only**, not a new config surface. It is not added to
  `ProjectConfigSchema`, so contracts are untouched and no contracts-first work is required
  (AGENTS.md rule 3 unaffected).
- **Timeout gap out of scope** (design §Assumptions): the pre-existing "init command can hang the
  worker forever" robustness gap is orthogonal to this secret-exposure fix and is left as a
  recorded follow-up, not bundled here.
- **`export` the allowlist constant** so the test asserts against the single source of truth
  rather than duplicating the list; chosen over keeping it module-private to avoid drift.
- **Ports/vendors rule (AGENTS.md rule 4) unaffected:** `SpawnCommandRunner` lives in
  `packages/activities` and spawns generic shell for workspace prep, not a forge/tracker SDK or an
  agent CLI, so no ports/backends boundary is crossed.
