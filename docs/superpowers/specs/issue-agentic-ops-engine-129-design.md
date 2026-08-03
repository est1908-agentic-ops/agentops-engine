# Design — issue-agentic-ops-engine-129

## Goal

Close a git **argument-injection** vulnerability: the PR head branch name
(`pull_request.head.ref`) flows untouched from GitHub webhook/API data into `git`
argument arrays executed by `child_process.spawn('git', args)`. Because no call site
terminates option parsing and the value is never validated, a branch name beginning
with `-` (e.g. `--upload-pack=<cmd>`) is interpreted by `git` as an option/flag rather
than a ref — turning "open a PR from a fork" into arbitrary git-option control, and via
`fetch --upload-pack`/`--exec` into command execution on the worker.

There is no shell interpolation (args are arrays), so this is *argument* injection, not
shell injection. The single decisive invariant to enforce is therefore: **a branch/ref
value must never be parseable by git as an option** — most concretely, it must not begin
with `-` — and more generally must be a well-formed git ref name.

## Attack surface (as traced)

Untrusted value: `headBranch = pr.head.ref`, read at:
- `packages/gateway/src/parse-pr-landing-event.ts:47`
- `packages/gateway/src/parse-pr-review-event.ts:36`
- `packages/ports/src/github/github-scm-port.ts:185` (`getPrSnapshot`)

It reaches these `git` sinks in `packages/activities/src/workspace/workspace-manager.ts`
(`prepare`) and one in `github-scm-port.ts`:
- `git fetch origin <branch>` — line 107 (bare positional: the primary injection point)
- `git worktree add … -B <branch> origin/<branch>` — lines 103/109/114/120
- `git branch -D <branch>` — line 297 (in `reclaimStaleWorktree`)
- `git push --force origin <branch>` — `github-scm-port.ts:287` (branch derives from the
  prepared workspace branch, i.e. the same `headBranch`)

`headRef` reaching line 96 is always the constructed `refs/pull/<n>/head` (from
`checkoutRef`), so it is not attacker-controlled — but it is still validated as
defense-in-depth (it is a plausible future refactor risk, and validating it is free).

## Approaches considered

