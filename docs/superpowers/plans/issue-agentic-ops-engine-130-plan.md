# Plan — Task issue-agentic-ops-engine-130

**[bughunt] GitHub auth token passed via process argv is exposed to co-resident processes**

Design: `docs/superpowers/specs/issue-agentic-ops-engine-130-design.md` (Approach A —
move the `http.extraHeader` credential from the `-c` command-line argument into the child
process environment via `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0`).

The change is confined to a single runner and its unit test. Two call sites of the runner
(`packages/worker/src/main.ts`, `packages/cli/src/main.ts`, `packages/gateway/src/main.ts`)
pass `authToken` at construction and are untouched — the `GitCommandRunner` contract does
not change. Verified out of scope: `packages/ports/src/github/build-github-ports.ts` passes
tokens via in-process HTTP headers (Octokit), never argv, and the repo-wide grep confirms
`http.extraHeader` / `x-access-token` in argv position appears only in the target runner.

## Steps

### Step 1 — Update the unit test to assert the env-var carrier (test-first)

**File:** `packages/activities/src/workspace/spawn-git-command-runner.test.ts`

- Rewrite the "prepends the auth header config override when a token is available" test
  (rename to reflect the new behavior, e.g. "passes the auth header via GIT_CONFIG_* env
  vars, not argv, when a token is available"):
  - Assert `calls[0].args` equals the caller's args **verbatim** — `['fetch', 'origin']`
    with no injected `-c` / `http.extraHeader=` pair.
  - Assert the child `env` carries `GIT_CONFIG_COUNT === '1'`,
    `GIT_CONFIG_KEY_0 === 'http.extraHeader'`, and
    `GIT_CONFIG_VALUE_0 === 'Authorization: Basic ' + Buffer.from('x-access-token:secret-token').toString('base64')`.
  - Keep asserting `env.GIT_TERMINAL_PROMPT === '0'`.
- Extend the "omits the config override entirely when no token is available" test to also
  assert that **none** of `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0`
  are present in the child `env` (i.e. `toBeUndefined()`), so no auth config leaks in the
  no-token path.
- Leave the cwd, exit-code, spawn-failure, and non-zero-exit tests unchanged.

**Verification:** `pnpm test --filter @agentops/activities` (or the repo-level
`pnpm test`) — the rewritten test **fails** against the current `-c` implementation. A
red test here proves the assertions actually exercise the change before Step 2 makes it
green.

### Step 2 — Move the credential from argv into the child environment

**File:** `packages/activities/src/workspace/spawn-git-command-runner.ts`

- In `run()`, stop building `fullArgs` with the `-c http.extraHeader=...` prefix. Pass
  `args` to `git` unchanged in all cases (no argv mutation).
- Build the per-invocation `env` starting from `{ ...process.env, GIT_TERMINAL_PROMPT: '0' }`.
  When `token` is present, add:
  - `GIT_CONFIG_COUNT: '1'`
  - `GIT_CONFIG_KEY_0: 'http.extraHeader'`
  - `GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + Buffer.from('x-access-token:' + token).toString('base64')`
  When `token` is absent, set none of the `GIT_CONFIG_*` vars (parity with today's "omit
  override entirely" behavior).
- Keep the base64 encoding of `x-access-token:<token>` exactly as-is (git's expected
  `Authorization: Basic` format, not a security control).
- Leave the `spawn` call, the `'error'`/`'close'` handlers, the `settled` guard, and the
  `GitCommandResult` shape untouched — no new failure/cleanup paths.

**Verification:** the Step 1 test now passes: `pnpm test`. Also confirm the source no
longer references `-c` for auth (`grep -n "http.extraHeader\|'-c'" packages/activities/src/workspace/spawn-git-command-runner.ts`
returns no argv match).

### Step 3 — Full local gate

**Files:** none (verification only).

**Verification (per AGENTS.md definition of done):**
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm e2e` — required because the change touches an activity. Confirm the git-backed
  e2e paths (e.g. `e2e/happy-path.e2e.test.ts`, `e2e/pr-landing.e2e.test.ts`, which drive
  workspace/git operations) still pass, validating that clone/fetch/push behavior is
  unchanged with the credential now supplied via env. If the e2e suite does not authenticate
  against a real remote (stub/local git), it still exercises that the runner spawns git
  correctly with the new env carrier and does not regress.

## Sequencing notes

- **Test before implementation (Step 1 → Step 2).** The behavioral change is a swap of the
  credential carrier with no visible effect on git's result, so the unit test is the only
  thing that distinguishes "fixed" from "still leaking via argv." Writing the failing test
  first guarantees the assertions genuinely pin the fix rather than passing vacuously; it is
  the step that de-risks the rest. The alternative order (implement then test) risks writing
  a test that passes regardless.
- **Single implementation step (Step 2 is not two steps).** Removing the argv prefix and
  adding the env vars must land together — an intermediate state that does one without the
  other would leave git either unauthenticated or still leaking. They are one coherent edit
  to `run()`, so they stay in one step.
- **Full gate last (Step 3).** `lint`/`typecheck`/`test`/`e2e` run after the code is final;
  running them earlier would only re-run on the unfinished state.

## Assumptions

- **No git-version guard added.** The design accepts requiring git ≥ 2.31 for
  `GIT_CONFIG_*`; the environment ships 2.39.5 (confirmed via `git --version`) and images
  are project-controlled. If git were older, auth would fail loudly rather than run
  unauthenticated — acceptable. No runtime version check is added.
- **Env-var order in the object literal is irrelevant to git.** `GIT_CONFIG_KEY_0` /
  `GIT_CONFIG_VALUE_0` are matched by name, not position, so the object spread order does
  not matter; the test asserts by key.
- **e2e may not hit a real GitHub remote.** The repo's hard rule 5 forbids real secrets in
  tests (stub backend / memory ports). Where e2e uses a stub/local git, Step 3's e2e check
  verifies non-regression of the spawn path rather than live GitHub auth; live auth remains
  covered by the unit test's exact-header assertion. This is treated as sufficient given the
  carrier swap is behaviorally identical to git.
- **Test rename is cosmetic.** Renaming the first unit test to describe the env-var behavior
  is included for clarity but is not load-bearing; only the assertions matter for correctness.
