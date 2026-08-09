# Plan — Task self-heal-2026-08-09t02-30-00z-platform-fix-1

## Goal

Make `GithubScmPort.push()` (`packages/ports/src/github/github-scm-port.ts`) recognize GitHub's
permanent, permission-based push rejection — the
`refusing to allow a … without \`workflow\` scope` family of errors — and throw a **non-retryable**
Temporal `ApplicationFailure.nonRetryable(message, 'GitPushPermissionError')` instead of the generic
retryable `Error`. Every other push failure (non-fast-forward races, transient network/`git` spawn
errors) keeps its current retryable behavior. This makes `devCycle`/`pushBranch` fail fast on attempt
1 of 5 with a clear cause, instead of exhausting all `maximumAttempts` on a rejection that can never
succeed until a human changes the token's scopes.

This follows **Approach A** from the design spec
(`docs/superpowers/specs/self-heal-2026-08-09t02-30-00z-platform-fix-1-design.md`): throw the
`ApplicationFailure` directly in `push()`, mirroring the classification *shape* used for
`ProcessCliAuthError → ApplicationFailure.nonRetryable(err.message, 'AuthError')` in
`packages/activities/src/create-activities.ts`.

## Files changed (in order)

### 1. `packages/ports/package.json` — add the `@temporalio/common` dependency

Add `"@temporalio/common": "^1.11.0"` to `dependencies` (the exact version already declared in
`packages/activities/package.json`), so `push()` can `import { ApplicationFailure }`.

- **Why first:** it de-risks and unblocks the rest. Every following step depends on the import
  resolving. If the workspace can't provide `@temporalio/common` to `packages/ports`, we want to
  discover that before touching source or tests.
- **Verify:**
  - `pnpm install` completes cleanly.
  - `node -e "require.resolve('@temporalio/common', { paths: ['packages/ports'] })"` (or a quick
    `pnpm --filter @agentops/ports exec node -e "require('@temporalio/common')"`) resolves the
    package from within `packages/ports`.
  - Lint sanity: confirm `@temporalio/common` is not caught by `no-restricted-imports` — already
    verified in `eslint.config.js` (the rule is turned **off** for `packages/ports/src/**`, and the
    Temporal ban applies only to `packages/policies`), so no lint change is required.

### 2. `packages/ports/src/github/github-scm-port.ts` — detect and classify the rejection

- Add `import { ApplicationFailure } from '@temporalio/common';` at the top with the other imports.
- Add a module-level, exported-for-test pure predicate next to the existing helpers (near
  `isNotAccessible` / `mapCheckRuns`), matching their style:

  ```ts
  // GitHub permanently rejects a push that touches .github/workflows/** when the token
  // lacks the `workflow` scope, with a stderr like:
  //   ! [remote rejected] ... (refusing to allow a Personal Access Token to create or
  //    update workflow `.github/workflows/x.yml` without `workflow` scope)
  // The "OAuth App"/"GitHub App" phrasings are the same underlying missing-scope refusal.
  // This is permanent until a human changes the token scopes, so it must fail fast rather
  // than burn all of Temporal's retry attempts. Match narrowly on the two stable,
  // GitHub-authored fragments to avoid misclassifying transient refusals as permanent.
  export function isPermanentPushPermissionRejection(stderr: string): boolean {
    const s = stderr.toLowerCase();
    return s.includes('refusing to allow a') && s.includes('without `workflow` scope');
  }
  ```

- In `push()`, when `result.exitCode !== 0`, build the existing message once and branch:

  ```ts
  if (result.exitCode !== 0) {
    const message = `GithubScmPort.push: git push failed: ${result.stderr}`;
    if (isPermanentPushPermissionRejection(result.stderr)) {
      throw ApplicationFailure.nonRetryable(message, 'GitPushPermissionError');
    }
    throw new Error(message);
  }
  ```

  The message format is unchanged (`GithubScmPort.push: git push failed: <stderr>`) so existing
  log/telemetry expectations and the human-readable cause are preserved; only the error *type* and
  retryability change for the permission case.

- **Verify:**
  - `pnpm --filter @agentops/ports typecheck` passes.
  - `pnpm lint` passes (no new lint violations from the import or the new export).

### 3. `packages/ports/src/github/github-scm-port.test.ts` — extend the `push` block

