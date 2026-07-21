# Plan — Task issue-agentic-ops-engine-132

**Title:** [bughunt] platformChat continueAsNew silently drops accumulated actions/children and truncates history

Design: `docs/superpowers/specs/issue-agentic-ops-engine-132-design.md` (Approach A — carry full
conversational state across `continueAsNew`).

## Summary of the change

`platformChat` calls `continueAsNew` from a quiescent `awaiting-user` phase once messages cross
`CONTINUE_AS_NEW_AFTER` (200). The carry today is `{ messages: last 20, seq, workspaceRef }`, which
(a) resets the `actionsExecuted` and `childWorkflows` accumulators, under-reporting them in the
final result, (b) truncates the `conversation` query transcript to 20 and under-reports `turns`, and
(c) restarts child fix-id numbering, causing a `WorkflowExecutionAlreadyStarted` collision on the
second post-continuation fix. The fix carries the full transcript plus both accumulators across
`continueAsNew`, leaving the per-turn `TRANSCRIPT_WINDOW` slice untouched.

## Steps

### Step 1 — Extend the carry contract (contracts first; unblocks everything)

**File:** `packages/contracts/src/platform-chat.ts`

- Factor the inline child-workflow element shape out of `PlatformChatResultSchema` into a named
  `ChatChildWorkflowSchema`:
  `z.object({ workflowId: z.string().min(1), repo: z.string().min(1), goal: z.string().min(1) })`,
  exported with a `ChatChildWorkflow` type. Reference it in `PlatformChatResultSchema.childWorkflows`
  in place of the inline object (AGENTS.md rule 3: no structural duplication of a contract type,
  now that the carry references the same shape).
- Extend `PlatformChatCarrySchema` with two new fields (existing `messages`, `seq`, `workspaceRef`
  unchanged in shape):
  - `actionsExecuted: z.array(PlatformActionSchema).default([])`
  - `childWorkflows: z.array(ChatChildWorkflowSchema).default([])`
  - The `.default([])` gives the graceful cross-deploy degradation (an old run hands a new-code run
    a carry lacking these fields → they default to empty, i.e. today's behavior for that single
    boundary, correct thereafter).
- `PlatformActionSchema` is already imported from `./platform-agent`; no new import needed.

**Verify:** `pnpm --filter @agentops/contracts typecheck`. Full assertion lands in Step 3.

**Why first:** the workflow (Step 2) reads `carry.actionsExecuted` / `carry.childWorkflows`, which
don't type-check until the schema exists. Contracts-first is also the AGENTS.md rule.

### Step 2 — Carry full state through the workflow

**File:** `packages/workflows/src/platform-chat.ts`

- **Seed accumulators from carry** (currently lines 66–67): change
  `const actionsExecuted: PlatformAction[] = [];` →
  `const actionsExecuted: PlatformAction[] = carry ? [...carry.actionsExecuted] : [];`
  and
  `const childWorkflows: PlatformChatResult['childWorkflows'] = [];` →
  `const childWorkflows: PlatformChatResult['childWorkflows'] = carry ? [...carry.childWorkflows] : [];`
  Copy the arrays (spread), do not alias the carry, preserving the existing "mutate a fresh local
  array" pattern.
- **Carry full state on continueAsNew** (currently lines 254–260): change the payload from
  `{ messages: messages.slice(-TRANSCRIPT_WINDOW), seq, workspaceRef }` to
  `{ messages, seq, workspaceRef, actionsExecuted, childWorkflows }` — `messages` is now the full
  array (drop the `.slice(-TRANSCRIPT_WINDOW)`).
- **No change** to `const windowed = messages.slice(-TRANSCRIPT_WINDOW)` (line 177): the agent still
  sees only the recent window each turn. This is the intentional behavior the bug conflated with
  cross-continuation persistence.
- The child-id collision is fixed transitively — with `childWorkflows` carried,
  `childWorkflows.length` stays monotonic across continuations, so
  `${chatId}-fix-${childWorkflows.length + 1}` stays unique. No separate code change.
- The final `return` block is unchanged in code but now reflects the whole conversation.

**Verify:** `pnpm --filter @agentops/workflows typecheck`; determinism self-check — confirm no new
I/O, `Date.now`/`Math.random`, timers, or `activities`/`ports` imports were introduced (only array
spreads and a changed `continueAsNew` payload). Behavioral assertions land in Step 3.

### Step 3 — Tests

**File:** `packages/contracts/src/platform-chat.test.ts`

- Import `PlatformChatCarrySchema` (and `ChatChildWorkflowSchema` if asserting it directly).
- Add a test asserting `PlatformChatCarrySchema.parse` defaults `actionsExecuted` and
  `childWorkflows` to `[]` when omitted (cross-deploy degradation), and accepts them when present.
- Add/extend a test asserting the `PlatformChatResult` `childWorkflows` shape is unchanged after the
  `ChatChildWorkflowSchema` refactor (parse a result with a populated `childWorkflows` entry).

