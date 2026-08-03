# Plan — issue-agentic-ops-engine-129

[bughunt] Unsanitized PR head branch name enables git argument injection.

Implements design `docs/superpowers/specs/issue-agentic-ops-engine-129-design.md`
(approach **B**: one shared `GitRefNameSchema` validating the branch/ref name at the
contract boundary + gateway parsers + a defense-in-depth guard in the workspace manager).

The single decisive invariant: **a branch/ref value must never be parseable by `git` as an
option** (most concretely, must not begin with `-`), and more generally must be a
well-formed git ref name per `git check-ref-format`'s disallow rules.

## Steps

### 1. New validator module `packages/contracts/src/git-ref.ts`

- Add a pure predicate `isValidGitRefName(name: string): boolean` implementing
  `git check-ref-format`'s denylist. Reject, at minimum:
  - a value beginning with `-` (the option-injection case) — **security-decisive**;
  - the empty string;
  - ASCII control chars (0x00–0x1F), DEL (0x7F), and space;
  - the git-forbidden metacharacters `~ ^ : ? * [ \`;
  - `..` anywhere; `@{` anywhere; a lone `@`;
  - a leading `/`, trailing `/`, or `//` (empty path components);
  - any slash-separated component beginning with `.` (covers leading `.`);
  - a trailing `.`; a trailing `.lock` (or any component ending `.lock`).
- Export `GitRefNameSchema = z.string().refine(isValidGitRefName, { message: … })` built on
  the same predicate, so the schema and the plain predicate share one rule set (single
  source of truth). Follow the existing `sha256.ts` style for a small pure contracts helper.
- **Placement rationale:** contracts is the leaf package (policies/activities/gateway all
  depend on it), so this is importable everywhere without a dependency cycle; the
  `headBranch` schemas in this same package must consume it.
- **Verify:** covered by the tests in step 2 + `pnpm --filter @agentops/contracts typecheck`.

### 2. Exhaustive unit tests `packages/contracts/src/git-ref.test.ts`

- **Accepts** ordinary/real-world branches: `feature/x`, `release-1.2`, `user.name/fix`,
  `main`, `dependabot/npm_and_yarn/foo-1.2.3`, and a non-ASCII branch (e.g. `feature/café`)
  to confirm we do not force ASCII-only.
- **Rejects** each attack/edge case: leading dash (`--upload-pack=/tmp/x`, `-x`,
  `--exec=…`), space (`a b`), a control char, each forbidden metachar (`~ ^ : ? * [ \`),
  `a..b`, `@{`, lone `@`, leading `/`, trailing `/`, `a//b`, component starting `.`
  (`.hidden`, `foo/.bar`), trailing `.` (`foo.`), trailing `.lock` (`foo.lock`), and the
  empty string.
- Assert both `isValidGitRefName(...)` and `GitRefNameSchema.safeParse(...).success` agree
  on every case (guards against the schema and predicate drifting apart).
- **Verify:** `pnpm --filter @agentops/contracts test` — new file green.

### 3. Re-export from `packages/contracts/src/index.ts`

- Add `export * from './git-ref';` alongside the existing re-exports.
- **Verify:** `pnpm --filter @agentops/contracts typecheck`; that downstream imports
  (`@agentops/contracts` → `GitRefNameSchema` / `isValidGitRefName`) resolve in later steps.

### 4. Tighten the `headBranch` contract fields

- `packages/contracts/src/pr-landing.ts`:
  - `PrSnapshotSchema.headBranch`: `z.string().min(1)` → `GitRefNameSchema`.
  - `PrLandingInputSchema.headBranch`: `z.string().min(1).optional()` →
    `GitRefNameSchema.optional()`.
- `packages/contracts/src/dev-cycle-pr-repair.ts`:
  - `DevCyclePrRepairInputSchema.headBranch`: `z.string().optional()` →
    `GitRefNameSchema.optional()`.
- These are the workflow-input/boundary schemas, so any `parse()`d input carrying a hostile
  branch is rejected automatically at every consumer.
- **Verify:** `pnpm --filter @agentops/contracts test` (existing `pr-landing.test.ts` /
  `dev-cycle-pr-repair.test.ts` still green — their fixtures use `feature/x`,
  `agentops/...` which remain valid). Add/confirm a rejection case for a leading-dash
  `headBranch` in the relevant existing contract test. Then full `pnpm typecheck` to catch
  any consumer that relied on the looser type.

### 5. Reject hostile branch at the gateway ingestion parsers

- `packages/gateway/src/parse-pr-landing-event.ts`: in `buildEvent`, the existing guard
  `if (!repo || prNumber === undefined || !headBranch) return null;` — extend so a present
  `headBranch` that fails `isValidGitRefName(headBranch)` also returns `null` (same
  invalid-event path → no workflow started).
- `packages/gateway/src/parse-pr-review-event.ts`: `headBranch` is optional here. Where it
  is read (`const headBranch = body.pull_request?.head?.ref;`), if present but invalid,
  reject the event (`return null`) rather than forwarding an unusable branch — consistent
  with the landing parser and with the design's "reject, don't coerce" decision.
- **Verify:** extend `parse-pr-landing-event.test.ts` and `parse-pr-review-event.test.ts`
  with a case: payload whose `pull_request.head.ref` is `--upload-pack=/tmp/x` ⇒ parser
  returns `null`; a normal branch still parses. `pnpm --filter @agentops/gateway test`.

### 6. Defense-in-depth guard in `workspace-manager.prepare()`

- `packages/activities/src/workspace/workspace-manager.ts`: at the top of `prepare()`,
  before computing `branch` or running any git command, validate the two externally-derived
  ref inputs:
  - if `headBranch !== undefined && !isValidGitRefName(headBranch)` → throw
    `new WorkspaceError(\`invalid headBranch: ...\`, /* nonRetryable */ true)`;
  - if `headRef !== undefined && !isValidGitRefName(headRef)` → same (defense-in-depth; the
    current caller always constructs a safe `refs/pull/<n>/head`, but validating is free and
    guards future refactors).
- Marked `nonRetryable: true` — a malformed ref never becomes valid on retry.
- This guarantees no git sink in this file (`fetch origin <branch>`, `worktree add -B/-b`,
  `branch -D`) nor the transitively-derived `push --force origin <branch>` in
  `github-scm-port.ts` ever receives an option-like ref, regardless of caller.
- Elide the offending value or annotate it as invalid in the message (avoid echoing raw
  attacker input verbatim into logs beyond what's needed to diagnose).
- **Verify:** add a case to `packages/activities/src/workspace/workspace-manager.test.ts`:
  `prepare(taskId, repo, undefined, '--upload-pack=/tmp/x')` rejects with a `WorkspaceError`
  (`nonRetryable === true`) and the git runner's `run` is **never** called with the hostile
  value (assert the mock/fake runner received no fetch/worktree call). `pnpm --filter
  @agentops/activities test`.

### 7. Full green + docs

- Run the repo gate: `pnpm lint && pnpm typecheck && pnpm test`.
- Run `pnpm e2e` (change touches activities/contracts/gateway — e2e applicability per
  AGENTS.md DoD).
- No product-behavior/lifecycle change ⇒ `docs/software-lifecycle-vision.md` unchanged; the
  design note already records the decision. No new TODOs.
- **Verify:** all commands green.

## Sequencing notes

- **Validator (steps 1–3) first** because everything else imports it; it is the de-risking
  unblock. Its own correctness is proven by step 2's exhaustive tests before any consumer
  depends on it, so a grammar bug surfaces immediately in isolation rather than as a
  confusing downstream failure.
- **Contract tightening (4) before parsers/guard (5–6):** the boundary schema is the primary
  fix; the parser (5) and workspace guard (6) are the additional independent layers. They
  could be implemented in any order relative to each other — 5 and 6 have no dependency
  between them — but both must come after the shared validator exists (step 3).
- **Guard (6) intentionally kept even though 4+5 already reject** hostile input: it is the
  design's belt-and-suspenders layer ensuring no code path reaches a git call with an
  unvalidated ref if a future caller bypasses the contract. Not reordered earlier because it
  depends on the same shared predicate.
- **Repo-wide gate (7) last**, as it validates the whole assembled change.

## Assumptions

- **Grammar authority.** No existing repo convention for git-ref validation, so I mirror
  `git check-ref-format`'s documented disallow rules as a **denylist** (not a narrow
  allowlist) to minimise false rejection of legitimate GitHub branches. Assumption: mirroring
  git's own rules will not reject real-world branches teams use.
- **Non-ASCII allowed.** GitHub and git both permit some non-ASCII branch names; the
  validator does not force ASCII-only — only git-forbidden/option-like forms are rejected. A
  test pins this so a future "tighten to ASCII" change is a deliberate contract change.
- **Predicate + schema share one rule set.** I expose both a plain `isValidGitRefName`
  predicate (for the non-zod gateway parsers and the workspace guard) and a
  `GitRefNameSchema` built on it, rather than duplicating the grammar, so the three
  enforcement layers can never diverge.
- **Rejection over coercion at the gateway.** For both parsers, a present-but-invalid
  `headBranch` rejects the event (returns `null`, the existing invalid-event path) rather
  than stripping/normalising it — a PR with a hostile branch name should not be processed at
  all (design §Error handling).
- **`headRef` validated too.** Though the current `checkoutRef` construction is always safe
  (`refs/pull/<n>/head`), the workspace guard validates `headRef` as well; it is free and
  removes a future-refactor foot-gun.
- **`nonRetryable: true`** for the workspace guard: a validation defect is permanent, so the
  activity fails fast instead of consuming Temporal retries.