In `describe('GithubScmPort — push')`:

- **Keep** the existing "throws if the push fails" test, and tighten it to assert the generic
  (retryable) path: the thrown value is a plain `Error` and **not** an `ApplicationFailure` (e.g.
  assert `err` is instanceof `Error` but `(err as ApplicationFailure).type` is undefined / it is not
  an `ApplicationFailure` instance). The `'rejected'` stderr does not match the predicate, so it stays
  a generic `Error`.
- **Add** a test where `git.run` resolves `{ exitCode: 1, stderr: <real workflow-scope rejection> }`,
  using the actual GitHub string, e.g.:

  ```
  ! [remote rejected] agentops/t1 -> agentops/t1 (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)
  ```

  Assert the thrown value is an `ApplicationFailure` with `type === 'GitPushPermissionError'`,
  `nonRetryable === true`, and a `message` still containing the original stderr fragment.
- **Add** a direct unit test of `isPermanentPushPermissionRejection`: `true` for the "Personal Access
  Token" phrasing and the "OAuth App" phrasing (`refusing to allow an OAuth App to create or update
  workflow … without \`workflow\` scope`), `false` for a non-fast-forward stderr
  (`! [rejected] … (non-fast-forward)`) and for empty stderr.

  Import `ApplicationFailure` from `@temporalio/common` and the predicate from `./github-scm-port` in
  the test file.

- **Verify:**
  - `pnpm --filter @agentops/ports test` — the new and existing push tests pass.

## Final verification (Definition of Done)

Run from the repo root, per AGENTS.md §6:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`

All must be green. **e2e (`pnpm e2e`) is not required for this change**: it touches only
`packages/ports` (the GitHub adapter) and its package manifest — no `workflows`, `policies`,
`activities`, or `backends` source surface changes, and the `ScmPort` interface / `push` signature are
unchanged (`MemoryScmPort` and other implementations untouched). Commit with a `fix:` conventional
commit.

## Sequencing rationale

- **Step 1 (dependency) first** because it unblocks and de-risks everything downstream — the import in
  step 2 can't compile without it, and a workspace resolution problem is the only real unknown here.
- **Step 2 (source) before step 3 (tests)** so the exported predicate and the new throw exist for the
  tests to import and exercise. Steps 2 and 3 are logically one unit; if preferred they could be
  written test-first (TDD), but since the predicate must be `export`ed for the direct unit test to
  reference it, writing the source signature first avoids a red compile step in the test file. This
  ordering is a deliberate, low-cost choice — not a hard dependency.

## Assumptions

The design spec already resolved the substantive open questions; restated here as the decisions this
plan implements:

- **Which rejections count as permanent.** Match case-insensitively on both stable, GitHub-authored
  fragments together — `refusing to allow a` **and** `` without `workflow` scope `` — which covers the
  "Personal Access Token", "OAuth App", and "GitHub App" phrasings of the same missing-scope refusal
  without over-matching unrelated failures. Kept deliberately narrow; new phrasings can be added later
  if they surface, rather than guessing at strings GitHub doesn't emit.
- **Classification lives in `push()` (Approach A), not the activity (B).** The port is the only layer
  holding the git stderr and understanding what a push rejection means. Adding `@temporalio/common` to
  `packages/ports` is acceptable: `ApplicationFailure` is a plain value class, `no-restricted-imports`
  is off for `packages/ports/src/**`, the determinism ban applies only to `workflows`/`policies`, and
  `push()` only ever runs inside an activity — exactly where Temporal expects an `ApplicationFailure`.
- **Version pin.** Use `^1.11.0` for `@temporalio/common` to match `packages/activities` and avoid a
  second resolved version in the workspace.
- **Message format preserved.** The thrown message keeps the current
  `GithubScmPort.push: git push failed: <stderr>` form; only type + retryability change for the
  permission case.
- **Non-permission failures stay retryable.** Any non-zero exit not matching the predicate (including
  non-fast-forward races and `spawnFailed`) continues to throw the generic `Error`. `push()` does not
  currently branch on `spawnFailed` and this plan does not add one — a missing `git` binary is an
  environment defect, out of scope.
- **No interface change.** `push`'s signature and `Promise<void>` contract are unchanged; no other
  `ScmPort` implementation is touched.
