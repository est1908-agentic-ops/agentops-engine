# Design — Task issue-agentic-ops-engine-146

## Goal

The Claude backend's `buildArgs` unconditionally appends `--dangerously-skip-permissions`
to every `claude` invocation (`packages/backends/src/claude/claude-backend.ts:103`). That
flag bypasses all tool-permission checks, granting full write/execute capability. The
`bughunt` stage is read-only by design — its prompt (`packages/prompts/templates/whitebox-bughunt.md`)
tells the agent "read-only analysis only... do not run commands that modify files", and the
workflow (`packages/workflows/src/whitebox-bughunt.ts`) only ever consumes the agent's text
findings; nothing it produces is written back to the repo. Giving that stage the ability to
mutate the workspace violates least privilege. We want read-only stages to run the Claude CLI
with a permission profile that permits exploration but forbids file mutation, while write
stages (`implement`, `full_verify`, `pr`, `design`, `plan`, ...) keep their current behavior.

## Approaches considered

**A. Stage-driven permission profile: a shared read-only-stage classification + a flag swap in the Claude backend.**
Add a small pure classifier co-located with the stage vocabulary in `packages/contracts`
(the single source of truth for `StageSchema`), e.g. `READ_ONLY_STAGES` / `isReadOnlyStage(stage)`.
The Claude backend's `buildArgs` consults it: read-only stages get a read-only permission mode
instead of `--dangerously-skip-permissions`; every other stage is unchanged.
Trade-off: introduces one new seam and one behavioral fork in `buildArgs`. Cost: small,
well-testable, and generalizes to future read-only stages and to the `pi` backend later.

**B. Hardcode the check inside the Claude backend (`if (req.stage === 'bughunt')`).**
No shared classifier — the stage list lives inline in the vendor file.
Trade-off: the "which stages are read-only" fact — a property of the stage vocabulary, not a
Claude-specific detail — gets buried in one backend and can't be reused by `pi`/`stub`/future
backends. Cheapest to write, but scatters a cross-cutting fact and drifts. Rejected.

**C. Add an explicit `permissionProfile: 'read-only' | 'full'` field to `BackendRunRequest`, decided upstream by the activity/workflow.**
Most flexible (per-call override) but wider blast radius: touches the contract schema, the
activity that builds `BackendRunRequest`, and every construction site; and it pushes a
CLI-permission decision up into the workflow/activity layer, which shouldn't know about vendor
permission semantics. Overkill for a scoped least-privilege fix. Rejected.

## Chosen approach

**Approach A.** It fixes the literal defect (read-only stages no longer receive
`--dangerously-skip-permissions`), keeps the classification in one place tied to the stage
vocabulary, is trivially unit-testable, and leaves write stages byte-for-byte identical so
their existing exact-argument tests stay green. B was rejected for burying a cross-cutting fact
in a vendor file; C was rejected for a large blast radius and for placing a CLI-permission
decision at the wrong layer.

### Flag choice for the read-only profile

The replacement must (a) drop `--dangerously-skip-permissions`, (b) still let the agent read,
grep, and glob the tree freely without permission prompts (the CLI runs headless under `-p`,
so nothing can answer a prompt — an un-answered prompt is a denial), and (c) forbid file
mutation.

- **Chosen: `--permission-mode plan`.** This is Claude Code's purpose-built read-only
  exploration mode: read tools are allowed, mutations are blocked. It directly expresses
  "explore but change nothing", matching the bughunt prompt exactly, and is a clean single-flag
  swap.
- **Documented fallback (verification contingency): `--dangerously-skip-permissions --disallowedTools "Write Edit MultiEdit NotebookEdit"`.**
  If, during implementation verification, plan mode proves incompatible with headless `-p`
  output (e.g. the agent tries to exit plan mode / ask to proceed instead of emitting the final
  `FINDINGS:` line, or plan mode blocks the read-only `Bash` exploration the hunter relies on),
  fall back to keeping the bypass but hard-denying the write tools. `--disallowedTools` is a
  hard deny that takes precedence over the bypass, so file edits become impossible; this is a
  weaker guarantee (a read-only `Bash` grant could still mutate via shell) but preserves
  today's exploration behavior exactly. The implementer must exercise the real bughunt flow
  (see the `verify` skill) and pick whichever profile actually produces valid findings; the
  design commits to plan mode as primary because it is the strongest least-privilege option.

## Assumptions

- **Scope is `bughunt` only.** `context`, `assess`, and `review` are also effectively read-only,
  but `design` and `plan` write spec/plan files into the workspace, `implement`/`full_verify`/`pr`
  mutate. The issue is scoped to bughunt; I classify **only `bughunt`** as read-only in this
  change to avoid altering the behavior of stages that may rely on write/execute access. The
  classifier is a set, so adding `review`/`context`/`assess` later is a one-line follow-up. Noted
  as an explicit deferral, not silently expanded.
- **The `pi` backend is out of scope.** The bughunt tier falls back to `pi`
  (`packages/policies/src/resolve-tier.ts`), but `pi`'s `buildArgs` passes no
  permission-bypass flag today, so the reported defect does not exist there. Whether `pi` grants
  write access by default is a separate question; this change touches only the Claude backend
  named in the issue. Flagged as a possible follow-up.
