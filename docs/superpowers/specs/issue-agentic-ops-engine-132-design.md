# Design — Task issue-agentic-ops-engine-132

**Title:** [bughunt] platformChat continueAsNew silently drops accumulated actions/children and truncates history

## Goal

`platformChat` (`packages/workflows/src/platform-chat.ts`) is a long-running conversational
workflow. To keep Temporal's event history bounded, it calls `continueAsNew` once the message
count crosses `CONTINUE_AS_NEW_AFTER` (200) from a quiescent `awaiting-user` phase. The carry
handed to the next run today contains only `{ messages: last 20, seq, workspaceRef }`.

Two accumulators and the full transcript are **not** carried, so every continueAsNew silently:

1. **Drops `actionsExecuted` and `childWorkflows`.** These local arrays (lines 66–67) accumulate
   for the life of the conversation and are returned in `PlatformChatResult` on close. After a
   continueAsNew they reset to empty, so the final result under-reports every terminate/signal
   action and every fix child spawned before the last continuation.
2. **Truncates the transcript to `TRANSCRIPT_WINDOW` (20).** The carry persists only
   `messages.slice(-TRANSCRIPT_WINDOW)`. The `conversation` query (which returns the full
   `messages` array) therefore drops to 20 messages after a continuation, and the `turns` count in
   the final result — computed as `messages.filter(role === 'agent').length` — under-reports the
   number of agent turns.

There is also a latent correctness bug that falls out of (1): child fix workflow ids are minted as
`${chatId}-fix-${childWorkflows.length + 1}`. `chatId` is stable across continueAsNew, but
`childWorkflows` resets, so the numbering restarts at 1 and the *second* post-continuation fix
would reuse an already-taken `${chatId}-fix-1` workflowId → `executeChild` fails with
`WorkflowExecutionAlreadyStarted`. Carrying `childWorkflows` fixes this for free.

Fix: carry the full conversational state that outlives a single run — full transcript plus both
accumulators — across `continueAsNew`, without disturbing the separate, intentional
`TRANSCRIPT_WINDOW` slice that bounds what is fed to the agent each turn.

## Approaches considered

### Approach A — Carry full state in the workflow input (recommended)

Extend `PlatformChatCarrySchema` to include the full `messages` array, `actionsExecuted`, and
`childWorkflows`. Seed all three from the carry at workflow start, and pass all three (full,
un-windowed) to `continueAsNew`.

- **Trade-off:** the continueAsNew input grows with conversation length (one `WorkflowExecutionStarted`
  event carrying the whole transcript). This is O(messages) but is a *single* event per run, whereas
  the thing continueAsNew actually exists to bound — the accumulated signal/activity/timer event
  history — is still reset on every continuation. Chat payloads are small text; a 200-message
  transcript is far below Temporal's default payload limits.
- **Cost:** low. One additive contract change (+ a small schema-factoring for DRY) and a handful of
  lines in the workflow. No new activities, no new packages, no storage.

### Approach B — Persist history/actions to an external store, carry only counters/refs

Write the transcript and accumulators to a store via an activity on each continuation; carry only a
running `turnsSoFar` counter and a store reference. The result and query read back from the store.

- **Trade-off:** Temporal **queries must be synchronous and may not call activities or do I/O**, so
  the `conversation` query could only ever return in-memory state — it would still be truncated to
  the window unless we *also* keep full messages in memory, which defeats the point. This trades a
  small, self-contained fix for a new persistence surface, new failure modes, and a query that still
  can't show full history. Materially larger change for strictly worse ergonomics.
