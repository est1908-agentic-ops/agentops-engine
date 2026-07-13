# Improve Automated PR Descriptions — design

Status: draft v1 · 2026-07-13 · Owner: est1908

Tracks: [#87](https://github.com/est1908-agentic-ops/agentops-engine/issues/87)

Builds on: design/plan artifact persistence (2026-07-12 custom-agent-workflows and follow-on persist work); aligns artifact paths with the original superpowers convention.

## 1. What this is

The PR bodies currently opened by `devCycle` (and child runs from `platform` / `self-heal`) are minimal:

- Normal: `Automated PR for task <taskId>.`
- Exhausted: terse repair summary.

This change makes them useful for human reviewers and for GitHub's own linking/closing behavior:

- Always include a `Fixes <issueRef>` (or full URL) reference when an originating issue exists.
- Include a quoted, truncated excerpt of the original issue body.
- Include a short "Brainstorm Summary" produced during the design phase.
- Summarize what was actually done and why (drawn from the committed design + plan).
- Reference the committed design and plan artifacts.
- Include concise run metadata (iterations, tokens, verdicts, etc.).

The design and plan artifacts themselves are now committed to the canonical superpowers locations so they appear naturally in the PR and can be read back to build the body.

## 2. Goals & non-goals

**Goals**
- PR body describes the problem, the chosen approach (brainstorm), and the concrete changes.
- Original issue is linked and will be auto-closed on merge when appropriate.
- Works for both direct issue-triggered runs and platform/self-heal proposed fixes.
- Uses the committed design/plan artifacts (no extra LLM call at PR time).
- Follows the same file layout convention as the interactive superpowers skills.

**Non-goals**
- Auto-merging (separate work).
- Updating the PR body on every babysit repair (future enhancement; initial body is the focus).
- Changing commit messages (they are already reasonably good).
- New contracts for the summary text (it lives inside the committed markdown file).

## 3. Background & current state

- `dev-cycle.ts` builds a one-line (or two-line) `prBody` and passes it to `activities.openPr`.
- `issueRef` + `issueBody` are already fetched for the `context` stage but never used for the PR.
- Design + plan stages now produce artifacts that the agent is supposed to `git commit`.
- The original interactive `superpowers:brainstorming` writes to `docs/superpowers/specs/YYYY-MM-DD-...-design.md`.
- The unattended `design-brainstorm` skill (and `plan-writer`) were adapted from those but previously used a different `agentops/specs/` convention for the persist feature.

We align the automated path to the original superpowers convention and make the PR body consume the committed content via a new general-purpose `readWorkspaceFile`.

## 4. Design

### 4.1 Artifact paths (canonical superpowers locations)

Inside the devCycle workspace the agent writes and commits:

- `docs/superpowers/specs/<taskId>-design.md`
- `docs/superpowers/plans/<taskId>-plan.md`

The `implement` stage prompt is updated to read from the same paths.

The `taskId` (already slug-safe in practice) is used for the filename so multiple concurrent or historical tasks do not collide.

### 4.2 Explicit "Brainstorm Summary" section

The `design.md` prompt (and `design-brainstorm` skill guidance) now instruct the agent to emit a short, self-contained section at the end of the design:

```markdown
## Brainstorm Summary

**Approaches considered:** ...
**Chosen approach:** ...
**Why (decisive reasons):** ...
**Key risks/assumptions:** ...
```

This section is written into the committed design file. After we read the file we extract it for the PR body (simple heading-based extraction, analogous to `parseVerdict`).

The full rich design remains in the file for reviewers.

### 4.3 Reading the artifacts

Add a general, safe method:

```ts
// Workspaces interface + implementations
readWorkspaceFile(workspaceRef: string, relativePath: string): Promise<string | null>;
```

- Sandboxed (must stay under the workspace root).
- Returns `null` on ENOENT (graceful for trivial-triage runs that skip design/plan).
- Exposed as `readWorkspaceFile` on `DevCycleActivities`.

In `dev-cycle.ts`, right after the final `pushBranch` (before `openPr`):

```ts
const design = await activities.readWorkspaceFile(..., `docs/superpowers/specs/${input.taskId}-design.md`);
const plan   = await activities.readWorkspaceFile(..., `docs/superpowers/plans/${input.taskId}-plan.md`);
```

### 4.4 PR body construction

A pure helper (or small inline builder) produces a structured body containing:

1. `Fixes <issueRef>` (or full URL) when `issueRef` present.
2. `## Problem` with a truncated quoted excerpt of `issueBody` (first ~2 paragraphs or 10 lines + "(truncated)").
3. `## Design Brainstorm Summary` — the extracted short section.
4. `## How the fix was done and why` — high-level from design + reference to plan.
5. Explicit links to the two committed files.
6. Run metadata block.
7. "Generated by agentops-engine devCycle" footer.

The same body is used for the exhausted-case `commentOnIssue`.

### 4.5 Prompt changes

- `design.md`: add persist instructions using the new paths + the `## Brainstorm Summary` block requirement.
- `plan.md`: update the "read the design" line and the persist path for the plan.
- `implement.md`: update the "read the design/plan" lines to the new paths.
- `design-brainstorm/SKILL.md` and `plan-writer/SKILL.md`: mention the new summary section and persist paths for consistency with the interactive originals.

### 4.6 Test & stub updates

- `dev-cycle.test.ts`, `create-activities.test.ts`, e2e helpers: add the new `readWorkspaceFile` stub (memory impl can seed content for assertions).
- Prompt-pack tests: assert the new paths and the Brainstorm Summary instruction appear.
- Add a small unit test for the extractor + body builder.

### 4.7 No workflow determinism violation

All file I/O goes through activities. The workflow only receives strings and builds the body string (pure).

## 5. File changes (high level)

**New / modified prompts & skills**
- packages/prompts/templates/design.md
- packages/prompts/templates/plan.md
- packages/prompts/templates/implement.md
- images/agent-runner/skills/design-brainstorm/SKILL.md
- images/agent-runner/skills/plan-writer/SKILL.md
- packages/prompts/src/prompt-pack.test.ts

**Activities / workspaces**
- packages/activities/src/workspace/workspace-manager.ts (and interface)
- packages/activities/src/workspace/memory-workspace-manager.ts
- packages/activities/src/create-activities.ts
- packages/workflows/src/activities-api.ts

**Workflow logic**
- packages/workflows/src/dev-cycle.ts (read after push, build body)
- Add a small pure extractor (can live in workflows or policies if it grows).

**Tests & e2e**
- packages/workflows/src/dev-cycle.test.ts
- packages/activities/src/create-activities.test.ts
- Relevant e2e tests that exercise PR opening (happy-path, exhausted-rounds, etc.)

**Docs**
- This spec
- Follow-up plan (see writing-plans output)

No new top-level packages or contracts are required.

## 6. Open questions / trade-offs

- Extraction strategy: heading-based scan is simple and sufficient because we control the prompt. We can add a sentinel (`## BRAINSTORM_SUMMARY`) later if needed.
- Body updates on repair: out of scope for v1. The initial body already contains the design rationale.
- Truncation length for issue body: start with 2 paragraphs / ~10 lines; easy to tune.
- Projects that do not use `docs/superpowers/` layout: they will still get the PR body improvements; the artifact files simply won't exist (graceful nulls).

## 7. Acceptance

- A normal issue-triggered devCycle run produces a PR whose body contains `Fixes ...`, a quoted issue excerpt, the Brainstorm Summary, how/why, links to the two committed files, and metadata.
- The design and plan files appear in the PR at `docs/superpowers/specs/...` and `docs/superpowers/plans/...`.
- All existing tests + new body-formatter tests pass.
- `pnpm lint && pnpm typecheck && pnpm test` (and relevant e2e) are green.

## 8. Follow-up work (not in this slice)

- Optional later activity to update PR body after babysit repairs.
- Possibly surface the Brainstorm Summary in the control UI run detail.
- General `readWorkspaceFile` can be reused by other workflows later.

This design satisfies the request in #87 while keeping the automated flow consistent with the human superpowers convention.