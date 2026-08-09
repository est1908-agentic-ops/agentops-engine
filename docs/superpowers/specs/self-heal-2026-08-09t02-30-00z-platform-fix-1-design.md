# Design — Task self-heal-2026-08-09t02-30-00z-platform-fix-1

## Goal

`GithubScmPort.push()` currently maps *any* non-zero `git push` exit code to a generic
`Error`. When GitHub permanently rejects a push — most notably the
`refusing to allow a Personal Access Token to create or update workflow \`.github/workflows/…\`
without \`workflow\` scope` rejection, and the sibling "refusing to allow … OAuth App … without
`workflow` scope" variant — that generic `Error` is retryable, so the enclosing `pushBranch`
activity burns all 5 of Temporal's `maximumAttempts` re-running a push that can never succeed
until a human changes the token's scopes. The workflow ends up looking like a flaky
infrastructure failure instead of a clear "your token is missing the `workflow` scope" cause.

Make `push()` recognize these permanent, permission-based push rejections and surface them as a
**non-retryable** Temporal failure typed `GitPushPermissionError`, mirroring the
`ProcessCliAuthError → ApplicationFailure.nonRetryable(err.message, 'AuthError')` classification
already used in `packages/activities/src/create-activities.ts`. Every other push failure
(non-fast-forward races, transient network/`git` spawn errors) must keep its current retryable
behavior so Temporal can still absorb genuinely transient failures.

## Approaches considered

### A. Throw `ApplicationFailure.nonRetryable(..., 'GitPushPermissionError')` directly in `push()`

Detect the permission-rejection substring in `result.stderr` inside `push()` and throw
`ApplicationFailure.nonRetryable(message, 'GitPushPermissionError')` for the permission case,
keeping the existing generic `throw new Error(...)` for everything else.

- **Trade-off:** `packages/ports` gains a dependency on `@temporalio/common` (currently it has
  none). That couples a port to the Temporal SDK, whereas today the Temporal-classification
  boundary lives one layer up in `activities`.
- **Cost:** Small. One dependency line in `packages/ports/package.json`, one import, one
  branch in `push()`, plus tests. This is exactly what the goal statement prescribes
  (`throw a Temporal ApplicationFailure.nonRetryable(..., 'GitPushPermissionError')`).

### B. Throw a plain typed error in `push()`, classify it in the `pushBranch` activity

Define a plain `GitPushPermissionError extends Error` in `packages/ports`, throw it from
`push()` on the permission case, and add a `catch` in `create-activities.ts` `pushBranch` that
converts it to `ApplicationFailure.nonRetryable(err.message, 'GitPushPermissionError')` — a
byte-for-byte structural clone of the existing `ProcessCliAuthError` handling.

- **Trade-off:** Keeps `packages/ports` free of any Temporal import (the classification stays in
  the activities layer, which is the one place that already speaks Temporal). But it spreads the
  change across two packages and two files, and the port now emits an error type whose only
  purpose is to be re-thrown as something else.
- **Cost:** Small-to-medium. Two files + a new exported error class + tests in both
  `ports` and `activities`.

### C. Add stderr classification to `GitCommandRunner`/`GitCommandResult`

Extend `GitCommandResult` with a machine-readable "permanent permission rejection" flag (like the
existing `spawnFailed`) computed by the git runner, and have `push()` branch on that flag.

- **Trade-off:** Most general (any future caller of `git.run` benefits), but by far the widest
  blast radius: it changes a shared contract type, every `GitCommandRunner` implementation, and
  needs the classification logic to live in a component that today is a thin exec wrapper. Wildly
  out of proportion to a single push-path fix.
- **Cost:** High relative to value.

## Chosen approach

**Approach A** — throw `ApplicationFailure.nonRetryable(message, 'GitPushPermissionError')`
directly from `push()`.

Why over B: the goal statement is explicit that `push()` itself should throw the Temporal
`ApplicationFailure.nonRetryable`, and the failure is intrinsic to the push operation — the port
is the only place with the git stderr in hand and the only component that understands *what a
push rejection means*. Classifying in the activity (B) would force the port to invent a
throwaway error type solely so the activity can rename it, adding a second file and an indirection
with no behavioral benefit. The `ProcessCliAuthError` split exists in the backend case only
because the process runner is a generic CLI executor that can't know an auth error is fatal to
*its* caller; `push()` has no such ambiguity. The "match the existing nonRetryable pattern"
instruction refers to the *classification shape* (`ApplicationFailure.nonRetryable(message, type)`
for a definitively-permanent failure), which A reproduces exactly.

Why over C: C changes a cross-package contract and every runner implementation to solve a
one-call-site problem. It's the right tool only if multiple git operations needed permanent-vs-
transient classification, which they don't today.

The one real cost of A — a new `@temporalio/common` dependency in `packages/ports` — is
acceptable: `ApplicationFailure` from `@temporalio/common` is a plain value class (not the
workflow/determinism-sensitive part of the SDK), `create-activities.ts` already imports it from
the same package, and no repo hard rule forbids `ports` from importing Temporal (the determinism
ban in AGENTS.md §1 applies to `packages/workflows`, not `ports`). `push()` only ever runs inside
an activity, so throwing an `ApplicationFailure` there is exactly where Temporal expects to see one.

## Assumptions

