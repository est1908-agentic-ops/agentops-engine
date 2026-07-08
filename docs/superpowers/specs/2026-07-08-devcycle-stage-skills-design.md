# DevCycle `design`/`plan` stage skills — design

## Goal

The `design` and `plan` stages of the DevCycle workflow should produce output with the same
rigor as the Superpowers `brainstorming` and `writing-plans` skills (propose alternatives with
trade-offs, document rejected options, self-review before finishing, ordered/verifiable steps)
— available on every CLI agent backend that runs those stages, not just whichever backend
happens to have Claude Code's specific skill-discovery mechanism.

## Context

- Stages run as a single unattended `runAgent` activity call per attempt — one prompt in, one
  text output out. There is no live human on the other end during a devCycle run (the separate
  human-artifact path in ARCHITECTURE.md §2, "human-authored design/plan are used verbatim",
  already covers the case where a human wants the real interactive skill experience — that
  bypasses the agent stage entirely and is out of scope here).
- `superpowers:brainstorming` and `superpowers:writing-plans` are written for that interactive
  case: ask one clarifying question at a time, get approval per section, wait for a human to
  review the written spec. None of that fits an unattended run.
- Prompt templates (`packages/prompts/templates/*.md`) are flat files rendered by simple
  `{{var}}` substitution (`renderPrompt`/`PromptPack`) — no include/partial mechanism, so any
  shared content between a prompt and a skill is plain duplication, same as the existing
  `platform.md` / `platform-ops` SKILL.md pair.
- Backends that can run `design`/`plan` per `ModelRefSchema`: `claude`, `pi`, `litellm`, plus
  not-yet-implemented `cursor`/`codex` and the test-only `stub`. Only `claude` (Claude Code) and
  `pi` (`@earendil-works/pi-coding-agent`) are actual CLI agents with filesystem + Agent-Skills
  discovery. `litellm` is a bare OpenAI-compatible chat-completion call — no filesystem, no tool
  use, so it cannot load a skill file under any path.
- Claude Code and `pi` do not share a skill-discovery path: Claude Code reads
  `~/.claude/skills/<name>/SKILL.md` (personal) or `.claude/skills/<name>/SKILL.md` (project).
  `pi` reads `~/.pi/agent/skills/`, `~/.agents/skills/`, `.pi/skills/`, `.agents/skills/`
  (confirmed against pi's README). `~/.agents/skills/` is the one path unique to `pi` here; there
  is no path both tools read, so a skill baked into the shared `agent-runner` image needs a copy
  under each tool's own path.
- Precedent already exists for exactly this fan-out: `docs/superpowers/specs/2026-07-07-platform-agent-design.md`
  baked `platform-ops` into `.claude/skills/` in the image *and* put a summary of the same
  instructions into `platform.md`, reasoning "backends without a skill-discovery mechanism still
  get the instructions." That skill was only ever copied to `.claude/skills/`, so it has the same
  `pi`-blind-spot this design fixes for `design`/`plan` — folding that fix in here too.

## Non-goals

- No workflow/policy changes. The agent must never block waiting for a human mid-stage — if it
  would otherwise ask a clarifying question, it states the assumption it made instead and
  proceeds. (The `needs-clarification` `BlockReason` stays reserved/unused, as it is today.)
- No new prompt template variables — `design.md`/`plan.md` keep taking exactly `{{taskId}}` and
  `{{goal}}`, per the existing `prompt-pack.test.ts` contract.
- No change to `litellm` capability — it gets a self-contained prompt (see below) and no skill
  file, because it structurally cannot load one.
- No renaming/restructuring of the `context`/`assess`/`implement`/`full_verify`/`review`
  templates.

## Components

### 1. `images/agent-runner/skills/design-brainstorm/SKILL.md` (new)

Adapted from `superpowers:brainstorming`, interactive parts removed:

- Read available repo context first.
- Generate 2-3 distinct approaches with trade-offs before picking one.
- Justify the pick against the rejected alternatives explicitly.
- Where the interactive skill would ask a clarifying question, write the assumption down under
  an "Assumptions" heading instead, and proceed.
- Self-review before finishing: no placeholders/TBDs, no contradictions between sections, scope
  is one coherent change (say so explicitly if it isn't).
- Fixed output shape: goal restated, approaches considered, chosen approach + why, assumptions,
  design body (components/files/data flow/error handling, scaled to complexity).

### 2. `images/agent-runner/skills/plan-writer/SKILL.md` (new)

Adapted from `superpowers:writing-plans` the same way:

- Take the design as given; note gaps as assumptions rather than re-litigating it.
- Ordered steps, each touching a small coherent set of files.
- Every step names its verification method (specific test/command/manual check) — a step
  without one isn't done.
- Sequence for safety (de-risking steps first); call out any step that could reorder and why it
  didn't.
- Self-review: every step verifiable, no step secretly bundling two steps.

### 3. `packages/prompts/templates/design.md` / `plan.md` (rewritten)

Each gets, in addition to the existing `{{taskId}}`/`{{goal}}` framing:

- An explicit, unambiguous unattended-mode line, stated as a hard rule rather than a suggestion:
  **"There is no human here. Do not ask anything — decide yourself and record the assumption."**
  This is the first substantive line in both templates, ahead of the methodology guidance below,
  so it can't be read as optional or missed.
- A condensed version of the corresponding skill's methodology (approaches + trade-offs +
  self-review for `design.md`; ordered/verifiable steps for `plan.md`) — this is the part that
  makes `litellm` (no skill access) still get real guidance instead of a dangling reference.
- One pointer line for CLI backends: "If a `design-brainstorm` [`plan-writer`] skill is
  available, use it."

### 4. `images/agent-runner/Dockerfile`

Add, alongside the existing `platform-ops` line:

```
COPY --chown=1000:1000 skills/platform-ops     /home/node/.claude/skills/platform-ops
COPY --chown=1000:1000 skills/platform-ops     /home/node/.agents/skills/platform-ops
COPY --chown=1000:1000 skills/design-brainstorm /home/node/.claude/skills/design-brainstorm
COPY --chown=1000:1000 skills/design-brainstorm /home/node/.agents/skills/design-brainstorm
COPY --chown=1000:1000 skills/plan-writer      /home/node/.claude/skills/plan-writer
COPY --chown=1000:1000 skills/plan-writer      /home/node/.agents/skills/plan-writer
```

Same content, two destinations per skill — no per-backend authoring, since Claude Code and `pi`
each only read their own path.

## Testing / verification

- `prompt-pack.test.ts`'s existing "renders every built-in stage template without throwing"
  case continues to cover `design.md`/`plan.md` with no changes needed (same two vars).
- Add a rendered-content assertion (in the same test file) that `design.md`/`plan.md` output
  contains the unattended-mode instruction, so a future edit can't silently drop it.
- Manual image verification (same pattern the platform-agent plan used): build the image, then
  `docker run --rm agent-runner-test cat /home/node/.claude/skills/design-brainstorm/SKILL.md`
  and the `.agents/skills/...` / `plan-writer` / `platform-ops` equivalents — six paths total —
  to confirm every COPY landed at the expected path.
- No e2e changes: the `stub` backend used in `e2e/*.e2e.test.ts` never reads these templates for
  behavior (it returns scripted responses keyed by stage/attempt), so this doesn't touch e2e
  coverage.

## Open questions

None outstanding — naming (`design-brainstorm`, `plan-writer`), backend scope (`claude`+`pi` for
skill files, all backends for the prompt), and the no-blocking behavior were all confirmed above.
