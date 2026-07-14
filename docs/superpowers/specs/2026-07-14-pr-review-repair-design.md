# PR Review Repair (`devCyclePrRepair`) — design

Status: draft v1 · 2026-07-14 · Owner: (from brainstorming with est1908)

Tracks: [#94](https://github.com/est1908-agentic-ops/agentops-engine/issues/94)

Builds on:
- #93: PRs now inherit the `agentops` label (and others) from the originating issue.
- 2026-07-13-improve-automated-pr-descriptions: rich PR bodies using committed design/plan artifacts + `buildRichPrBody`.

## 1. What this is

After an agent-created PR is open, human reviewers (or bots) often leave comments or request changes. Today the agent has no automatic path to see those comments and produce fixes.

This feature adds an automatic "review-triggered repair" path:

- The gateway listens for `pull_request_review` (and review comment) events on PRs that carry the `agentops` label.
- On such an event it starts (or is a no-op if already running) a dedicated `devCyclePrRepair` workflow.
- `devCyclePrRepair` prepares a workspace on the PR's head branch, seeds the agent with the current unresolved review comments, and runs a full quality loop:
  `implement` (with review feedback) → `full_verify` → internal `review` verdict → push → `pr_babysit`.
- The babysit loop continues exactly as in normal `devCycle` (using the same policies and `getPrFeedback`).
- The goal is for the PR to reach green CI + zero unresolved review threads (or hit a brake).

The flow works both immediately after PR creation and "at any time" later.

## 2. Goals & non-goals

**Goals**
- Review comments on agent PRs are automatically addressed with the same rigor as the original implementation (full verify + internal review before push).
- Leverages the existing `agentops` label (now applied to PRs via #93).
- Reuses as much as possible: `babysitDecision`, `nextRepairAction`, `runStageAgent` / `runVerdictStage` helpers, prompt rendering, brakes, state recording, `getPrFeedback`, push, etc.
- The "update your webhook" instruction appears in the (now rich) PR body so maintainers know how to enable the feature.
- Works for both GitHub-triggered reviews and manual / platform-agent triggered repairs.

**Non-goals (this pass)**
- Auto-merging of the resulting PRs.
- Handling every possible GitHub review event nuance on day one (start with `submitted` reviews that introduce or update unresolved threads).
- Rich thread conversation history beyond what `getPrFeedback` already surfaces (first comment per thread + unresolved count).
- Updating the original PR body on every repair round (the rich body is created at open time).

## 3. Background & current state (post-2026-07-14 main merge)

- PRs opened by `devCycle` now carry the `agentops` label (inherited from the triggering issue via `issues.addLabels` after `openPr`).
- `buildRichPrBody` produces high-quality bodies that include problem excerpt, brainstorm summary, links to committed `docs/superpowers/specs/...-design.md` and plans, run metadata, etc.
- The post-PR babysit loop in `devCycle` already reacts to `unresolvedThreads > 0` from `getPrFeedback` and does repair `implement` + push rounds. However:
  - The actual comment *bodies* are not fed into the agent during repair passes.
  - There is no independent way to start a repair for a PR after the original `devCycle` has finished.
  - No gateway path exists yet for `pull_request_review` events.

`getPrFeedback` (via GraphQL review threads) already gives us the data we need (`comments[]` with `body` + `resolved`, plus `unresolvedThreads`).

## 4. Design

### 4.1 Triggering (Gateway)

Add support for GitHub `pull_request_review` webhooks (and optionally `pull_request_review_comment`).

New parser (modeled on existing `parseIssueTriggerEvent`):
- Accept event `pull_request_review`.
- Look for `action: "submitted"` (or relevant actions that can introduce unresolved threads).
- Check whether the PR has the `agentops` label (can be read from the payload or via a cheap follow-up call).
- If yes and the repo is registered → start `devCyclePrRepair`.

Deterministic workflow ID pattern, e.g.:
`devCyclePrRepair-<owner>-<repo>-<prNumber>`

Duplicate deliveries are cheap no-ops (Temporal already-started behavior).

The triggering review body (and/or the full current unresolved set) is passed as `prReviewFeedback` in the input.

### 4.2 `devCyclePrRepair` workflow

A first-class exported workflow (similar to `devCycle`, `platform`, etc.).

**Input** (new contract in `@agentops/contracts`):

```ts
interface DevCyclePrRepairInput {
  taskId: string;           // e.g. `pr-repair-<repo>-<number>`
  project: string;
  repo: string;
  prRef: string;            // "owner/repo#123"
  prReviewFeedback?: string; // the new/updated review comments that triggered this run
  config?: ProjectConfig;
}
```

**High-level flow** (reuses heavily from `dev-cycle.ts`):

1. Resolve config if not supplied.
2. Prepare workspace on the PR's existing head branch (see §4.3).
3. Enter the "make a good change" loop (modeled on the pre-PR part of devCycle):
   - `implement` (extra context: `prReviewFeedback`, previous findings)
   - `full_verify`
   - if pass: internal `review` verdict
   - `nextRepairAction` decision
   - repeat or break
4. `pushBranch` (to the PR head branch).
5. Enter the full `pr_babysit` loop (identical logic to current devCycle babysit, using `babysitDecision`, `feedbackHash`, same brakes, resume signals, etc.).
6. On clean exit: cleanup workspace, return state (can reuse/extend `DevCycleState` shape with `prRef`).

The workflow is intentionally thin on new logic — it mostly reuses the helpers that already exist (`runStageAgent`, `runVerdictStage`, the evaluate/nextRepairAction block, the babysit while loop).

We will factor the common repair/babysit control flow into a shared module inside `packages/workflows` so `devCycle` and `devCyclePrRepair` stay in sync.

### 4.3 Workspace for an existing PR

Current `prepareWorkspace` creates a fresh `agentops/<taskId>` branch.

For repair runs we need to work on (and force-push to) the branch the PR is already tracking.

Options (to be finalized in implementation):
- Extend `prepareWorkspace` (or add `prepareForPrRef`) that accepts an optional target branch or `prRef`.
- Inside the activity: use the GitHub API (or the PR head info) to learn the branch name, then `git checkout -B <branch> origin/<branch>` (or the equivalent worktree setup).
- The repair run still uses its own `taskId` for logs/stats/workspace naming, but the git branch it pushes is the PR's head branch.

Safety properties (force-push only on task-owned branches that the agent controls) remain.

### 4.4 Feeding review comments to the agent

- Add `prReviewFeedback` (and/or a structured list) to the prompt context for the `implement` stage.
- Update `packages/prompts/templates/implement.md` with a new section (parallel to `fullVerifyFindings` / `reviewFindings`):

```markdown
## Unresolved PR review comments to address

{{prReviewFeedback}}

Make the necessary changes...
```

- On repair rounds inside babysit we can also pass the latest unresolved comments (refreshed via `getPrFeedback`).

The existing `lastFullVerifyOutput` / `lastReviewOutput` can still be passed for continuity.

### 4.5 Webhook setup instruction in the PR body

Because rich bodies are now built by `buildRichPrBody` (and committed design/plan artifacts exist), we inject a small, durable instruction.

Best place: append (or add as a final section) in `buildRichPrBody`, something like:

```markdown
---

**To let the agent automatically respond to review comments** on this PR, ensure your repository webhook delivers **Pull request reviews** events (in addition to Issues).

See the gateway docs for the exact events and secret configuration.
```

For PRs created before this feature, `devCyclePrRepair` can post a one-time comment with the same text the first time it runs (deduped).

### 4.6 Relationship to existing babysit

- The inline babysit inside a fresh `devCycle` can stay as-is for the initial post-creation window (it will now receive better context because of the rich bodies and the improved implement prompt).
- For any review that arrives later (or for independent repair), `devCyclePrRepair` is the entry point.
- Future cleanup could have the original `devCycle` simply `executeChild(devCyclePrRepair, ...)` after opening the PR, but that is out of scope for the first cut.

## 5. Contracts & ports changes (minimal)

- New `DevCyclePrRepairInput` schema + type (contracts).
- Possibly a small extension to `OpenPrRequest` or the activities surface if we want to pass labels explicitly (already partially done by #93).
- `getPrFeedback` / `PrFeedback` is already sufficient.
- New activity or enhancement for "prepare workspace for existing PR branch" if the current prepareWorkspace isn't flexible enough.

## 6. Error handling, brakes, observability

- Same brakes, resume signals (`resume`, `stop`, `cancel`), budget handling as `devCycle`.
- Same stats and stage result recording (stage names can be `pr_repair_implement`, `pr_babysit`, etc. or we reuse the normal names with a "repair" context flag).
- State can largely reuse `DevCycleState` (it already has `prRef`, `babysitRounds`, etc.).

## 7. Testing

- Unit tests for the new parser and start logic in gateway.
- Unit + e2e coverage for `devCyclePrRepair` (similar to existing `dev-cycle.e2e.test.ts` patterns, using scripted `getPrFeedback` that introduces unresolved comments).
- Test that the webhook instruction appears in the generated PR body.
- Test repair on a PR whose original devCycle has already completed.

## 8. Rollout considerations

- The feature is safe to roll out incrementally: PRs without the webhook configured simply won't trigger automatic repairs (the instruction in the body tells maintainers what to do).
- Existing babysit behavior is unchanged for PRs that never receive reviews after opening.

## 9. Open questions / future work

- Should repair rounds inside `devCyclePrRepair` always run the full verify + internal review, or can some babysit repairs stay lighter?
- Richer review context (full thread + suggestions) in a follow-up.
- Automatic re-trigger on new review comments while a repair is already running (signaling the workflow).
- Post-merge handling or a "nightly PR review" Tier-2 workflow.

---

This spec captures the outcome of the 2026-07-13 brainstorming session for #94, adjusted for the pieces that landed in main on 2026-07-13/14 (labeling + rich PR descriptions).