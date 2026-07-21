# Plan — Task issue-agentic-ops-engine-146

Goal: stop the Claude backend from passing `--dangerously-skip-permissions` on read-only stages
(`bughunt`), giving them a least-privilege permission profile instead, while leaving every write
stage byte-for-byte identical.

Design authority: `docs/superpowers/specs/issue-agentic-ops-engine-146-design.md` (Approach A —
a shared read-only-stage classifier in `packages/contracts`, consulted by the Claude backend's
`buildArgs` to swap the permission flag). This plan implements that design as written; it does not
re-litigate the approach.

## Steps

### Step 1 — Add the read-only-stage classifier to contracts (the seam everything else depends on)

- **File:** `packages/contracts/src/stage.ts`
- **Change:** Below `StageSchema`/`Stage`, add additive, pure metadata over the existing enum:
  - `export const READ_ONLY_STAGES = new Set<Stage>(['bughunt']);` (a `Set<Stage>`, so it stays
    exhaustively type-checked against the enum and adding `review`/`context`/`assess` later is a
    one-token edit).
  - `export function isReadOnlyStage(stage: Stage): boolean { return READ_ONLY_STAGES.has(stage); }`
  - A short comment stating *why* only `bughunt` is in the set today (least privilege for the
    read-only bughunt stage; other effectively-read-only stages deferred per the design's
    Assumptions) so a future reader sees the deferral is deliberate, not an oversight.
  - No change to `StageSchema` itself — this is metadata, not a vocabulary change.
- **Export:** `packages/contracts/src/index.ts` already does `export * from './stage';`, so the
  new symbols are re-exported automatically. Confirm no edit is needed there (it is not).
- **Verify:** `pnpm --filter @agentops/contracts typecheck` compiles (the `Set<Stage>` literal
  proves each member is a valid stage). Full assertion of behavior comes in Step 2.

### Step 2 — Lock the classification with an exhaustive unit test

- **File:** `packages/contracts/src/stage.test.ts` (exists; add a new `describe`)
- **Change:** Add `describe('isReadOnlyStage / READ_ONLY_STAGES', ...)` that iterates **every**
  member of `StageSchema.options` and asserts `isReadOnlyStage(stage) === (stage === 'bughunt')`.
  Driving the assertion off `StageSchema.options` (not a hand-copied list) means any future stage
  added to the enum forces an explicit decision here rather than silently defaulting. Also assert
  `READ_ONLY_STAGES` contains exactly `bughunt` (size + membership), which documents the deferral.
- **Verify:** `pnpm --filter @agentops/contracts test` — the new test passes; existing
  `stage.test.ts` cases stay green.

### Step 3 — Fork the permission flag in the Claude backend `buildArgs`