- **Cost:** high (new activity, new store contract, new tests, still doesn't fix the query).

### Approach C — Bound the carried transcript at a large cap + carry a `turnsSoFar` counter

Keep carrying only a window (say, a large N), plus a `turnsSoFar` counter and the two accumulators,
so the final `turns` count and actions/children are correct even though the query view is capped.

- **Trade-off:** the accumulators and count are fixed, but the `conversation` query is *still*
  silently truncated — exactly the "truncates history" half of the reported bug. It only papers over
  the result numbers. Adds a redundant counter that duplicates information already derivable from a
  full `messages` array.
- **Cost:** low, but it deliberately leaves half the reported bug unfixed.

## Chosen approach

**Approach A.** It is the smallest change that fixes *both* halves of the reported bug plus the
latent child-id collision, and it keeps a single source of truth (the `messages` array) for the
`turns` count and the query rather than introducing a parallel counter.

- **B** is rejected because Temporal queries cannot do I/O, so it cannot restore full history to the
  `conversation` query — the very symptom being fixed — while costing far more.
- **C** is rejected because it explicitly leaves the transcript-truncation symptom in place; the
  issue names truncated history as a defect, not a design choice.

The concern that motivates B/C — unbounded carry growth — is real but not load-bearing here: chat
workflows auto-close on 30-minute idle and on `done`, transcripts are small text, and continueAsNew
already does its actual job (resetting event history) regardless of input size. The residual
payload-size risk is recorded as an assumption with a cheap follow-up if it ever bites.

## Assumptions

- **Full transcript in the carry is acceptable vs. Temporal payload limits.** A single chat's
  transcript stays well under Temporal's default gRPC/blob payload caps given bounded chat lifetimes
  (30-min idle auto-close, `done` close). I am *not* adding a hard cap now, because any cap
  re-introduces the silent-truncation bug this task exists to remove. If extreme-length chats ever
  approach the limit, the follow-up is to offload the cold prefix of the transcript to an activity-
  backed store and keep only a recent tail hot — tracked as a separate issue, not done here.
- **The `TRANSCRIPT_WINDOW` slice fed to the agent each turn (`messages.slice(-TRANSCRIPT_WINDOW)`
  at line 177) is intentional and stays unchanged.** The bug was conflating "what the agent sees per
  turn" (a window, correct) with "what persists across continuation" (must be the full state). Only
  the latter changes.
- **`PlatformChatCarry` remains an internal, non-public surface** (as its comment already states),
  so extending it is not a breaking API change and needs no versioning/migration. In-flight
  workflows continuing across the deploy: an old run built before the deploy will hand a carry
  without the new fields to a new-code run. The new fields are defaulted (empty array), so the
  new run starts those accumulators empty — i.e. identical to today's behavior for that single
  boundary, then correct thereafter. No crash, graceful degradation. This is acceptable for an
  internal carry and avoids any migration machinery.
- **`turns` continues to be derived from the full `messages` array**, not a stored counter, so no
  new field is needed for it once full messages are carried.

## Design

Scope: one coherent change across two files (plus tests). No unrelated work bundled.

### `packages/contracts/src/platform-chat.ts`

- Factor the inline child-workflow element shape out of `PlatformChatResultSchema` into a named
  `ChatChildWorkflowSchema` (`{ workflowId, repo, goal }`, all `min(1)`), and reuse it in the result
  schema. This avoids structural duplication of a contract type (AGENTS.md rule 3) when the same
  shape is now referenced from the carry.
- Extend `PlatformChatCarrySchema` with:
  - `actionsExecuted: z.array(PlatformActionSchema).default([])`
  - `childWorkflows: z.array(ChatChildWorkflowSchema).default([])`
  - (existing `messages`, `seq`, `workspaceRef` unchanged in shape; semantics of `messages` become
    "full transcript", enforced by the workflow no longer slicing it into the carry)
  - `.default([])` on the two new arrays gives the graceful cross-deploy degradation described in
    Assumptions.

### `packages/workflows/src/platform-chat.ts`

- **Seed accumulators from carry** (lines 66–67): initialize
  `const actionsExecuted = carry ? [...carry.actionsExecuted] : []` and
  `const childWorkflows = carry ? [...carry.childWorkflows] : []`. Copy the arrays (don't alias the
  carry) to preserve the existing "mutate a fresh local array" pattern.
- **Carry full state on continueAsNew** (lines 254–260): pass
  `{ messages, seq, workspaceRef, actionsExecuted, childWorkflows }` — note `messages` is the full
  array, dropping the `.slice(-TRANSCRIPT_WINDOW)`.
- **No change** to the per-turn `windowed = messages.slice(-TRANSCRIPT_WINDOW)` (line 177): the
  agent still sees only the recent window each turn.
- **Child-id collision fixed transitively:** with `childWorkflows` carried, `childWorkflows.length`
  keeps increasing across continuations, so `${chatId}-fix-${childWorkflows.length + 1}` stays
  monotonic and unique. No separate change needed; add a regression assertion in tests.
- The final `return` (turns/actionsExecuted/childWorkflows) is unchanged in code but now reflects the
  whole conversation because the accumulators and full `messages` survive continuations.

### Data flow after the fix

```
run N (messages≥200, awaiting-user)
  continueAsNew(input, { messages: FULL, seq, workspaceRef, actionsExecuted, childWorkflows })
run N+1 starts
  messages     = [...carry.messages]        // full transcript → conversation query intact
  actionsExecuted = [...carry.actionsExecuted]  // accumulators intact → result correct
  childWorkflows  = [...carry.childWorkflows]    // fix ids stay monotonic → no id collision
  ... continues; TRANSCRIPT_WINDOW still bounds per-turn agent context ...
close → result { turns: full agent count, actionsExecuted: all, childWorkflows: all }
```

### Error handling / edge cases

- **Cross-deploy carry without new fields:** handled by `.default([])` — no throw, one boundary of
  today's (buggy) behavior, correct thereafter.
- **Determinism:** all changes stay within the workflow determinism boundary (no I/O, no
  `Date.now`/`Math.random`, no new imports from `activities`/`ports`); only array copies and the
  continueAsNew payload change. Safe under replay.
- **Payload growth:** accepted per Assumptions; no functional error path.

### Tests (Definition of Done)

- `packages/contracts/src/platform-chat.test.ts`: assert `PlatformChatCarrySchema` accepts the new
  fields and defaults them to `[]` when omitted; assert `ChatChildWorkflowSchema` reuse keeps the
  result shape unchanged.
- `packages/workflows/src/platform-chat.test.ts`: a test that drives enough messages to trigger
  continueAsNew (or invokes the workflow directly with a `carry` containing non-empty
  `actionsExecuted`/`childWorkflows`/full `messages`) and asserts:
  - the final result's `actionsExecuted`/`childWorkflows` include pre-continuation entries;
  - `turns` reflects the full transcript, not the window;
  - the `conversation` query returns the full carried transcript;
  - a fix proposed after a carry with one existing child mints `...-fix-2`, not `...-fix-1`.
- `pnpm lint && pnpm typecheck && pnpm test`; run `pnpm e2e` since workflows/contracts are touched.

## Brainstorm Summary
**Approaches considered:** (A) carry the full transcript + both accumulators in the continueAsNew input; (B) persist history/actions to an external store and carry only refs/counters; (C) keep a windowed transcript but add a `turnsSoFar` counter and carry the accumulators.
**Chosen approach:** (A) — carry full conversational state across continueAsNew.
**Why (decisive reasons):** It fixes both reported halves (dropped actions/children *and* truncated history) plus a latent child-workflow-id collision, in one additive internal-contract change and a few workflow lines. B can't restore the `conversation` query because Temporal queries can't do I/O; C deliberately leaves history truncated. continueAsNew still bounds real event-history growth regardless of input size.
**Key risks/assumptions:** Carrying the full transcript grows the per-run input; accepted because chats are short-lived and text is small, with an offload-the-cold-prefix follow-up noted if limits are ever approached. `PlatformChatCarry` is internal, so new fields are additive/defaulted and degrade gracefully for workflows in flight across the deploy.
