# DevCycle `design`/`plan` stages commit spec + plan artifacts to the repo — design

Status: draft v1 · 2026-07-13 · Task: issue-agentic-ops-engine-88

## Goal

Make the `design` and `plan` stages of `devCycle` behave like the original Superpowers
`brainstorming`/`writing-plans` flow: not just *think* about the design and plan, but **write a
spec file and a plan file into the target repo and commit them** — so the artifacts persist,
travel forward to later stages, and land in the PR for a human to review alongside the code.

## Context — the gap being closed

The [2026-07-08 devcycle-stage-skills spec](2026-07-08-devcycle-stage-skills-design.md) already
gave `design`/`plan` the *methodology* of the Superpowers skills (alternatives + trade-offs,
assumptions instead of questions, ordered verifiable steps). What it did **not** do is persist
the result. Today:

- `runStageAgent` (`packages/workflows/src/dev-cycle.ts`) runs each pre-implement stage as one
  `runAgent` activity call and returns `result.output` as a plain string. For `design`/`plan`
  that returned string is **discarded** — it is not fed into any later stage's `promptContext`
  (only `context` injects `issueBody`; `implement` only injects prior verify/review findings),
  and it is not written anywhere.
- `recordStageResult` stores a synthetic `contentHash` (`` `${stage}-${attempt}-${callIndex}` ``),
  not the actual text — it is bookkeeping, not an artifact.
- The **only** state that survives between stages is the shared git workspace (`state.workspaceRef`,
  checked out on `state.branch`, prepared at dev-cycle.ts:149 *before* the pre-implement loop at
  :272). The current `design.md`/`plan.md` prompt templates never tell the agent to write files
  to that workspace, so nothing about the design/plan reaches `implement` except by luck.

So the design and plan stages are effectively advisory-only: the agent reasons, emits text, and
the text evaporates. `implement` starts from the goal + workspace with no committed design to
follow — unlike Superpowers, where the committed `*-design.md` / `*-plan.md` files on disk are
the hand-off between phases.

The established persistence pattern already exists one stage over: `implement.md` tells the agent
"stage and commit your changes with `git add` / `git commit` in this workspace — nothing you don't
commit will ever be pushed or reviewed," and `activities.pushBranch` (a plain `git push --force`)
ships whatever the agent committed. Commits are agent-authored; the workflow only pushes.

## Approaches considered

### A. Prompt + skill only: design/plan write their artifact to a fixed path and commit it

Extend the `design.md`/`plan.md` prompt templates and the `design-brainstorm`/`plan-writer`
SKILL.md files to instruct the agent to write its output to a fixed in-repo path
(`agentops/specs/<taskId>-design.md`, `…-plan.md`) and `git add`/`git commit` it in the
workspace — exactly as `implement` already does. No workflow, activity, contract, or port change.
The commit rides the shared branch forward: `plan` reads the committed design, `implement` reads
both, and all three files land in the PR.

- **Trade-off:** persistence is agent-driven, so an agent that ignores the instruction commits
  nothing — but this is the *identical* reliability posture as `implement`'s commit step, which
  the repo already trusts. Zero new surface; lowest risk; matches the existing prompt+skill
  architecture the 2026-07-08 spec deliberately chose. `litellm` (no filesystem/tool-use) cannot
  write files — already a documented non-goal there.
- **Cost:** low — edits to 2 templates + 2 skill files + Dockerfile-baked skill copies already
  wired; one prompt-pack content assertion.

### B. Workflow captures stage output, a new activity writes + commits it deterministically

Keep the prompts as-is; in `devCycle`, take the `design`/`plan` string already returned by
`runStageAgent` and call a new `writeAndCommitArtifact(workspaceRef, path, content, message)`
activity that writes the file and runs `git add`/`git commit`.

- **Trade-off:** deterministic — the file always exists regardless of backend (would even work
  for `litellm`). But it adds a new activity **and** a new SCM port method (commit, which does
  not exist today — only push does), widening the `ports`/`activities` surface for a behavior the
  repo otherwise leaves to the agent. The captured text often carries chat preamble/markdown
  fences, so the committed file is lower-quality than an agent-authored one. Heavier, and it
  splits "author the design" from "persist the design" across two owners.