- **File:** `packages/backends/src/claude/claude-backend.ts`
- **Change:**
  - Add `isReadOnlyStage` to the existing type-only import line from `@agentops/contracts`. Note:
    it is currently `import type { ... }`; `isReadOnlyStage` is a runtime value, so split into a
    value import (`import { isReadOnlyStage } from '@agentops/contracts';`) alongside the existing
    `import type { AgentRunResult, BackendRunRequest } from '@agentops/contracts';`.
  - In `buildArgs`, replace the unconditional `'--dangerously-skip-permissions'` entry in the
    `args` array with a stage-driven choice, keeping the exact same slot/order for all other args
    (`-p`, `--output-format stream-json`, `--verbose`, `--model <model>`, then the permission
    flag, then optional `--effort`):
    - read-only stage → push `'--permission-mode', 'plan'` (primary profile per the design's
      flag-choice section: Claude Code's purpose-built read-only exploration mode).
    - otherwise → push `'--dangerously-skip-permissions'` exactly as today.
  - Extend the module comment above the `args` array to explain the fork and its rationale
    (least privilege: read-only stages must not receive the permission bypass; other args and
    their order are unchanged).
- **Verify:** `pnpm --filter @agentops/backends typecheck`; then Step 4's tests.

### Step 4 — Test both branches of the fork in the Claude backend

- **File:** `packages/backends/src/claude/claude-backend.test.ts`
- **Change:**
  - The existing "spawns claude with the expected flags" test uses `stage: 'implement'` and
    asserts the exact arg array including `--dangerously-skip-permissions`. Leave it unchanged — it
    is now the regression guard proving write stages are byte-for-byte identical.
  - Add a new test: run with `{ ...baseRequest, stage: 'bughunt' }` and assert the captured args
    (a) **contain** `--permission-mode` immediately followed by `plan`, and (b) do **not** contain
    `--dangerously-skip-permissions`, while still containing the unchanged
    `-p`/`--output-format`/`stream-json`/`--verbose`/`--model` args. Reuse the existing
    `fakeChildProcess` + `spawnFn` capture harness already in the file.
- **Verify:** `pnpm --filter @agentops/backends test` — new bughunt case passes, existing
  implement case still green.

### Step 5 — Prove the fork survives the K8s Job wrapper (regression + optional parity case)

- **File:** `packages/backends/src/k8s/k8s-job-runner.test.ts`
- **Change:**
  - The existing "builds the expected Job shape with shell-safe positional args" test
    (~lines 144–183) uses `stage: 'implement'` and asserts the container `command` includes
    `--dangerously-skip-permissions`. Leave it unchanged — regression guard that K8s write-stage
    Jobs are unaffected.
  - Add a parity case that builds a Job with `stage: 'bughunt'` and asserts the container
    `command` contains `--permission-mode plan` and not `--dangerously-skip-permissions`, proving
    the same `spec.buildArgs(req)` fork applies whether Claude runs as a local process or a K8s
    Job (design assumption: "The K8s runner needs no change"). Mirror the existing test's setup
    (`createClaudeCliSpec({ image: ... })`, same request shape with `stage` overridden).
- **Verify:** `pnpm --filter @agentops/backends test`.

### Step 6 — End-to-end verification of the real bughunt flow and profile selection

- **Files:** none (verification gate; may flip Step 3's flag to the fallback profile if needed).
- **Change:** Using the `verify` skill, exercise a real `whiteboxBugHunt` run against the pinned
  `claude` CLI image and confirm the read-only profile still yields a parseable `FINDINGS:` line
  (the workflow consumes the agent's text findings; the profile must not break output).
  - **If `--permission-mode plan` works headless under `-p`:** keep it (primary, strongest
    least-privilege option). Done.
  - **If plan mode misbehaves headless** (agent tries to exit plan mode / asks to proceed instead
    of emitting the final `FINDINGS:` line, or plan mode blocks the read-only `Bash` exploration
    the hunter relies on): switch Step 3's read-only branch to the documented fallback —
    `'--dangerously-skip-permissions', '--disallowedTools', 'Write Edit MultiEdit NotebookEdit'`
    (a hard deny that overrides the bypass, making file edits impossible while preserving today's
    exploration behavior). Update the Step 3 comment and the Step 4/Step 5 assertions to match the
    chosen flags before committing.
- **Contingency if the pinned CLI image cannot be exercised in this environment:** the design
  commits to plan mode as primary and records it as an assumption (it could not confirm plan
  mode's exact headless behavior in the design environment either). If a real bughunt run is not
  runnable here, keep `--permission-mode plan` (the strongest least-privilege choice), record in
  the PR description that end-to-end confirmation was not possible in this environment and that the
  documented fallback is the remediation if a live run later shows plan mode breaking findings, and
  do not silently downgrade to the fallback without evidence it is needed.

### Step 7 — Full green gate

- **Verify (definition of done):** from repo root,
  `pnpm lint && pnpm typecheck && pnpm test`. Because this change touches `backends` and
  `contracts`, also run `pnpm e2e` (per AGENTS.md hard rule 6: e2e must pass for changes touching
  workflows, policies, activities, or backends). All green before commit.

## Sequencing notes

- **Contracts first (Steps 1–2) is mandatory, not stylistic.** AGENTS.md hard rule 3 ("Contracts
  first") and the backend's dependency direction (`backends` depends on `@agentops/contracts`, not
  the reverse) mean the classifier must exist and be exported before the backend can import it.
  Step 3 will not typecheck otherwise. This is also the de-risking step: it's the one new seam;
  getting it and its exhaustive test right first means Steps 3–5 are a mechanical flag swap.
- **Backend change (Step 3) before its tests (Step 4)** only so the tests have something to import;
  they are effectively one unit and are verified together.
- **K8s parity (Step 5) after the process-runner tests (Step 4)** because it is the lower-value
  confirmation (same `buildArgs` seam, already proven in Step 4). The design marks the extra
  bughunt K8s case as nice-to-have; I keep it because it is cheap and directly validates the "K8s
  runner needs no change" assumption. The existing implement-stage K8s test is the load-bearing
  regression guard and needs no change either way.
- **End-to-end verification (Step 6) is deliberately last**, after the unit level is green,
  because it is the only step that can change the chosen flag: running it earlier would risk
  churning Step 3/4/5 assertions twice. It is placed before the final green gate (Step 7) so any
  flag flip is re-covered by the full suite.
- **Could not reorder:** Step 7 (full lint/typecheck/test/e2e) must be last — it is the aggregate
  gate over everything above.

## Assumptions

Resolved myself (unattended run; nobody to ask). Most trace directly to the design's own
Assumptions section; the plan-specific ones are the last two.

- **Scope is `bughunt` only.** `READ_ONLY_STAGES` starts as `{'bughunt'}`. `context`/`assess`/
  `review` are effectively read-only too but are an explicit one-line follow-up, not part of this
  change, to avoid altering stages that may rely on write/execute access (per design).
- **Classifier home is `packages/contracts`, beside `StageSchema`** — not `packages/policies`.
  Read-only-ness is stage-vocabulary metadata; contracts already exports non-schema constants and
  `backends` already depends on it, so no new dependency edge is introduced (per design).
- **Primary flag is `--permission-mode plan`; fallback is
  `--dangerously-skip-permissions --disallowedTools "Write Edit MultiEdit NotebookEdit"`.** The
  implementer picks the fallback only if Step 6 shows plan mode breaks headless findings (per
  design's flag-choice section).
- **`pi` and other backends are out of scope.** `pi`'s `buildArgs` passes no permission-bypass
  flag today, so the reported defect does not exist there; hardening `pi` is a separate follow-up
  (per design).
- **`isReadOnlyStage` must be a value import, not a type import (plan-specific).** The Claude
  backend currently uses `import type { ... } from '@agentops/contracts'`. `isReadOnlyStage` is a
  runtime function, so a `type`-only import would fail; Step 3 adds a separate value import. I
  export both `READ_ONLY_STAGES` and `isReadOnlyStage` (the design says "and/or") so the predicate
  is used by the backend while the set stays directly testable and cheaply extensible.
- **Tests assert presence/absence and adjacency, not a new frozen full-array snapshot for
  bughunt (plan-specific).** The implement-stage exact-array test remains the strict order guard;
  the bughunt test asserts `--permission-mode` is immediately followed by `plan` and that the
  bypass is absent. This keeps the bughunt case robust to the Step 6 flag flip touching only the
  permission slot, without weakening the write-stage guarantee.