- **Home of the classifier is `packages/contracts`, not `packages/policies`.** Backends already
  depend only on `@agentops/contracts` (type-only imports), and read-only-ness is a property of
  the stage vocabulary that lives beside `StageSchema`. Contracts already exports non-schema
  constants (`DEFAULT_IDLE_TIMEOUT_MS`, `DEFAULT_TRIGGER_LABEL`), so a small pure predicate is at
  home there. Putting it in `policies` would add a new `backends -> policies` runtime dependency
  edge for what is vocabulary metadata rather than repair-loop semantics.
- **The K8s runner needs no change.** `K8sJobRunner` builds its command via the same
  `spec.buildArgs(req)` (`packages/backends/src/k8s/k8s-job-runner.ts:175`), so the stage-driven
  fork applies automatically whether Claude runs as a local process or a K8s Job.
- **Plan mode is the correct primary flag.** I cannot exercise the pinned `claude` CLI image in
  this design environment to confirm plan mode's exact headless behavior, so I record it as an
  assumption with the fallback above rather than asserting it verified.

## Design

**Components / files affected**

1. `packages/contracts/src/stage.ts` — add a pure, exported read-only-stage classifier next to
   `StageSchema`: a `READ_ONLY_STAGES` set (initially `{'bughunt'}`) and/or an
   `isReadOnlyStage(stage: Stage): boolean` predicate. Export it from the contracts index. No
   schema change; this is additive metadata over the existing enum.

2. `packages/contracts/src/stage.test.ts` — unit-test the classifier exhaustively: `bughunt` is
   read-only, every other stage in `StageSchema` is not. This locks the deferral decision so a
   future reviewer sees exactly which stages are (not) read-only.

3. `packages/backends/src/claude/claude-backend.ts` — in `buildArgs`, replace the unconditional
   `'--dangerously-skip-permissions'` with a stage-driven choice: for `isReadOnlyStage(req.stage)`
   push the read-only profile (`'--permission-mode', 'plan'` — primary, per the flag-choice
   section); otherwise push `'--dangerously-skip-permissions'` as today. Update the module comment
   above the args array to explain the fork and why (least privilege for read-only stages). All
   other args (`-p`, `--output-format stream-json`, `--verbose`, `--model`, `--effort`) are
   unchanged and keep their order; the permission flag occupies the same slot.

4. `packages/backends/src/claude/claude-backend.test.ts` — the existing exact-args tests use
   `stage: 'implement'`, so they continue to assert `--dangerously-skip-permissions` and stay
   green (regression guard for write stages). Add a new case with `stage: 'bughunt'` asserting the
   read-only profile is present and `--dangerously-skip-permissions` is absent.

5. `packages/backends/src/k8s/k8s-job-runner.test.ts` — the existing case uses `stage: 'implement'`
   and needs no change; optionally add a `bughunt` case mirroring the process-runner one to prove
   the fork survives the K8s wrapper. (Nice-to-have, not required for correctness.)

**Data flow**

`whiteboxBugHunt` → `runAgent` activity resolves the tier to a concrete Claude
`BackendRunRequest` carrying `stage: 'bughunt'` → `ProcessCliRunner`/`K8sJobRunner` call
`spec.buildArgs(req)` → the Claude spec reads `req.stage`, sees it is read-only, and emits the
read-only permission flag instead of the bypass. No new fields cross the activity→backend
boundary; the decision is derived from the `stage` that already crosses it.

**Error handling**

No new error paths. Output parsing, auth/rate-limit/session-limit classification, and the
liveness/idle-timeout behavior are untouched. The only behavioral change is which permission flag
the read-only stage receives. Verification (via the `verify` skill, exercising a real bughunt
run) confirms the chosen profile still yields a parseable `FINDINGS:` line; if it does not, the
implementer switches to the documented fallback profile before committing.

**Definition of done**

`pnpm lint && pnpm typecheck && pnpm test` green; the new contracts and Claude-backend tests
pass; write-stage arg tests unchanged; the bughunt flow verified end-to-end to still produce
findings under the read-only profile; this design note is the accompanying doc update.

## Scope check

This is one coherent change: give read-only Claude stages a least-privilege permission profile,
via a single classification seam plus a flag fork in one backend. It does not bundle unrelated
work; expanding the read-only set beyond `bughunt` and hardening `pi` are explicitly deferred.

## Brainstorm Summary
**Approaches considered:** (A) a shared read-only-stage classifier in `contracts` that the Claude backend consults to swap the permission flag; (B) hardcode `stage === 'bughunt'` inside the backend; (C) add a `permissionProfile` field to `BackendRunRequest` decided upstream.
**Chosen approach:** (A) — classify read-only stages once beside `StageSchema`; the Claude `buildArgs` emits a read-only permission mode for them instead of `--dangerously-skip-permissions`.
**Why (decisive reasons):** Fixes the literal defect, keeps the cross-cutting "which stages are read-only" fact in one vocabulary-owned place, is trivially testable, and leaves write stages byte-identical so their exact-arg tests stay green. B buries the fact in a vendor file; C has a large blast radius and decides CLI permissions at the wrong layer.
**Key risks/assumptions:** Scoped to `bughunt` only (other read-only stages and the `pi` backend deferred); primary flag is `--permission-mode plan` with a documented fallback (`--dangerously-skip-permissions --disallowedTools "Write Edit ..."`) if plan mode misbehaves headless — the implementer verifies a real bughunt run before committing.