- **Cost:** medium — new contract-free activity, new `ScmPort.commit` on both `github` and
  `memory` implementations + their tests, workflow wiring, and determinism review.

### C. Hybrid: agent writes the file (prompt-driven), workflow commits it deterministically

Prompt tells the agent to write the artifact to the fixed path; a workflow activity then does the
`git add <path> && git commit` so the commit is guaranteed even if the agent writes but forgets to
commit, and can fail-loud if the file is missing.

- **Trade-off:** best artifact quality + guaranteed commit, but still needs the new commit
  activity/port method from B, and still can't help `litellm`. The extra guarantee it buys over A
  (agent wrote the file but didn't commit it) is a narrow failure mode that `implement` doesn't
  bother guarding against either — inconsistent to special-case it here.
- **Cost:** medium — same new port/activity surface as B, plus prompt edits.

## Chosen approach: **A — prompt + skill only**

It closes the actual gap (artifacts are written and committed, and therefore flow forward and into
the PR) with the smallest, most consistent change: it reuses the exact agent-commits-in-workspace
mechanism `implement` already relies on and `pushBranch` already ships, adds no contract/port/
workflow surface, and stays faithful to the 2026-07-08 spec's deliberate decision that these
stages are driven by prompts + baked skills, not workflow logic.

**B rejected:** introduces a new SCM commit port method and activity purely to persist text the
agent could commit itself, and produces lower-quality artifacts from raw stage output — a lot of
new boundary surface for a determinism guarantee the feature doesn't need. **C rejected:** carries
B's full port/activity cost to defend against a narrow "wrote-but-didn't-commit" case that the
repo tolerates for `implement`; special-casing it here would be inconsistent. Neither B nor C
helps `litellm`, so their "works for every backend" selling point is moot in practice.

## Assumptions

- **Artifact path & naming.** Chose `agentops/specs/<taskId>-design.md` and
  `agentops/specs/<taskId>-plan.md` in the **target** repo. Rationale: target repos already carry
  an `agentops/` namespace (`agentops.json`, `agentops/prompts/`), keeping the engine's artifacts
  self-contained rather than assuming every managed repo adopts this engine's own
  `docs/superpowers/specs/` layout; `taskId` (already a template var, `{{taskId}}`) makes the path
  deterministic and collision-free without needing a date (the workflow's determinism boundary
  forbids `Date.now()`, and per-stage paths must be stable across re-runs of the same task).
- **Cross-stage hand-off carrier.** Assumed the shared committed workspace is the hand-off, not new
  prompt variables — because `plan`/`implement` agents run in that same checkout and can `read` the
  committed files, and the 2026-07-08 spec froze the template variable set (`{{taskId}}`,
  `{{goal}}`) as a `prompt-pack.test.ts` contract. So I add no prompt variables; I add file
  *references* the agent resolves by reading the workspace.
- **Scope of downstream consumption.** Assumed the feature is incomplete if the committed files are
  never read, so `plan.md` must point its agent at the committed design and `implement.md` at both
  committed artifacts. Kept this to one-line pointers ("read `agentops/specs/<taskId>-design.md`
  before planning"), not a rework of those prompts.
- **Human-authored design/plan detection stays out of scope.** `hasHumanDesign`/`hasHumanPlan` are
  still hardcoded `false` at dev-cycle.ts:272. Wiring detection (read the spec path → skip the
  agent stage) is a natural follow-up, and the chosen path is compatible with it, but this change
  does not touch that logic — it would change stage-skipping behavior and belongs in its own spec.
- **`litellm` remains artifact-less.** Consistent with the 2026-07-08 non-goal: it has no
  filesystem/tool-use and structurally cannot write or commit a file, so it keeps producing text
  only. No regression — it persisted nothing before either.
- **Empty/partial diff at PR time is acceptable.** If a `design`/`plan` agent skips the write (same
  posture as `implement` skipping its commit), the run proceeds as it does today; no new failure
  mode is introduced.

## What changes (components/files, not diffs)

1. **`packages/prompts/templates/design.md`** — after the existing methodology block, add an
   explicit output-persistence instruction: write the finished design to
   `agentops/specs/{{taskId}}-design.md` and `git add`/`git commit` it in this workspace (mirroring
   `implement.md`'s commit wording), stating that uncommitted work is never carried forward. No new
   template variables (`{{taskId}}`/`{{goal}}` only).

2. **`packages/prompts/templates/plan.md`** — same persistence instruction targeting
   `agentops/specs/{{taskId}}-plan.md`, **plus** a pointer to read the committed
   `agentops/specs/{{taskId}}-design.md` first so the plan builds on the design rather than
   re-deriving it.

3. **`packages/prompts/templates/implement.md`** — one-line pointer to read the committed
   `agentops/specs/{{taskId}}-design.md` and `…-plan.md` before making changes. Keeps the existing
   findings-injection and commit instruction unchanged.

4. **`images/agent-runner/skills/design-brainstorm/SKILL.md`** and
   **`…/skills/plan-writer/SKILL.md`** — add a final "Persist the artifact" step to each skill's
   Process/Output section describing the same fixed path + commit, so CLI backends (`claude`,
   `pi`) that load the skill get the persistence step as part of the methodology, not only from the
   condensed prompt. No new skill files; the Dockerfile COPYs from the 2026-07-08 spec already bake
   these two skills to both `.claude/skills/` and `.agents/skills/`.

5. **`packages/prompts/src/*` prompt-pack test** — extend the existing rendered-content assertion
   (added by the 2026-07-08 spec) so `design.md`/`plan.md` output now also contains the
   `agentops/specs/` artifact path and a commit instruction, preventing a future edit from silently
   dropping persistence. Still renders with only `{{taskId}}`/`{{goal}}`.

### Data flow after the change

`context` (workspace prepared, branch checked out) → **`design`**: agent writes + commits
`agentops/specs/<taskId>-design.md` → **`plan`**: agent reads that design, writes + commits
`…-plan.md` → `implement`: agent reads both, makes code changes, commits → `pushBranch`
(`git push --force`) ships all commits → PR contains the spec, the plan, and the code together.
The shared committed branch is the carrier; no stage output is discarded anymore.

### Error handling

- Agent skips the write/commit → identical to today (nothing persisted; run continues). No new
  failure path; consistent with `implement`'s existing agent-commit trust model.
- File already exists (task re-run on a reclaimed-then-rebuilt worktree) → the workspace is rebuilt
  fresh off `origin/<base>` each run (per `push`'s `--force` comment and `reclaimStaleWorktree`), so
  the agent simply re-authors the file; deterministic path means no accumulation of stale variants.
- `litellm` → no file, no commit, text-only output as before.

## Testing / verification

- **Unit (prompts):** extend the prompt-pack rendered-content test to assert `design.md`/`plan.md`
  contain the `agentops/specs/<taskId>-…` path and a commit instruction; `plan.md`/`implement.md`
  contain the "read the committed design" pointer. `pnpm test` in `packages/prompts`.
- **Image:** after building `agent-runner`, `docker run --rm … cat` the four skill destinations
  (`design-brainstorm`/`plan-writer` under both `.claude/skills/` and `.agents/skills/`) to confirm
  the persistence step is present in the baked copies.
- **e2e:** the `stub` backend returns scripted responses and does not read these templates for
  behavior, so no e2e change is required; the existing suite must still pass green (workflows/
  prompts touched only in text, no logic change). No `TestWorkflowEnvironment` change — `devCycle`
  control flow is untouched.
- **Definition of done:** `pnpm lint && pnpm typecheck && pnpm test` green; e2e green (prompt-only,
  no workflow logic change); this spec is the design record.

## Non-goals

- No `devCycle`/policy control-flow change; no new activity, contract, or SCM port method.
- No wiring of `hasHumanDesign`/`hasHumanPlan` detection from the committed spec path (separate
  follow-up; the chosen path is compatible with it).
- No new prompt template variables (`{{taskId}}`/`{{goal}}` contract preserved).
- No `litellm` capability change — it remains artifact-less by construction.

## Self-review

- No placeholders/TBDs; every path and file is concrete.
- No contradictions: persistence uses the same agent-commit + `pushBranch` mechanism described in
  Context; the "no workflow change" claim holds (all edits are prompt/skill/test text).
- Scope is one coherent change: *design/plan write and commit their artifacts, and downstream
  stages read them.* The downstream-read pointers (items 2–3) are included because artifacts that
  are written but never read would make the feature pointless — they are part of the same change,
  not a separate one. Human-artifact detection is explicitly deferred to keep scope tight.