**File:** `packages/workflows/src/platform-chat.test.ts`

Prefer invoking the workflow directly with a seeded `carry` over driving 200 real messages through
the time-skipping env — a 200-message drive is slow and brittle, whereas a seeded carry exercises
exactly the seed-from-carry path the fix changes. Add a test that starts `platformChat` with a
non-empty carry:
`{ messages: [<a few, incl. ≥1 agent message>], seq: <n>, workspaceRef: 'ws-1', actionsExecuted: [<one terminate/signal action>], childWorkflows: [{ workflowId: '<chatId>-fix-1', repo: 'r', goal: 'g' }] }`
and assert:
- the `conversation` query returns the full carried transcript (length == seeded length + any new
  messages), not a 20-cap;
- after driving the chat to `done`, the result's `actionsExecuted` and `childWorkflows` include the
  pre-seeded entries (accumulators survive);
- `turns` counts all agent-role messages across the seeded + new transcript, not just the window;
- **regression:** approve a `fix` proposal when the carry already has one child, and assert the new
  child workflowId is `<chatId>-fix-2`, not `<chatId>-fix-1`. This requires
  `resolveRepoConfig` to return `{ registered: true, project, config }` for this case (the shared
  `scriptedActivities` currently returns `{ registered: false }`) — add a variant/override activity
  set that registers the repo and records the `executeChild` workflowId (e.g. capture the child id;
  in the time-skipping env the child `devCycle` will attempt to start, so stub/register it on the
  worker or capture the minted id before the child runs). Assert the captured child id ends with
  `-fix-2`.

How the carry reaches the workflow in a test: `env.client.workflow.start(platformChat, { args: [input, carry] })` — `carry` is the second positional workflow arg.

**Verify (whole task Definition of Done):**
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test` (contracts + workflows suites green, including the new tests)
- `pnpm e2e` (workflows and contracts are touched, so e2e is required per AGENTS.md rule 6)

### Step 4 — Docs / commit hygiene

- No `docs/software-lifecycle-vision.md` change: this is a bugfix that preserves the existing
  lifecycle and workflow semantics, not a lifecycle change. The design note already records the
  behavior change; no vision edit needed.
- No new TODOs. The single deferred item (offload cold transcript prefix if payload limits are ever
  approached) is recorded in the design's Assumptions as a future follow-up, not left as an inline
  TODO.

**Verify:** `git status` shows only the two source files, two test files, and the plan/spec docs
changed; `git diff` review confirms no stray edits.

## Sequencing notes

- **Contracts (Step 1) before workflow (Step 2)** is mandatory, not just AGENTS.md convention: the
  workflow references `carry.actionsExecuted` / `carry.childWorkflows`, which don't type-check until
  the schema fields exist.
- **Workflow (Step 2) before tests (Step 3):** the workflow tests assert post-fix behavior (full
  transcript in the query, surviving accumulators, monotonic fix ids). Writing them first would just
  produce a red suite with no intermediate signal; the design already fixes the acceptance criteria,
  so there is no TDD red-green ordering benefit here. Steps 1 and 2 are individually type-checked, so
  each is independently verified before the behavioral tests run.
- Step 1's two sub-changes (the `ChatChildWorkflowSchema` extraction and the carry extension) are
  bundled because the extraction exists *to be reused by* the carry extension — they are one coherent
  contract change, not two.

## Assumptions

- **Test strategy: seed a carry rather than drive 200 messages.** The design's DoD offers either
  "drives enough messages to trigger continueAsNew *or* invokes the workflow directly with a `carry`".
  I chose the seeded-carry path: it is fast and deterministic and exercises exactly the seed-from-carry
  and full-transcript-query code the fix touches, whereas a 200-message drive in the time-skipping env
  is slow and adds no coverage of the changed lines. The continueAsNew *payload* construction itself is
  covered by typecheck plus the seeded-carry behavior (state that could only have arrived via a prior
  continuation).
- **Registering a repo in the fix-collision regression test.** The shared `scriptedActivities` helper
  returns `{ registered: false }`, which short-circuits the `fix` branch before a child id is minted.
  The regression test needs `resolveRepoConfig` to return `{ registered: true, ... }` and a way to
  capture the minted child workflowId. I will add a purpose-built activities object (or extend the
  helper with an override) for that one test rather than changing the shared helper's default, so the
  existing tests that rely on `{ registered: false }` are unaffected.
- **No vision-doc change.** Per AGENTS.md, workflow *behavior* changes start from
  `docs/software-lifecycle-vision.md`. This change restores the intended behavior (full result +
  intact query) without altering the chat lifecycle, continueAsNew policy, or any stage/status
  vocabulary, so the vision doc is preserved as-is. If a reviewer disagrees, the design note is the
  place that records the behavior delta.
- **Cross-deploy carry compatibility is handled by `.default([])`**, per the design; no migration or
  carry-versioning machinery is added, since `PlatformChatCarry` is an internal, non-public surface.
