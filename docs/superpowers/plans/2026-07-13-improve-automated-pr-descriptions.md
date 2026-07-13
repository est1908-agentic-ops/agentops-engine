# Improve Automated PR Descriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make devCycle (and platform/self-heal child) PRs describe the problem, what was done, why, and link back to the originating issue, using committed design/plan artifacts placed at the canonical superpowers locations.

**Architecture:** After the final `pushBranch`, use a new general `readWorkspaceFile` activity to load the committed `docs/superpowers/specs/<taskId>-design.md` and `...-plan.md`. Extract the explicit "Brainstorm Summary" section that the design stage now produces. Build a rich, structured PR body containing Fixes reference, truncated issue excerpt, the brainstorm summary, how/why, links to the artifacts, and run metadata. Update prompts to write to the superpowers paths and to emit the summary section.

**Tech Stack:** TypeScript (strict), Temporal, vitest, existing prompt + workspace machinery.

## Global Constraints

- Determinism boundary (AGENTS.md #1): workflow code never does I/O; `readWorkspaceFile` is an activity.
- Align with original superpowers convention: artifacts go under `docs/superpowers/specs/` and `docs/superpowers/plans/`.
- Contracts first: any new activity signatures or pure helpers that cross boundaries get documented; no new Zod schemas needed for this slice.
- Every task ends green: `pnpm lint && pnpm typecheck && pnpm test`. Relevant e2e must pass.
- Update the design spec in the same PR if anything deviates.
- No new top-level packages.

## File Structure (target state)

- `docs/superpowers/specs/2026-07-13-improve-automated-pr-descriptions-design.md` (already written)
- `docs/superpowers/plans/2026-07-13-improve-automated-pr-descriptions.md` (this file)
- `packages/prompts/templates/design.md` — add persist + Brainstorm Summary instructions
- `packages/prompts/templates/plan.md` — update read/write paths
- `packages/prompts/templates/implement.md` — update read paths
- `images/agent-runner/skills/design-brainstorm/SKILL.md` — mention new summary + paths
- `images/agent-runner/skills/plan-writer/SKILL.md` — mention paths
- `packages/prompts/src/prompt-pack.test.ts` — assert new content
- `packages/activities/src/workspace/workspace-manager.ts` + interface
- `packages/activities/src/workspace/memory-workspace-manager.ts`
- `packages/activities/src/create-activities.ts`
- `packages/workflows/src/activities-api.ts`
- `packages/workflows/src/dev-cycle.ts` — read after final push, build body
- `packages/workflows/src/dev-cycle.test.ts` + other test files
- (optional small pure extractor living next to `parseVerdict` if it grows)

## Task Right-Sizing & Verification

Each task is the smallest unit that can be committed and reviewed independently. Every step shows the actual diff/command/output where useful.

---

### Task 1: Align design prompt + add explicit Brainstorm Summary section

**Files:**
- Modify: `packages/prompts/templates/design.md`
- Modify: `images/agent-runner/skills/design-brainstorm/SKILL.md` (light update)
- Test: `packages/prompts/src/prompt-pack.test.ts`

**Interfaces:**
- Produces: design artifact now contains `## Brainstorm Summary` block at the end.

- [ ] **Step 1: Update design.md with persist instructions and summary section**

Add at the end of the file (after the existing content, before any final notes):

```markdown
## Persist the artifact

When you are done with the design, create the directory and write the full design (including the Brainstorm Summary below) to `docs/superpowers/specs/{{taskId}}-design.md` in this workspace and commit it:

```bash
mkdir -p docs/superpowers/specs
cat > docs/superpowers/specs/{{taskId}}-design.md << 'EOF'
... (the full design you just produced)
EOF
git add docs/superpowers/specs/{{taskId}}-design.md
git commit -m "docs: design for task {{taskId}} (includes Brainstorm Summary)"
```

## Brainstorm Summary

After the full design, emit this exact short section (keep it under ~150 words). It will be extracted and placed in the PR description.

```markdown
## Brainstorm Summary
**Approaches considered:** 1-2 sentence summary of the main alternatives.
**Chosen approach:** Which one we picked.
**Why (decisive reasons):** The key reasons this won (trade-offs, assumptions, constraints from the goal/issue).
**Key risks/assumptions:** The most important ones a reviewer should know.
```

- [ ] **Step 2: Lightly update the design-brainstorm SKILL.md**

In the Output shape section add:

- **Brainstorm Summary** (short section emitted for PR use) — see the stage prompt for exact format.

- [ ] **Step 3: Extend prompt-pack test to verify the new instructions**

Add assertions that `design.md` render contains both `docs/superpowers/specs/{{taskId}}-design.md` and the string `## Brainstorm Summary`.

Run: `pnpm test packages/prompts/src/prompt-pack.test.ts`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/prompts/templates/design.md images/agent-runner/skills/design-brainstorm/SKILL.md packages/prompts/src/prompt-pack.test.ts
git commit -m "feat(prompts): add Brainstorm Summary section + superpowers paths to design"
```

---

### Task 2: Update plan and implement prompts for the new artifact locations

**Files:**
- Modify: `packages/prompts/templates/plan.md`
- Modify: `packages/prompts/templates/implement.md`
- Modify: `images/agent-runner/skills/plan-writer/SKILL.md` (light)
- Test: `packages/prompts/src/prompt-pack.test.ts`

**Interfaces:**
- Consumes: design at the new path.
- Produces: plan at the new path.

- [ ] **Step 1: Update plan.md**

Change the "Before planning, read..." line to:

```markdown
Before planning, read the design specification in `docs/superpowers/specs/{{taskId}}-design.md` ...
```

Add / update the persist section at the bottom to write to:

`docs/superpowers/plans/{{taskId}}-plan.md`

Include the mkdir + git commit pattern (similar to design).

- [ ] **Step 2: Update implement.md**

Change the lines that tell the agent to read design/plan to use the superpowers paths.

- [ ] **Step 3: Light update to plan-writer skill**

Add note in Output shape or Process: the plan is persisted to `docs/superpowers/plans/...` using the same convention as the interactive superpowers.

- [ ] **Step 4: Add assertions to prompt-pack test**

Verify both plan.md and implement.md renders contain the new paths.

- [ ] **Step 5: Commit**

```bash
git add packages/prompts/templates/plan.md packages/prompts/templates/implement.md images/agent-runner/skills/plan-writer/SKILL.md packages/prompts/src/prompt-pack.test.ts
git commit -m "feat(prompts): align plan & implement reads/writes to docs/superpowers/ paths"
```

---

### Task 3: Add readWorkspaceFile to the workspace layer

**Files:**
- Modify: `packages/activities/src/workspace/workspace-manager.ts`
- Modify: `packages/activities/src/workspace/memory-workspace-manager.ts`
- Modify: (the Workspaces interface is in the same file)

**Interfaces:**
- New method on Workspaces and Memory impl.

- [ ] **Step 1: Add the method to the interface (in workspace-manager.ts)**

```ts
readFile(workspaceRef: string, relativePath: string): Promise<string | null>;
```

- [ ] **Step 2: Implement in WorkspaceManager**

Add a safe implementation:

```ts
async readFile(workspaceRef: string, relativePath: string): Promise<string | null> {
  const full = resolve(workspaceRef, relativePath);
  const root = resolve(workspaceRef) + sep;
  if (!full.startsWith(root)) {
    return null; // escape attempt
  }
  try {
    return await readFile(full, 'utf8');
  } catch (e: any) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
```

Import `readFile` and `resolve` if not already (they mostly are).

- [ ] **Step 3: Implement stub in MemoryWorkspaceManager**

Add a `private files = new Map<string, Map<string, string>>();`

Expose a test helper `seedFile(workspaceRef, relPath, content)`.

Implement `readFile` to look it up or return null.

- [ ] **Step 4: Run the workspace manager tests**

`pnpm test packages/activities/src/workspace/workspace-manager.test.ts packages/activities/src/workspace/memory-workspace-manager.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/activities/src/workspace/*.ts
git commit -m "feat(activities): add safe readWorkspaceFile (used for design/plan artifacts)"
```

---

### Task 4: Wire readWorkspaceFile into activities and the devCycle contract

**Files:**
- Modify: `packages/activities/src/create-activities.ts`
- Modify: `packages/workflows/src/activities-api.ts`

- [ ] **Step 1: Add to DevCycleActivities**

```ts
readWorkspaceFile(workspaceRef: string, relativePath: string): Promise<string | null>;
```

- [ ] **Step 2: Implement the delegation in createActivities**

```ts
async readWorkspaceFile(workspaceRef: string, relativePath: string) {
  return deps.workspaces.readFile(workspaceRef, relativePath);
}
```

(Keep the project scoping / assert if the surrounding code does it for other workspace calls.)

- [ ] **Step 3: Update test stubs**

Add the method (returning null or seeded value) in all places that create stub activities for dev-cycle (dev-cycle.test.ts, create-activities.test.ts, e2e helpers).

- [ ] **Step 4: Commit the wiring**

```bash
git add packages/activities/src/create-activities.ts packages/workflows/src/activities-api.ts packages/workflows/src/dev-cycle.test.ts ...
git commit -m "feat(activities,workflows): expose readWorkspaceFile in DevCycleActivities"
```

---

### Task 5: Update dev-cycle.ts to read artifacts and build rich PR body

**Files:**
- Modify: `packages/workflows/src/dev-cycle.ts`

**Interfaces:**
- After final push, read the two files, extract summary, call a body builder.

- [ ] **Step 1: Add the read + body construction right before openPr**

Locate the block:

```ts
await activities.pushBranch(...);
const { prRef } = await activities.openPr({ title: input.goal, body: prBody });
```

Replace the body construction and the openPr call with:

```ts
await activities.pushBranch(input.repo, state.workspaceRef, state.branch, `${input.taskId}-${implementAttempt}`);

const designPath = `docs/superpowers/specs/${input.taskId}-design.md`;
const planPath   = `docs/superpowers/plans/${input.taskId}-plan.md`;

const [design, plan] = await Promise.all([
  activities.readWorkspaceFile(state.workspaceRef, designPath),
  activities.readWorkspaceFile(state.workspaceRef, planPath),
]);

const prBody = buildRichPrBody({
  goal: input.goal,
  issueRef: input.issueRef,
  issueBody,
  designContent: design,
  planContent: plan,
  exhausted,
  implementAttempts: state.implementAttempts,
  iterations: state.iterations,
  cumulativeTokens: state.cumulativeTokens,
  findingsSummary,
});

const { prRef } = await activities.openPr({
  repo: input.repo,
  branch: state.branch,
  title: input.goal,
  body: prBody,
});
```

- [ ] **Step 2: Implement `buildRichPrBody` (pure helper inside the file or a small util)**

Create a function that assembles the markdown exactly as described in the spec (Fixes line, Problem section with truncation, Brainstorm Summary, How..., links, metadata).

Add a tiny `extractBrainstormSummary(text: string | null)` helper that looks for `## Brainstorm Summary` and takes content until the next `##` or end-of-string. Return a sensible fallback if missing.

- [ ] **Step 3: Also use the same prBody for the exhausted commentOnIssue**

- [ ] **Step 4: Add unit test coverage in dev-cycle.test.ts**

Assert that when design/plan content is supplied via the activity mock, the body passed to `openPr` contains "Fixes", the extracted summary, etc.

- [ ] **Step 5: Run typecheck + the dev-cycle test**

`pnpm typecheck && pnpm test packages/workflows/src/dev-cycle.test.ts`

- [ ] **Step 6: Commit**

```bash
git add packages/workflows/src/dev-cycle.ts packages/workflows/src/dev-cycle.test.ts
git commit -m "feat(workflows): read superpowers design/plan after push and emit rich PR body"
```

---

### Task 6: Full verification & green run

**Files:** (all touched files)

- [ ] **Step 1: Run the full local check**

```bash
pnpm lint && pnpm typecheck && pnpm test
```

- [ ] **Step 2: Run relevant e2e (at least happy-path and exhausted)**

```bash
pnpm e2e --grep "happy-path|exhausted"
```

- [ ] **Step 3: If anything is red, fix in a follow-up micro-task and re-run.**

- [ ] **Step 4: Commit any final fixes with "fix: ..."**

---

### Task 7: Open the PR

- [ ] **Step 1: Make sure you are on the correct branch and everything is committed**

```bash
git status
git log --oneline -3
```

- [ ] **Step 2: Push the branch**

```bash
git push -u origin HEAD
```

- [ ] **Step 3: Open the PR with a good description**

```bash
gh pr create --repo est1908-agentic-ops/agentops-engine \
  --title "feat(workflows): improve automated PR descriptions (#87)" \
  --body "$(cat <<'EOF'
Implements the design in docs/superpowers/specs/2026-07-13-improve-automated-pr-descriptions-design.md.

- PR bodies now contain Fixes reference, issue excerpt, Brainstorm Summary from design phase, how/why, and links to the committed artifacts.
- Artifacts placed at the canonical superpowers locations: docs/superpowers/specs/... and docs/superpowers/plans/...
- Uses readWorkspaceFile after the final push (Approach B).
- All tests green.

Closes #87
EOF
)"
```

- [ ] **Step 4: Verify the PR was created and paste the URL here**

---

All tasks above produce independently reviewable commits. After Task 6 the tree is green. Task 7 lands the change.