**A. `--end-of-options` / `--` sentinels at each git call site.**
Insert git's end-of-options marker before positional refs (`git fetch origin
--end-of-options <branch>`, etc.) so a leading-dash value can't be parsed as a flag.
- *Trade-off:* Robust and git-native, but requires git ≥ 2.24 for `--end-of-options`;
  must be applied at *every* sink (easy to miss one — e.g. the `push` in `scm-port`);
  and it silently *accepts* malformed refs, deferring failure to a cryptic deep git
  error instead of rejecting bad input cleanly at the edge. Does nothing for the
  `origin/<branch>` refspec case where the branch is embedded mid-string.

**B. (chosen) Validate the branch/ref name once, at the contract boundary, with a shared
zod schema.** Add a `GitRefNameSchema` to `packages/contracts` implementing git's
ref-format rules (crucially: reject a leading `-`, control chars, whitespace, and the
git-forbidden metacharacters). Use it to tighten every `headBranch` field, and reuse it
to reject bad names at the gateway ingestion parsers, plus a defense-in-depth guard in
`workspace-manager.prepare()` before any git call.
- *Trade-off:* Must encode the ref-format grammar correctly (risk of rejecting an
  unusual-but-legitimate branch). Mitigated by mirroring `git check-ref-format`'s
  documented *denylist* rather than a narrow allowlist, so false rejections are unlikely,
  and by covering all sinks at once from a single source of truth.

**C. Sanitize/guard inside `workspace-manager` only (single choke point at the sink).**
Reject invalid `branch`/`headRef` just before the git calls in one file.
- *Trade-off:* Closest to the sink, one file — but leaves the `push` sink in `scm-port`
  and any future sink uncovered, surfaces failures as deep workspace errors rather than a
  clean rejected webhook, and puts security-critical logic in an activity instead of at
  the validated boundary. Against repo hard-rule #3 (contracts-first).

## Chosen approach — B, with a defense-in-depth guard

B is chosen because it fixes the class of bug at the boundary (repo hard rule #3:
"contracts first … zod-validated at boundaries"), gives a single tested source of truth
reusable by every current and future sink, and rejects bad input with a clean 4xx-style
failure at the webhook edge instead of a cryptic git crash deep in an activity. A over B
was rejected for being sink-by-sink (miss-prone) and for accepting malformed refs; C was
rejected for leaving sinks uncovered and for locating security logic away from the
boundary. We additionally keep C's spirit as a cheap belt-and-suspenders guard inside
`workspace-manager` (a validated boundary is only as good as its enforcement; the guard
ensures no code path reaches a git call with an unvalidated ref even if a future caller
bypasses the contract).

## Design — what changes

1. **`packages/contracts/src/git-ref.ts` (new).** Export `GitRefNameSchema` — a
   `z.string()` refined to accept only well-formed git ref names, following
   `git check-ref-format`'s disallow rules. The security-decisive checks: reject a value
   beginning with `-`; reject ASCII control chars, DEL, space, and `~ ^ : ? * [ \`; reject
   `..`, leading/trailing `/`, `//`, components beginning with `.`, `@{`, a lone `@`, and a
   trailing `.` or `.lock`. Also export `isValidGitRefName(name: string): boolean` as a
   plain predicate over the same rule set for non-zod call sites. Contracts is the leaf
   package (policies/activities/gateway all depend on it), so this is importable
   everywhere without a dependency cycle.

2. **`packages/contracts/src/git-ref.test.ts` (new).** Exhaustive unit tests: accepts
   ordinary branches (`feature/x`, `release-1.2`, `user.name/fix`), and rejects each
   attack/edge case — leading dash (`--upload-pack=…`, `-x`), spaces, control chars, the
   forbidden metacharacters, `..`, `@{`, trailing `.lock`, empty string.

3. **`packages/contracts/src/index.ts`.** Re-export the new module.

4. **Tighten the `headBranch` fields** to use `GitRefNameSchema` in place of
   `z.string().min(1)`:
   - `packages/contracts/src/pr-landing.ts` — `PrSnapshotSchema.headBranch` (required) and
     `PrLandingInputSchema.headBranch` (optional).
   - `packages/contracts/src/dev-cycle-pr-repair.ts` — `DevCyclePrRepairInputSchema.headBranch`
     (optional).
   These are the workflow-input/boundary schemas, so any parsed input with a hostile
   branch is rejected automatically wherever the contract is `parse()`d.

5. **Reject at the ingestion parsers** (untrusted webhook edge):
   `packages/gateway/src/parse-pr-landing-event.ts` and `parse-pr-review-event.ts` already
   treat a missing `headBranch` as a parse failure. Extend that guard: when `headBranch`
   is present but fails `GitRefNameSchema`/`isValidGitRefName`, treat the event as invalid
   (same failure path as a missing field) so the webhook is refused before a workflow is
   ever started. This turns a would-be deep-activity crash into a clean, logged rejection.

6. **Defense-in-depth guard** in
   `packages/activities/src/workspace/workspace-manager.ts` `prepare()`: before computing
   `branch`/running any git command, if `headBranch` (when provided) or `headRef` (when
   provided) fails validation, throw `WorkspaceError(…, /* permanent */ true)` — a
   validation defect is not retryable. This guarantees no git call in this file, or the
   transitively-derived `push` in `scm-port`, ever receives an option-like ref, regardless
   of caller.

### Data flow after the change

GitHub webhook → gateway parser (validates `headBranch`, refuses if hostile) → workflow
input contract (`GitRefNameSchema`, refuses on parse) → `prepareWorkspace` activity →
`workspace-manager.prepare()` (final guard) → `git` sinks. Three independent layers, all
sharing one schema; the first to see a bad name rejects it.

### Error handling

- Gateway: invalid branch → event rejected on the existing invalid-event path (no
  workflow start), logged with the offending value elided/annotated as invalid.
- Contract parse: standard zod error at the boundary (existing behavior for schema
  violations).
- Workspace manager: `WorkspaceError` marked permanent (non-retryable), since a bad ref
  name will never become valid on retry.

### Out of scope / not changed

- No change to how git is spawned (`SpawnGitCommandRunner`) — args remain an array; we do
  not add shell usage.
- We are not broadly adding `--end-of-options` to every git call (approach A). It could be
  layered later as extra hardening, but validation makes it redundant for this bug and
  bundling it would widen the change without additional security benefit.
- `checkoutRef`/`headRef` construction is unchanged (already safe); it is only validated.

## Assumptions

- **Grammar source.** No repo convention exists for git-ref validation, so I follow
  `git check-ref-format`'s documented rules as the authority, implemented as a denylist to
  minimize false rejections of legitimate GitHub branch names. Assumption: mirroring git's
  own rules will not reject real-world branches teams use in practice.
- **Validator placement.** I place the schema in `packages/contracts` (the leaf package)
  rather than `packages/policies`, because contracts must consume it in `headBranch`
  schemas and contracts may not import policies (dependency direction is policies →
  contracts). Assumption: a small pure validator co-located with the schemas that use it
  is acceptable in contracts (consistent with existing helpers like `sha256`).
- **Gateway rejection semantics.** I assume rejecting the webhook (same as a
  missing-field parse failure) is preferable to silently coercing/skipping the branch —
  a PR with a hostile branch name should not be processed at all.
- **Non-ASCII branches.** GitHub permits some non-ASCII branch names; git's rules allow
  them too (they are not in the forbidden set). The validator does not force ASCII-only,
  so such branches keep working; only the git-forbidden/option-like forms are rejected.
- **Scope.** This is one coherent change: a single security fix (validate one untrusted
  value class at its boundary) touching a new contracts module plus the schemas/parsers
  that consume it. No unrelated work is bundled.

## Self-review

- No placeholders or TBDs.
- Layers are consistent: all three enforcement points use the one `GitRefNameSchema`; the
  "not changed" list does not contradict the enforcement list.
- Scope is a single vulnerability class fix — stated explicitly above.

## Brainstorm Summary
**Approaches considered:** (A) sprinkle `git --end-of-options`/`--` at each call site; (B) one shared zod `GitRefNameSchema` validating the branch name at the contract boundary + gateway parsers + a defense-in-depth guard in the workspace manager; (C) sanitize only inside the workspace manager at the sink.
**Chosen approach:** B — validate the untrusted branch/ref name once, at the boundary, with a shared schema.
**Why (decisive reasons):** Fixes the whole class at the boundary (repo hard-rule "contracts-first"), single tested source of truth reusable by every current/future git sink (fetch, worktree, branch -D, push), and rejects hostile input cleanly at the webhook edge instead of crashing deep in an activity. A is miss-prone and accepts malformed refs; C leaves the `push` sink and future sinks uncovered.
**Key risks/assumptions:** The validator mirrors `git check-ref-format` as a denylist to avoid rejecting legitimate (incl. non-ASCII) branches; the security-decisive rule is "no leading dash + no control/metachars." Placed in `packages/contracts` (leaf pkg) to avoid a dependency cycle.