- **Which rejections count as permanent.** The issue names the `workflow`-scope PAT rejection
  specifically. I will match on the stable, GitHub-authored fragment
  `refusing to allow a` combined with `without \`workflow\` scope`, which covers both the
  "Personal Access Token" and "OAuth App"/"GitHub App" phrasings of the same underlying
  missing-scope rejection while not over-matching unrelated failures. Detection is
  case-insensitive and tolerant of surrounding text. Rationale: these are the only push
  rejections GitHub emits that are permanent *and* fixable only by changing token scopes; a
  broader "any 403-ish push error" match risks misclassifying transient server-side refusals as
  permanent. I am deliberately keeping the matcher narrow and adding new phrasings later if they
  surface, rather than guessing at strings GitHub doesn't actually emit.
- **Message content.** The thrown `ApplicationFailure` message preserves the current format
  (`GithubScmPort.push: git push failed: <stderr>`) so existing log/telemetry expectations and
  the human-readable cause are unchanged; only the error *type* and retryability change for the
  permission case.
- **Non-permission failures stay retryable.** Any non-zero exit that does not match the
  permission pattern (including non-fast-forward rejections and `spawnFailed`) continues to throw
  the generic `Error`, preserving today's retry behavior. I am not expanding scope to reclassify
  other failure modes.
- **No `ScmPort` interface change.** The `push` signature and its `Promise<void>` contract are
  unchanged; `MemoryScmPort` and other implementations are untouched. This is a behavior change
  confined to the GitHub adapter.

## Design

**Scope:** one coherent change, confined to the GitHub SCM adapter and its package manifest.

### Files affected

1. **`packages/ports/package.json`** — add `@temporalio/common` (`^1.11.0`, matching the version
   already used in `packages/activities`) to `dependencies` so `push()` can import
   `ApplicationFailure`.

2. **`packages/ports/src/github/github-scm-port.ts`**
   - Add `import { ApplicationFailure } from '@temporalio/common';`.
   - Add a small module-level pure predicate, `isPermanentPushPermissionRejection(stderr: string):
     boolean`, next to the other module-level helpers (e.g. near `isNotAccessible`), that
     implements the case-insensitive substring match described under Assumptions. Keeping it as a
     named, exported-for-test function mirrors the existing `mapCheckRuns` / `mergeCiSignals`
     style and lets the classification be unit-tested directly.
   - In `push()`, when `result.exitCode !== 0`, build the existing
     `GithubScmPort.push: git push failed: <stderr>` message once, then:
     - if `isPermanentPushPermissionRejection(result.stderr)` → `throw
       ApplicationFailure.nonRetryable(message, 'GitPushPermissionError');`
     - otherwise → `throw new Error(message);` (unchanged behavior).

### Data / control flow

`dev-cycle` (and `pr-landing`) → `activities.pushBranch` → `deps.scm.push` (this method) →
`git.run(['push','--force',…])`. On a permission rejection, `push()` now throws a non-retryable
`ApplicationFailure`; because `pushBranch` does not catch it, Temporal receives a non-retryable
failure and fails the activity immediately (attempt 1 of 5) instead of retrying to exhaustion.
The workflow-level handling of a failed `pushBranch` is unchanged — it simply surfaces sooner and
with a clear `GitPushPermissionError` type/cause.

### Error handling / edge cases

- **Transient failures unaffected:** network blips, lock contention, non-fast-forward races → no
  pattern match → generic retryable `Error`, same as today.
- **`spawnFailed`:** `push()` doesn't currently branch on `spawnFailed`; it stays a generic
  `Error` (retryable), unchanged. (A missing `git` binary is an environment defect, out of scope
  here.)
- **Empty/partial stderr:** predicate returns `false` on any input lacking both required
  fragments, so it can never misclassify a rejection with no usable message as permanent.

### Tests

In `packages/ports/src/github/github-scm-port.test.ts`, extend the existing
`GithubScmPort — push` block:
- keep the current "throws if the push fails" generic case (assert it is a plain `Error`, i.e.
  *not* a non-retryable `ApplicationFailure`);
- add a case where `git.run` resolves a non-zero exit with the real GitHub `workflow`-scope
  rejection stderr, and assert the thrown value is an `ApplicationFailure` with
  `type === 'GitPushPermissionError'` and `nonRetryable === true`, and that the message still
  contains the original stderr;
- optionally add a direct unit test of `isPermanentPushPermissionRejection` for both matching
  phrasings and a non-matching "non-fast-forward" stderr.

`pnpm lint && pnpm typecheck && pnpm test` must pass; no e2e-affecting surface (workflows/policies)
changes.

## Brainstorm Summary

```markdown
## Brainstorm Summary
**Approaches considered:** (A) throw `ApplicationFailure.nonRetryable` directly from `push()`; (B) throw a plain typed error in the port and reclassify it in the `pushBranch` activity (mirroring `ProcessCliAuthError`); (C) add permanent-vs-transient classification to the shared `GitCommandRunner` contract.
**Chosen approach:** A — detect GitHub's `workflow`-scope push rejection in `push()`'s stderr and throw `ApplicationFailure.nonRetryable(message, 'GitPushPermissionError')`, leaving all other failures as today's retryable generic `Error`.
**Why (decisive reasons):** The goal explicitly asks `push()` itself to throw the non-retryable failure; the port is the only layer holding the git stderr and understanding what a rejection means, so B's throwaway error type adds a file and indirection with no behavioral gain, and C rewrites a cross-package contract for a single call site. Adding `@temporalio/common` to `ports` is cheap and violates no repo rule (the determinism ban is workflows-only).
**Key risks/assumptions:** Detection matches the narrow, GitHub-authored fragment `refusing to allow a … without \`workflow\` scope` (case-insensitive), deliberately kept narrow to avoid misclassifying transient refusals as permanent; message format and the `ScmPort` interface are unchanged.
```
