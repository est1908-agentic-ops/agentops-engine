# Platform Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a multi-turn, human-in-the-loop chat with the platform agent to the Control UI, via a new `platformChat` Temporal workflow that reuses the existing platform agent internals.

**Architecture:** A new long-running `platformChat` workflow (sibling to one-shot `platform`) holds the conversation transcript, takes human turns and approvals via signals, exposes the conversation via a query, and runs one read-only `runAgent` turn per exchange. The agent *proposes* mutating actions (terminate/signal/fix); the workflow executes them only after the human approves — enforcing the gate at the workflow boundary. The `control` BFF adds token-gated chat routes; the `ui` SPA adds a chat page that polls the conversation query.

**Tech Stack:** TypeScript (strict), Temporal TS SDK (`@temporalio/*`), zod (`@agentops/contracts`), vitest + `@temporalio/testing`, Vite + React (`@agentops/ui`), plain `node:http` (`@agentops/control`).

**Spec:** `docs/superpowers/specs/2026-07-13-platform-chat-design.md` — read it before starting.

## Global Constraints

- **Determinism boundary (AGENTS.md #1):** `packages/workflows` code does no I/O, no `Date.now()`, no `Math.random()`, no timers except Temporal's; all side effects go through proxied activities. Message ordering uses a workflow-side integer counter (`seq`), never a timestamp; proposal IDs derive from `seq`.
- **`packages/policies` stays pure (AGENTS.md #2):** no Temporal imports, no I/O, no async. Pure functions with exhaustive unit tests.
- **Contracts first (AGENTS.md #3):** every new data shape is a zod schema in `packages/contracts` before use. No `any`. Validate at every boundary.
- **Ports/vendors & backends (AGENTS.md #4):** unchanged here — this feature adds no new vendor SDK calls.
- **No secrets in code/fixtures (AGENTS.md #5):** tests use the `stub` backend and in-memory ports.
- **Every task ends green:** `pnpm lint && pnpm typecheck && pnpm test`. The `pnpm e2e` suite must pass for the tasks touching workflows/policies/activities (Tasks 2, 3, 4, 8).
- **Conventional commits.** Stage/status names are fixed vocabulary — chat turns reuse the existing `stage: 'platform'` value; do **not** add a new `StageSchema` member.
- **v1 reuses the `platform` backend** (`tier: 'platform'`) for chat turns (spec §5). Do not add new routing/RBAC.

---

## File Structure

- `packages/contracts/src/platform-chat.ts` — **create.** All chat schemas (messages, agent turn, conversation state, decision, workflow input/carry/result, activity req/res, control wire types).
- `packages/contracts/src/index.ts` — **modify.** Re-export `./platform-chat`.
- `packages/policies/src/parse-chat-turn.ts` — **create.** `parseChatTurn` (sentinel parser) + `renderChatTranscript` (pure formatter).
- `packages/policies/src/index.ts` — **modify.** Re-export `./parse-chat-turn`.
- `packages/workflows/src/platform-activities-api.ts` — **modify.** Add `executePlatformAction` to `PlatformActivities`.
- `packages/activities/src/create-activities.ts` — **modify.** Add `signal` to `WorkflowClientLike.getHandle`; implement `executePlatformAction`.
- `packages/workflows/src/platform-chat.ts` — **create.** The `platformChat` workflow + signals + query.
- `packages/workflows/src/index.ts` — **modify.** Export `platformChat` and its signals/query.
- `packages/prompts/templates/platform-chat.md` — **create.** The conversational prompt.
- `packages/control/src/chat-routes.ts` — **create.** Six chat handlers.
- `packages/control/src/create-control-server.ts` — **modify.** `authorizeControlToken` helper + chat route dispatch.
- `packages/ui/src/api.ts` — **modify.** Five chat client functions.
- `packages/ui/src/pages/ChatPage.tsx` — **create.** The chat view.
- `packages/ui/src/pages/ChatStartPage.tsx` — **create.** Start-a-chat page + recent chats.
- `packages/ui/src/App.tsx` — **modify.** Routes + nav link.
- `packages/ui/src/chat.css` — **create.** Minimal chat styling, imported by ChatPage.
- `e2e/platform-chat.e2e.test.ts` — **create.** Stub-backend scripted chat.

---

## Task 1: Chat contracts

**Files:**
- Create: `packages/contracts/src/platform-chat.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/platform-chat.test.ts`

**Interfaces:**
- Consumes: `PlatformActionSchema` from `./platform-agent` (`{ type: 'terminate'|'signal', workflowId, reason }`).
- Produces: schemas/types listed below — every later task imports from `@agentops/contracts`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/contracts/src/platform-chat.test.ts
import { describe, expect, it } from 'vitest';
import {
  AgentTurnSchema,
  ChatMessageSchema,
  ConversationStateSchema,
  ExecutePlatformActionRequestSchema,
  PlatformChatInputSchema,
  PlatformChatResultSchema,
} from './platform-chat';

describe('platform-chat contracts', () => {
  it('accepts a plain agent reply turn and defaults done to false', () => {
    const turn = AgentTurnSchema.parse({ message: 'Looks healthy.' });
    expect(turn.done).toBe(false);
    expect(turn.pending).toBeUndefined();
  });

  it('accepts a proposal turn with a drafted action (no id yet)', () => {
    const turn = AgentTurnSchema.parse({
      message: 'I want to terminate the stuck run.',
      pending: { kind: 'proposal', proposal: { type: 'terminate', workflowId: 'wf-1', reason: 'stuck 3h' } },
    });
    expect(turn.pending?.kind).toBe('proposal');
  });

  it('rejects a message with an unknown pending kind', () => {
    expect(() => AgentTurnSchema.parse({ message: 'x', pending: { kind: 'nope' } })).toThrow();
  });

  it('parses a conversation state with a pending proposal that has an id', () => {
    const state = ConversationStateSchema.parse({
      chatId: 'c1',
      phase: 'awaiting-approval',
      messages: [{ seq: 1, role: 'user', text: 'hi' }],
      pendingProposal: { id: 'p-2', type: 'signal', workflowId: 'wf-1', signalName: 'resume', reason: 'unblock' },
    });
    expect(state.pendingProposal?.id).toBe('p-2');
  });

  it('rejects a chat message with a negative seq', () => {
    expect(() => ChatMessageSchema.parse({ seq: -1, role: 'user', text: 'x' })).toThrow();
  });

  it('defaults result arrays', () => {
    const result = PlatformChatResultSchema.parse({ turns: 3 });
    expect(result.actionsExecuted).toEqual([]);
    expect(result.childWorkflows).toEqual([]);
  });

  it('requires a non-empty reason on an execute-action request', () => {
    expect(() =>
      ExecutePlatformActionRequestSchema.parse({ type: 'terminate', workflowId: 'wf-1', reason: '' }),
    ).toThrow();
    expect(PlatformChatInputSchema.parse({}).prompt).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @agentops/contracts test -- platform-chat`
Expected: FAIL — `Cannot find module './platform-chat'`.

- [ ] **Step 3: Create the contracts file**

```ts
// packages/contracts/src/platform-chat.ts
import { z } from 'zod';
import { PlatformActionSchema } from './platform-agent';

export const ChatRoleSchema = z.enum(['user', 'agent', 'system']);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ChatMessageKindSchema = z.enum([
  'reply',
  'question',
  'proposal',
  'decision',
  'action-result',
  'error',
]);
export type ChatMessageKind = z.infer<typeof ChatMessageKindSchema>;

export const ChatMessageSchema = z.object({
  seq: z.number().int().nonnegative(),
  role: ChatRoleSchema,
  text: z.string(),
  kind: ChatMessageKindSchema.optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatActionTypeSchema = z.enum(['terminate', 'signal', 'fix']);
export type ChatActionType = z.infer<typeof ChatActionTypeSchema>;

// A proposal as the agent drafts it (no id yet).
export const ActionProposalDraftSchema = z.object({
  type: ChatActionTypeSchema,
  workflowId: z.string().optional(), // terminate/signal
  signalName: z.string().optional(), // signal
  repo: z.string().optional(), // fix
  goal: z.string().optional(), // fix
  reason: z.string().min(1),
});
export type ActionProposalDraft = z.infer<typeof ActionProposalDraftSchema>;

// A proposal after the workflow assigns a deterministic id.
export const ActionProposalSchema = ActionProposalDraftSchema.extend({
  id: z.string().min(1),
});
export type ActionProposal = z.infer<typeof ActionProposalSchema>;

// The agent's structured turn output (parsed from the CHAT_TURN: sentinel line).
export const AgentTurnSchema = z.object({
  message: z.string(),
  pending: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('question') }),
      z.object({ kind: z.literal('proposal'), proposal: ActionProposalDraftSchema }),
    ])
    .optional(),
  done: z.boolean().default(false),
});
export type AgentTurn = z.infer<typeof AgentTurnSchema>;

export const ChatPhaseSchema = z.enum([
  'awaiting-user',
  'agent-thinking',
  'awaiting-answer',
  'awaiting-approval',
  'closed',
]);
export type ChatPhase = z.infer<typeof ChatPhaseSchema>;

export const ConversationStateSchema = z.object({
  chatId: z.string(),
  phase: ChatPhaseSchema,
  messages: z.array(ChatMessageSchema),
  pendingProposal: ActionProposalSchema.optional(),
});
export type ConversationState = z.infer<typeof ConversationStateSchema>;

export const ChatDecisionSchema = z.object({
  proposalId: z.string().min(1),
  approve: z.boolean(),
  note: z.string().optional(),
});
export type ChatDecision = z.infer<typeof ChatDecisionSchema>;

export const PlatformChatInputSchema = z.object({
  prompt: z.string().optional(),
  hintRepos: z.array(z.string()).optional(),
});
export type PlatformChatInput = z.infer<typeof PlatformChatInputSchema>;

// Internal 2nd workflow arg, carried across continueAsNew. Not a public surface.
export const PlatformChatCarrySchema = z.object({
  messages: z.array(ChatMessageSchema),
  seq: z.number().int().nonnegative(),
  workspaceRef: z.string(),
});
export type PlatformChatCarry = z.infer<typeof PlatformChatCarrySchema>;

export const PlatformChatResultSchema = z.object({
  turns: z.number().int().nonnegative(),
  actionsExecuted: z.array(PlatformActionSchema).default([]),
  childWorkflows: z
    .array(z.object({ workflowId: z.string().min(1), repo: z.string().min(1), goal: z.string().min(1) }))
    .default([]),
});
export type PlatformChatResult = z.output<typeof PlatformChatResultSchema>;

// Activity: execute an approved terminate/signal (fix goes through a child devCycle, not here).
export const ExecutePlatformActionRequestSchema = z.object({
  type: z.enum(['terminate', 'signal']),
  workflowId: z.string().min(1),
  signalName: z.string().optional(),
  reason: z.string().min(1),
});
export type ExecutePlatformActionRequest = z.infer<typeof ExecutePlatformActionRequestSchema>;

export const ExecutePlatformActionResultSchema = z.object({
  ok: z.boolean(),
  detail: z.string(),
});
export type ExecutePlatformActionResult = z.infer<typeof ExecutePlatformActionResultSchema>;

// --- control BFF wire types ---
export const StartChatRequestSchema = PlatformChatInputSchema;
export type StartChatRequest = z.infer<typeof StartChatRequestSchema>;
export const StartChatResponseSchema = z.object({ chatId: z.string(), runId: z.string() });
export type StartChatResponse = z.infer<typeof StartChatResponseSchema>;
export const SendTurnRequestSchema = z.object({ text: z.string().min(1) });
export type SendTurnRequest = z.infer<typeof SendTurnRequestSchema>;
export const DecisionRequestSchema = ChatDecisionSchema;
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;
```

- [ ] **Step 4: Re-export from the contracts index**

In `packages/contracts/src/index.ts`, add alongside the other `export * from './platform-*'` lines:

```ts
export * from './platform-chat';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @agentops/contracts test -- platform-chat`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/platform-chat.ts packages/contracts/src/platform-chat.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): platform chat schemas"
```

---

## Task 2: Chat turn parser + transcript renderer (policies)

**Files:**
- Create: `packages/policies/src/parse-chat-turn.ts`
- Modify: `packages/policies/src/index.ts`
- Test: `packages/policies/src/parse-chat-turn.test.ts`

**Interfaces:**
- Consumes: `AgentTurnSchema`, `AgentTurn`, `ChatMessage` from `@agentops/contracts`.
- Produces:
  - `parseChatTurn(text: string): { parseable: boolean; turn: AgentTurn }`
  - `renderChatTranscript(messages: ChatMessage[]): string`

- [ ] **Step 1: Write the failing test**

```ts
// packages/policies/src/parse-chat-turn.test.ts
import { describe, expect, it } from 'vitest';
import { parseChatTurn, renderChatTranscript } from './parse-chat-turn';

describe('parseChatTurn', () => {
  it('parses the last CHAT_TURN: line as a reply', () => {
    const out = 'thinking...\nCHAT_TURN: {"message":"All green.","done":true}';
    const parsed = parseChatTurn(out);
    expect(parsed.parseable).toBe(true);
    expect(parsed.turn.message).toBe('All green.');
    expect(parsed.turn.done).toBe(true);
  });

  it('parses a proposal turn', () => {
    const out = 'CHAT_TURN: {"message":"Terminate it?","pending":{"kind":"proposal","proposal":{"type":"terminate","workflowId":"wf-1","reason":"stuck"}}}';
    const parsed = parseChatTurn(out);
    expect(parsed.parseable).toBe(true);
    expect(parsed.turn.pending?.kind).toBe('proposal');
  });

  it('uses the last sentinel when several are present', () => {
    const out = 'CHAT_TURN: {"message":"first"}\nCHAT_TURN: {"message":"second"}';
    expect(parseChatTurn(out).turn.message).toBe('second');
  });

  it('returns not-parseable on a missing sentinel', () => {
    expect(parseChatTurn('no sentinel here').parseable).toBe(false);
  });

  it('returns not-parseable on malformed JSON', () => {
    expect(parseChatTurn('CHAT_TURN: {not json}').parseable).toBe(false);
  });

  it('returns not-parseable when JSON fails the schema', () => {
    expect(parseChatTurn('CHAT_TURN: {"pending":{"kind":"question"}}').parseable).toBe(false);
  });
});

describe('renderChatTranscript', () => {
  it('labels roles and joins with blank lines', () => {
    const text = renderChatTranscript([
      { seq: 1, role: 'user', text: 'check logs' },
      { seq: 2, role: 'agent', text: 'looking' },
      { seq: 3, role: 'system', text: 'terminated wf-1' },
    ]);
    expect(text).toContain('Operator: check logs');
    expect(text).toContain('You (agent): looking');
    expect(text).toContain('System: terminated wf-1');
  });

  it('handles an empty transcript', () => {
    expect(renderChatTranscript([])).toBe('(no messages yet)');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @agentops/policies test -- parse-chat-turn`
Expected: FAIL — `Cannot find module './parse-chat-turn'`.

- [ ] **Step 3: Implement the parser and renderer**

```ts
// packages/policies/src/parse-chat-turn.ts
import { AgentTurnSchema, type AgentTurn, type ChatMessage } from '@agentops/contracts';

export interface ParsedChatTurn {
  parseable: boolean;
  turn: AgentTurn;
}

const EMPTY_TURN: AgentTurn = { message: '', done: false };

export function parseChatTurn(text: string): ParsedChatTurn {
  // Fresh per call: a g-flagged RegExp is stateful across exec() via lastIndex
  // (same reasoning as parse-platform-result.ts).
  const pattern = /^CHAT_TURN:\s*(.+)$/gm;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    lastMatch = match;
  }
  if (!lastMatch) {
    return { parseable: false, turn: EMPTY_TURN };
  }
  try {
    const json: unknown = JSON.parse(lastMatch[1]);
    return { parseable: true, turn: AgentTurnSchema.parse(json) };
  } catch {
    return { parseable: false, turn: EMPTY_TURN };
  }
}

export function renderChatTranscript(messages: ChatMessage[]): string {
  if (messages.length === 0) {
    return '(no messages yet)';
  }
  return messages
    .map((m) => {
      const who = m.role === 'user' ? 'Operator' : m.role === 'agent' ? 'You (agent)' : 'System';
      return `${who}: ${m.text}`;
    })
    .join('\n\n');
}
```

- [ ] **Step 4: Re-export from the policies index**

In `packages/policies/src/index.ts`, add (near the `export * from './parse-platform-result';` line):

```ts
export * from './parse-chat-turn';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @agentops/policies test -- parse-chat-turn`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/policies/src/parse-chat-turn.ts packages/policies/src/parse-chat-turn.test.ts packages/policies/src/index.ts
git commit -m "feat(policies): parseChatTurn + renderChatTranscript"
```

---

## Task 3: `executePlatformAction` activity

**Files:**
- Modify: `packages/workflows/src/platform-activities-api.ts`
- Modify: `packages/activities/src/create-activities.ts:64-68` (extend `WorkflowClientLike`), and add the activity to the object returned by `createActivities` (`create-activities.ts:88`)
- Test: `packages/activities/src/execute-platform-action.test.ts`

**Interfaces:**
- Consumes: `ExecutePlatformActionRequest`, `ExecutePlatformActionResult` from `@agentops/contracts`; `deps.workflowClient` (`WorkflowClientLike`).
- Produces: `executePlatformAction(req: ExecutePlatformActionRequest): Promise<ExecutePlatformActionResult>` on both `PlatformActivities` and the `createActivities` return.

- [ ] **Step 1: Write the failing test**

```ts
// packages/activities/src/execute-platform-action.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createActivities, type ActivityDependencies } from './create-activities';

// Minimal deps: only workflowClient matters for this activity. The other fields
// are never touched by executePlatformAction, so cast a partial through unknown.
function makeActivities(workflowClient: ActivityDependencies['workflowClient']) {
  return createActivities({ workflowClient } as unknown as ActivityDependencies);
}

describe('executePlatformAction', () => {
  it('terminates a workflow and reports ok', async () => {
    const terminate = vi.fn().mockResolvedValue(undefined);
    const activities = makeActivities({ getHandle: () => ({ terminate }) });
    const res = await activities.executePlatformAction({ type: 'terminate', workflowId: 'wf-1', reason: 'stuck' });
    expect(terminate).toHaveBeenCalledWith('stuck');
    expect(res.ok).toBe(true);
    expect(res.detail).toContain('wf-1');
  });

  it('signals a workflow by name and reports ok', async () => {
    const signal = vi.fn().mockResolvedValue(undefined);
    const activities = makeActivities({ getHandle: () => ({ signal }) });
    const res = await activities.executePlatformAction({ type: 'signal', workflowId: 'wf-2', signalName: 'resume', reason: 'unblock' });
    expect(signal).toHaveBeenCalledWith('resume');
    expect(res.ok).toBe(true);
  });

  it('fails cleanly when a signal action omits signalName', async () => {
    const signal = vi.fn();
    const activities = makeActivities({ getHandle: () => ({ signal }) });
    const res = await activities.executePlatformAction({ type: 'signal', workflowId: 'wf-2', reason: 'x' });
    expect(res.ok).toBe(false);
    expect(signal).not.toHaveBeenCalled();
  });

  it('fails cleanly when no workflow client is configured', async () => {
    const activities = makeActivities(undefined);
    const res = await activities.executePlatformAction({ type: 'terminate', workflowId: 'wf-1', reason: 'x' });
    expect(res.ok).toBe(false);
  });

  it('reports the error detail when terminate throws', async () => {
    const terminate = vi.fn().mockRejectedValue(new Error('not found'));
    const activities = makeActivities({ getHandle: () => ({ terminate }) });
    const res = await activities.executePlatformAction({ type: 'terminate', workflowId: 'wf-x', reason: 'x' });
    expect(res.ok).toBe(false);
    expect(res.detail).toBe('not found');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @agentops/activities test -- execute-platform-action`
Expected: FAIL — `executePlatformAction` is not a function on the returned activities.

- [ ] **Step 3: Extend `WorkflowClientLike` with `signal`**

In `packages/activities/src/create-activities.ts`, change the `WorkflowClientLike.getHandle` return type (currently `create-activities.ts:64-68`):

```ts
export interface WorkflowClientLike {
  start?: (workflowType: string, opts: any) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  list?: (query?: string) => AsyncIterable<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  getHandle?: (id: string) => {
    terminate?: (reason?: string) => Promise<void>;
    signal?: (signalName: string, ...args: unknown[]) => Promise<void>;
  };
}
```

- [ ] **Step 4: Add the activity to the `createActivities` return object**

At the top of `create-activities.ts`, add to the `@agentops/contracts` import:

```ts
import type { ExecutePlatformActionRequest, ExecutePlatformActionResult } from '@agentops/contracts';
```

Then add this method inside the object literal returned by `createActivities` (alongside `runAgent`, e.g. after it):

```ts
    async executePlatformAction(
      req: ExecutePlatformActionRequest,
    ): Promise<ExecutePlatformActionResult> {
      const handle = deps.workflowClient?.getHandle?.(req.workflowId);
      if (!handle) {
        return { ok: false, detail: 'no workflow client configured' };
      }
      try {
        if (req.type === 'terminate') {
          if (!handle.terminate) {
            return { ok: false, detail: 'terminate not supported by workflow client' };
          }
          await handle.terminate(req.reason);
          return { ok: true, detail: `terminated ${req.workflowId}` };
        }
        if (!req.signalName) {
          return { ok: false, detail: 'signalName is required for a signal action' };
        }
        if (!handle.signal) {
          return { ok: false, detail: 'signal not supported by workflow client' };
        }
        await handle.signal(req.signalName);
        return { ok: true, detail: `signalled ${req.workflowId} with "${req.signalName}"` };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : 'action failed' };
      }
    },
```

- [ ] **Step 5: Add the activity to the `PlatformActivities` interface**

In `packages/workflows/src/platform-activities-api.ts`, add the import and method:

```ts
import type {
  AgentRunRequest,
  AgentRunResult,
  ExecutePlatformActionRequest,
  ExecutePlatformActionResult,
  RunStats,
} from '@agentops/contracts';
import type { RepoConfigResolution } from './activities-api';

export interface PlatformActivities {
  runAgent(req: AgentRunRequest): Promise<AgentRunResult>;
  recordRunStats(stats: RunStats): Promise<void>;
  resolveRepoConfig(repo: string): Promise<RepoConfigResolution>;
  prepareScratchWorkspace(taskId: string): Promise<{ workspaceRef: string }>;
  cleanupScratchWorkspace(workspaceRef: string): Promise<void>;
  executePlatformAction(req: ExecutePlatformActionRequest): Promise<ExecutePlatformActionResult>;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @agentops/activities test -- execute-platform-action`
Expected: PASS (5 tests).

- [ ] **Step 7: Typecheck the worker wiring is unchanged**

The worker already passes `workflowClient: tc.workflow` (`packages/worker/src/main.ts:461`) and `tc.workflow.getHandle(id).signal(...)`/`.terminate(...)` are real `@temporalio/client` methods, so no worker change is needed.

Run: `pnpm --filter @agentops/worker typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/activities/src/create-activities.ts packages/activities/src/execute-platform-action.test.ts packages/workflows/src/platform-activities-api.ts
git commit -m "feat(activities): executePlatformAction (terminate/signal via workflowClient)"
```

---

## Task 4: `platformChat` workflow

**Files:**
- Create: `packages/workflows/src/platform-chat.ts`
- Modify: `packages/workflows/src/index.ts`
- Test: `packages/workflows/src/platform-chat.test.ts`

**Interfaces:**
- Consumes: `PlatformChatInput`, `PlatformChatCarry`, `PlatformChatResult`, `ChatDecision`, `ChatMessage`, `ConversationState`, `PlatformAction`, `TaskInput`, `PlatformChatResultSchema` from `@agentops/contracts`; `parseChatTurn`, `renderChatTranscript` from `@agentops/policies`; `PlatformActivities`; `devCycle`.
- Produces:
  - `platformChat(input: PlatformChatInput, carry?: PlatformChatCarry): Promise<PlatformChatResult>`
  - `userTurnSignal` (`defineSignal<[string]>('userTurn')`)
  - `decisionSignal` (`defineSignal<[ChatDecision]>('decision')`)
  - `closeSignal` (`defineSignal('close')`)
  - `conversationQuery` (`defineQuery<ConversationState>('conversation')`)

- [ ] **Step 1: Write the failing test**

```ts
// packages/workflows/src/platform-chat.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { PlatformActivities } from './platform-activities-api';
import { conversationQuery, decisionSignal, platformChat, userTurnSignal } from './platform-chat';

let env: TestWorkflowEnvironment;
beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
});
afterAll(async () => {
  await env?.teardown();
});

// A scripted runAgent that returns one canned CHAT_TURN per call, in order.
function scriptedActivities(outputs: string[]): PlatformActivities {
  let i = 0;
  const child: string[] = [];
  const executed: unknown[] = [];
  return {
    async prepareScratchWorkspace() {
      return { workspaceRef: 'ws-1' };
    },
    async cleanupScratchWorkspace() {},
    async runAgent() {
      const output = outputs[Math.min(i, outputs.length - 1)];
      i += 1;
      return { output, tokensIn: 1, tokensOut: 1, wallMs: 1, resolvedBackend: 'stub', resolvedModel: 'stub' } as never;
    },
    async recordRunStats() {},
    async resolveRepoConfig() {
      return { registered: false } as never;
    },
    async executePlatformAction(req) {
      executed.push(req);
      return { ok: true, detail: `did ${req.type}` };
    },
  } as unknown as PlatformActivities;
}

async function withWorker<T>(activities: PlatformActivities, fn: (taskQueue: string) => Promise<T>): Promise<T> {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: 'test-chat',
    workflowsPath: require.resolve('./index'),
    activities,
  });
  return worker.runUntil(fn('test-chat'));
}

describe('platformChat', () => {
  it('records the seeded prompt, replies, and waits for the operator', async () => {
    const activities = scriptedActivities(['CHAT_TURN: {"message":"Hello, how can I help?"}']);
    await withWorker(activities, async (taskQueue) => {
      const handle = await env.client.workflow.start(platformChat, {
        taskQueue,
        workflowId: 'chat-1',
        args: [{ prompt: 'hi' }],
      });
      await env.sleep('2 seconds');
      const state = await handle.query(conversationQuery);
      expect(state.phase).toBe('awaiting-user');
      expect(state.messages.map((m) => m.role)).toEqual(['user', 'agent']);
      expect(state.messages[1].text).toBe('Hello, how can I help?');
      await handle.signal(userTurnSignal, '/close-test');
      // Second scripted turn marks done to end the run.
      await handle.terminate('test done');
    });
  });

  it('surfaces a proposal, executes it on approve, and skips it on reject', async () => {
    const activities = scriptedActivities([
      'CHAT_TURN: {"message":"Terminate the stuck run?","pending":{"kind":"proposal","proposal":{"type":"terminate","workflowId":"wf-9","reason":"stuck"}}}',
      'CHAT_TURN: {"message":"Done.","done":true}',
    ]);
    await withWorker(activities, async (taskQueue) => {
      const handle = await env.client.workflow.start(platformChat, {
        taskQueue,
        workflowId: 'chat-2',
        args: [{ prompt: 'the run wf-9 is stuck' }],
      });
      await env.sleep('2 seconds');
      let state = await handle.query(conversationQuery);
      expect(state.phase).toBe('awaiting-approval');
      expect(state.pendingProposal?.type).toBe('terminate');
      await handle.signal(decisionSignal, { proposalId: state.pendingProposal!.id, approve: true });
      const result = await handle.result();
      expect(result.actionsExecuted).toHaveLength(1);
      expect(result.actionsExecuted[0].workflowId).toBe('wf-9');
    });
  });

  it('auto-closes after the idle timeout with no input', async () => {
    const activities = scriptedActivities(['CHAT_TURN: {"message":"unused"}']);
    await withWorker(activities, async (taskQueue) => {
      const handle = await env.client.workflow.start(platformChat, {
        taskQueue,
        workflowId: 'chat-3',
        args: [{}], // no seeded prompt -> waits, then times out
      });
      await env.sleep('31 minutes'); // time-skipping fast-forwards the idle timer
      const result = await handle.result();
      expect(result.turns).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @agentops/workflows test -- platform-chat`
Expected: FAIL — `Cannot find module './platform-chat'`.

- [ ] **Step 3: Implement the workflow**

```ts
// packages/workflows/src/platform-chat.ts
import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  executeChild,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import type {
  ChatDecision,
  ChatMessage,
  ConversationState,
  PlatformAction,
  PlatformChatCarry,
  PlatformChatInput,
  PlatformChatResult,
  TaskInput,
} from '@agentops/contracts';
import { PlatformChatResultSchema } from '@agentops/contracts';
import { parseChatTurn, renderChatTranscript } from '@agentops/policies';
import { devCycle } from './dev-cycle';
import type { PlatformActivities } from './platform-activities-api';

const activities = proxyActivities<PlatformActivities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 5 },
});
const agentActivities = proxyActivities<Pick<PlatformActivities, 'runAgent'>>({
  startToCloseTimeout: '35 minutes',
  heartbeatTimeout: '15s',
  retry: { maximumAttempts: 5 },
});

// v1 reuses the platform backend (spec §5). Switch to 'platformChat' once the
// read-only credential profile lands (spec §12). `stage: 'platform'` reuses the
// existing StageSchema member -- do not add a new one (AGENTS.md).
const CHAT_TIER = 'platform';
const CHAT_MAX_TOKENS = 400_000;
const CHAT_TIMEOUT_MS = 1_800_000;
const CHAT_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // auto-close a chat idle for 30 min
const MAX_TURN_CALLS = 2; // re-ask once on an unparseable turn (mirrors platform.ts)
const TRANSCRIPT_WINDOW = 20; // messages fed back to the agent each turn
const CONTINUE_AS_NEW_AFTER = 200; // bound Temporal event history

export const userTurnSignal = defineSignal<[string]>('userTurn');
export const decisionSignal = defineSignal<[ChatDecision]>('decision');
export const closeSignal = defineSignal('close');
export const conversationQuery = defineQuery<ConversationState>('conversation');

export async function platformChat(
  input: PlatformChatInput,
  carry?: PlatformChatCarry,
): Promise<PlatformChatResult> {
  const chatId = workflowInfo().workflowId;

  const messages: ChatMessage[] = carry ? [...carry.messages] : [];
  let seq = carry?.seq ?? 0;
  let phase: ConversationState['phase'] = 'awaiting-user';
  let pendingProposal: ConversationState['pendingProposal'];
  let pendingUserText: string | undefined;
  let pendingDecision: ChatDecision | undefined;
  let closed = false;

  const actionsExecuted: PlatformAction[] = [];
  const childWorkflows: PlatformChatResult['childWorkflows'] = [];

  const push = (role: ChatMessage['role'], text: string, kind?: ChatMessage['kind']): void => {
    seq += 1;
    messages.push({ seq, role, text, kind });
  };

  setHandler(conversationQuery, () => ({ chatId, phase, messages, pendingProposal }));
  setHandler(userTurnSignal, (text: string) => {
    pendingUserText = text;
  });
  setHandler(decisionSignal, (decision: ChatDecision) => {
    pendingDecision = decision;
  });
  setHandler(closeSignal, () => {
    closed = true;
  });

  // Prepare a scratch workspace once and reuse it across turns; carry it across
  // continueAsNew so the running conversation keeps the same workspace.
  const workspaceRef = carry?.workspaceRef ?? (await activities.prepareScratchWorkspace(chatId)).workspaceRef;

  // Seed the optional first prompt as the first operator turn.
  if (!carry && input.prompt) {
    pendingUserText = input.prompt;
  }

  while (true) {
    const gotInput = await condition(
      () => pendingUserText !== undefined || pendingDecision !== undefined || closed,
      CHAT_IDLE_TIMEOUT_MS,
    );
    if (!gotInput || closed) {
      break; // idle timeout or explicit close
    }

    if (pendingUserText !== undefined) {
      push('user', pendingUserText, 'reply');
      pendingUserText = undefined;
      pendingProposal = undefined; // a free-text turn supersedes any open question/proposal
    } else if (pendingDecision !== undefined) {
      const decision = pendingDecision;
      pendingDecision = undefined;
      const proposal = pendingProposal;
      pendingProposal = undefined;
      if (!proposal || proposal.id !== decision.proposalId) {
        push('system', `decision for unknown proposal "${decision.proposalId}" ignored`, 'error');
        phase = 'awaiting-user';
        continue;
      }
      if (!decision.approve) {
        push('system', `Operator rejected: ${proposal.reason}${decision.note ? ` — ${decision.note}` : ''}`, 'decision');
      } else if (proposal.type === 'fix') {
        const resolved = await activities.resolveRepoConfig(proposal.repo ?? '');
        if (!resolved.registered) {
          push('system', `cannot fix "${proposal.repo}": no project registered for that repo`, 'error');
        } else {
          const childTaskId = `${chatId}-fix-${childWorkflows.length + 1}`;
          const taskInput: TaskInput = {
            taskId: childTaskId,
            project: resolved.project,
            repo: proposal.repo!,
            goal: proposal.goal ?? proposal.reason,
            config: resolved.config,
          };
          await executeChild(devCycle, { workflowId: childTaskId, args: [taskInput] });
          childWorkflows.push({ workflowId: childTaskId, repo: proposal.repo!, goal: taskInput.goal });
          push('system', `Started fix devCycle ${childTaskId} for ${proposal.repo}`, 'action-result');
        }
      } else {
        const res = await activities.executePlatformAction({
          type: proposal.type,
          workflowId: proposal.workflowId ?? '',
          signalName: proposal.signalName,
          reason: proposal.reason,
        });
        push('system', res.detail, 'action-result');
        if (res.ok) {
          actionsExecuted.push({ type: proposal.type, workflowId: proposal.workflowId!, reason: proposal.reason });
        }
      }
    }

    // Run one agent turn over the windowed transcript.
    phase = 'agent-thinking';
    const windowed = messages.slice(-TRANSCRIPT_WINDOW);
    let turn;
    for (let call = 1; call <= MAX_TURN_CALLS; call += 1) {
      const result = await agentActivities.runAgent({
        taskId: chatId,
        stage: 'platform',
        attempt: 1,
        callIndex: call,
        tier: CHAT_TIER,
        promptRef: 'platform-chat.md',
        promptContext: {
          taskId: chatId,
          transcript: renderChatTranscript(windowed),
          hintRepos: (input.hintRepos ?? []).join(', ') || '(none provided)',
        },
        workspaceRef,
        limits: { maxTokens: CHAT_MAX_TOKENS, idleTimeoutMs: CHAT_IDLE_TIMEOUT_MS, timeoutMs: CHAT_TIMEOUT_MS },
      });
      await activities.recordRunStats({
        taskId: chatId,
        stage: 'platform',
        backend: result.resolvedBackend ?? 'unknown',
        model: result.resolvedModel ?? 'unknown',
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        wallMs: result.wallMs,
        outcome: 'pass',
      });
      const parsed = parseChatTurn(result.output);
      if (parsed.parseable) {
        turn = parsed.turn;
        break;
      }
    }

    if (!turn) {
      push('agent', 'I could not produce a well-formed response. Please rephrase or try again.', 'error');
      phase = 'awaiting-user';
      continue;
    }

    if (turn.pending?.kind === 'proposal') {
      seq += 1;
      pendingProposal = { ...turn.pending.proposal, id: `p-${seq}` };
      messages.push({ seq, role: 'agent', text: turn.message, kind: 'proposal' });
      phase = 'awaiting-approval';
    } else if (turn.pending?.kind === 'question') {
      push('agent', turn.message, 'question');
      phase = 'awaiting-answer';
    } else {
      push('agent', turn.message, 'reply');
      phase = 'awaiting-user';
      if (turn.done) {
        closed = true;
        break;
      }
    }

    // Bound Temporal history on long-running chats. Only continue-as-new from a
    // quiescent point (awaiting-user) so we never drop a pending proposal.
    if (messages.length >= CONTINUE_AS_NEW_AFTER && phase === 'awaiting-user') {
      await continueAsNew<typeof platformChat>(input, {
        messages: messages.slice(-TRANSCRIPT_WINDOW),
        seq,
        workspaceRef,
      });
    }
  }

  // Reached only on real close / idle timeout / done -- never on continueAsNew
  // (which unwinds above). Safe to release the scratch workspace here.
  await activities.cleanupScratchWorkspace(workspaceRef);
  phase = 'closed';
  return PlatformChatResultSchema.parse({
    turns: messages.filter((m) => m.role === 'agent').length,
    actionsExecuted,
    childWorkflows,
  });
}
```

- [ ] **Step 4: Export from the workflows index**

In `packages/workflows/src/index.ts`, add:

```ts
export {
  platformChat,
  userTurnSignal,
  decisionSignal,
  closeSignal,
  conversationQuery,
} from './platform-chat';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @agentops/workflows test -- platform-chat`
Expected: PASS (3 tests). If the idle-timeout test is flaky under time-skipping, confirm `TestWorkflowEnvironment.createTimeSkipping()` is used (it fast-forwards the 30-min timer).

- [ ] **Step 6: Commit**

```bash
git add packages/workflows/src/platform-chat.ts packages/workflows/src/platform-chat.test.ts packages/workflows/src/index.ts
git commit -m "feat(workflows): platformChat interactive workflow"
```

---

## Task 5: `platform-chat.md` prompt pack

**Files:**
- Create: `packages/prompts/templates/platform-chat.md`
- Test: extend `packages/prompts/src/prompt-pack.test.ts`

**Interfaces:**
- Consumes: rendered with `promptContext: { taskId, transcript, hintRepos }` (from Task 4).
- Produces: template file resolved by `PromptPack.render('platform-chat.md', …)` (basename load from `templates/`, `prompt-pack.ts:13`).

- [ ] **Step 1: Write the failing test**

Add to `packages/prompts/src/prompt-pack.test.ts` (inside the existing top-level `describe`):

```ts
  it('renders the platform-chat template with a transcript', () => {
    const pack = new PromptPack();
    const rendered = pack.render('platform-chat.md', {
      taskId: 'chat-1',
      transcript: 'Operator: check the logs',
      hintRepos: '(none provided)',
    });
    expect(rendered).toContain('CHAT_TURN:');
    expect(rendered).toContain('check the logs');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @agentops/prompts test`
Expected: FAIL — template `platform-chat.md` not found.

- [ ] **Step 3: Create the prompt template**

```markdown
<!-- packages/prompts/templates/platform-chat.md -->
You are the platform operations agent, in a multi-turn chat with a human operator of the agentops platform. Your job is to investigate the platform and its projects (Temporal workflows, Grafana/Loki logs, Prometheus metrics, read-only Kubernetes state, read-only repo clones) and help the operator, one turn at a time.

## The conversation so far

{{transcript}}

Repos the operator suggested looking at first (hints only, not a restriction): {{hintRepos}}

## How to respond

Run read-only investigation tools freely to answer. You must **never execute a mutating action yourself.** When a change is warranted, you *propose* it and the operator approves it before anything happens. There are exactly three mutating actions, all proposal-only:

- `terminate` a workflow (needs `workflowId`)
- `signal` a workflow (needs `workflowId` and `signalName`)
- `fix` a repo — hand off to a `devCycle` that opens a PR (needs `repo` and `goal`)

Ask a clarifying `question` whenever the request is ambiguous rather than guessing.

## Output format

End every response with exactly one line, starting with `CHAT_TURN:` followed by a single-line JSON object. Put your prose for the operator in `message` (Markdown is fine). Shapes:

- Reply / answer: `CHAT_TURN: {"message":"...","done":false}`
- Set `"done":true` only when the operator's goal is fully handled and the chat can end.
- Ask a question: `CHAT_TURN: {"message":"Which workflow do you mean?","pending":{"kind":"question"}}`
- Propose an action: `CHAT_TURN: {"message":"That run has been stuck 3h; terminate it?","pending":{"kind":"proposal","proposal":{"type":"terminate","workflowId":"...","reason":"..."}}}`

Emit only one `CHAT_TURN:` line, as the last line of your response.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @agentops/prompts test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/prompts/templates/platform-chat.md packages/prompts/src/prompt-pack.test.ts
git commit -m "feat(prompts): platform-chat conversational prompt"
```

---

## Task 6: `control` chat routes

**Files:**
- Create: `packages/control/src/chat-routes.ts`
- Modify: `packages/control/src/create-control-server.ts` (add `authorizeControlToken` + dispatch)
- Test: `packages/control/src/chat-routes.test.ts`

**Interfaces:**
- Consumes: `platformChat` from `@agentops/workflows`; chat contracts from `@agentops/contracts`; `ControlDeps`, `listRunsByType`, `readJsonBody`, `HandlerResponse` from existing control modules; `matchPath` from `./route`.
- Produces:
  - `handleStartChat(deps, req)`, `handleListChats(deps, url)`, `handleGetChat(deps, chatId)`, `handleSendTurn(deps, chatId, req)`, `handleDecision(deps, chatId, req)`, `handleCloseChat(deps, chatId)`
  - `authorizeControlToken(deps, req): boolean` (in `create-control-server.ts`)

- [ ] **Step 1: Write the failing test**

```ts
// packages/control/src/chat-routes.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@temporalio/client';
import type { ControlDeps } from './create-control-server';
import {
  handleDecision,
  handleGetChat,
  handleSendTurn,
  handleStartChat,
} from './chat-routes';

function jsonReq(body: unknown): any {
  const chunks = [Buffer.from(JSON.stringify(body))];
  return {
    headers: { 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* () {
      yield* chunks;
    },
    on(event: string, cb: (arg?: unknown) => void) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      if (event === 'end') cb();
      return this;
    },
  };
}

function depsWith(client: Partial<Client['workflow']>): ControlDeps {
  return {
    client: { workflow: client } as unknown as Client,
    taskQueue: 'q',
    namespace: 'default',
    temporalUiBaseUrl: 'http://temporal.local',
  };
}

describe('chat-routes', () => {
  it('starts a platformChat and returns chatId/runId', async () => {
    const start = vi.fn().mockResolvedValue({ workflowId: 'platform-chat-1', firstExecutionRunId: 'run-1' });
    const res = await handleStartChat(depsWith({ start } as never), jsonReq({ prompt: 'hi' }));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ chatId: 'platform-chat-1', runId: 'run-1' });
    expect(start).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ memo: { prompt: 'hi' } }));
  });

  it('sends an operator turn as a signal', async () => {
    const signal = vi.fn().mockResolvedValue(undefined);
    const getHandle = vi.fn().mockReturnValue({ signal });
    const res = await handleSendTurn(depsWith({ getHandle } as never), 'chat-1', jsonReq({ text: 'check logs' }));
    expect(res.status).toBe(202);
    expect(signal).toHaveBeenCalledWith('userTurn', 'check logs');
  });

  it('rejects an empty turn with 400', async () => {
    const getHandle = vi.fn();
    const res = await handleSendTurn(depsWith({ getHandle } as never), 'chat-1', jsonReq({ text: '' }));
    expect(res.status).toBe(400);
    expect(getHandle).not.toHaveBeenCalled();
  });

  it('forwards a decision as a signal', async () => {
    const signal = vi.fn().mockResolvedValue(undefined);
    const getHandle = vi.fn().mockReturnValue({ signal });
    const res = await handleDecision(depsWith({ getHandle } as never), 'chat-1', jsonReq({ proposalId: 'p-2', approve: true }));
    expect(res.status).toBe(202);
    expect(signal).toHaveBeenCalledWith('decision', { proposalId: 'p-2', approve: true });
  });

  it('returns the conversation state for a running chat', async () => {
    const query = vi.fn().mockResolvedValue({
      chatId: 'chat-1',
      phase: 'awaiting-user',
      messages: [{ seq: 1, role: 'user', text: 'hi' }],
    });
    const getHandle = vi.fn().mockReturnValue({ describe: async () => ({ status: { name: 'RUNNING' } }), query });
    const res = await handleGetChat(depsWith({ getHandle } as never), 'chat-1');
    expect(res.status).toBe(200);
    expect((res.body as { phase: string }).phase).toBe('awaiting-user');
  });

  it('returns a closed state when the workflow has completed', async () => {
    const getHandle = vi.fn().mockReturnValue({ describe: async () => ({ status: { name: 'COMPLETED' } }) });
    const res = await handleGetChat(depsWith({ getHandle } as never), 'chat-1');
    expect(res.status).toBe(200);
    expect((res.body as { phase: string }).phase).toBe('closed');
  });

  it('404s an unknown chat', async () => {
    const getHandle = vi.fn().mockReturnValue({
      describe: async () => {
        throw new Error('not found');
      },
    });
    const res = await handleGetChat(depsWith({ getHandle } as never), 'nope');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @agentops/control test -- chat-routes`
Expected: FAIL — `Cannot find module './chat-routes'`.

- [ ] **Step 3: Implement the chat routes**

```ts
// packages/control/src/chat-routes.ts
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { URL } from 'node:url';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import {
  ConversationStateSchema,
  DecisionRequestSchema,
  SendTurnRequestSchema,
  StartChatRequestSchema,
  StartChatResponseSchema,
  type ConversationState,
} from '@agentops/contracts';
import { platformChat } from '@agentops/workflows';
import type { ControlDeps } from './create-control-server';
import { listRunsByType, readJsonBody, type HandlerResponse } from './handler-util';

export async function handleStartChat(deps: ControlDeps, req: IncomingMessage): Promise<HandlerResponse> {
  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: 'invalid JSON body' } };
  }
  const parsed = StartChatRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues.map((i) => i.message).join('; ') } };
  }
  const { prompt, hintRepos } = parsed.data;
  const chatId = `platform-chat-${randomUUID()}`;
  try {
    const handle = await deps.client.workflow.start(platformChat, {
      taskQueue: deps.taskQueue,
      workflowId: chatId,
      args: [{ prompt, hintRepos }],
      memo: { prompt: prompt ?? '' },
    });
    return {
      status: 202,
      body: StartChatResponseSchema.parse({ chatId: handle.workflowId, runId: handle.firstExecutionRunId }),
    };
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) {
      return { status: 409, body: { error: `a chat with id "${chatId}" already exists` } };
    }
    throw err;
  }
}

export async function handleListChats(deps: ControlDeps, url: URL): Promise<HandlerResponse> {
  return listRunsByType(deps, url, 'platformChat');
}

export async function handleGetChat(deps: ControlDeps, chatId: string): Promise<HandlerResponse> {
  const handle = deps.client.workflow.getHandle<typeof platformChat>(chatId);
  let description;
  try {
    description = await handle.describe();
  } catch {
    return { status: 404, body: { error: `no chat found with id "${chatId}"` } };
  }
  if (description.status.name === 'RUNNING') {
    try {
      const state = ConversationStateSchema.parse(await handle.query('conversation'));
      return { status: 200, body: state };
    } catch {
      // Closed between describe() and query(), or an unexpected shape -- fall through.
    }
  }
  // Closed (or transiently unqueryable): report a closed state. The UI keeps its
  // last-polled transcript and just stops polling (design §7).
  const closed: ConversationState = { chatId, phase: 'closed', messages: [] };
  return { status: 200, body: closed };
}

export async function handleSendTurn(deps: ControlDeps, chatId: string, req: IncomingMessage): Promise<HandlerResponse> {
  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: 'invalid JSON body' } };
  }
  const parsed = SendTurnRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues.map((i) => i.message).join('; ') } };
  }
  const handle = deps.client.workflow.getHandle<typeof platformChat>(chatId);
  await handle.signal('userTurn', parsed.data.text);
  return { status: 202 };
}

export async function handleDecision(deps: ControlDeps, chatId: string, req: IncomingMessage): Promise<HandlerResponse> {
  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch {
    return { status: 400, body: { error: 'invalid JSON body' } };
  }
  const parsed = DecisionRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues.map((i) => i.message).join('; ') } };
  }
  const handle = deps.client.workflow.getHandle<typeof platformChat>(chatId);
  await handle.signal('decision', parsed.data);
  return { status: 202 };
}

export async function handleCloseChat(deps: ControlDeps, chatId: string): Promise<HandlerResponse> {
  const handle = deps.client.workflow.getHandle<typeof platformChat>(chatId);
  await handle.signal('close');
  return { status: 202 };
}
```

- [ ] **Step 4: Wire the routes + token gate into the dispatcher**

In `packages/control/src/create-control-server.ts`:

Add the import near the other route imports:

```ts
import {
  handleCloseChat,
  handleDecision,
  handleGetChat,
  handleListChats,
  handleSendTurn,
  handleStartChat,
} from './chat-routes';
```

Add this helper next to `authorizeProjectCrud` (it rejects when the token is unset, unlike `authorizeProjectCrud`, so chat is never accidentally open):

```ts
function authorizeControlToken(deps: ControlDeps, req: IncomingMessage): boolean {
  return Boolean(deps.projectCrudAuthToken) && req.headers['x-control-crud-token'] === deps.projectCrudAuthToken;
}
```

Inside `dispatch`, add this block *before* the closing `return undefined;` (and before the `/api/projects` block is fine — paths don't overlap):

```ts
  if (pathname === '/api/platform/chats' || pathname.startsWith('/api/platform/chats/')) {
    if (!authorizeControlToken(deps, req)) {
      return { status: 401, body: { error: 'unauthorized' } };
    }
    if (req.method === 'POST' && pathname === '/api/platform/chats') {
      return handleStartChat(deps, req);
    }
    if (req.method === 'GET' && pathname === '/api/platform/chats') {
      return handleListChats(deps, url);
    }
    const turnMatch = matchPath('/api/platform/chats/:chatId/turns', pathname);
    if (req.method === 'POST' && turnMatch) {
      return handleSendTurn(deps, turnMatch.params.chatId, req);
    }
    const decisionMatch = matchPath('/api/platform/chats/:chatId/decisions', pathname);
    if (req.method === 'POST' && decisionMatch) {
      return handleDecision(deps, decisionMatch.params.chatId, req);
    }
    const closeMatch = matchPath('/api/platform/chats/:chatId/close', pathname);
    if (req.method === 'POST' && closeMatch) {
      return handleCloseChat(deps, closeMatch.params.chatId);
    }
    const chatMatch = matchPath('/api/platform/chats/:chatId', pathname);
    if (req.method === 'GET' && chatMatch) {
      return handleGetChat(deps, chatMatch.params.chatId);
    }
  }
```

(Order matters: match the `/turns`, `/decisions`, `/close` sub-paths before the bare `:chatId` GET, since `matchPath` with a single `:param` also matches those longer paths' first segment otherwise.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @agentops/control test -- chat-routes`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/control/src/chat-routes.ts packages/control/src/chat-routes.test.ts packages/control/src/create-control-server.ts
git commit -m "feat(control): token-gated platform chat routes"
```

---

## Task 7: `ui` chat page

**Files:**
- Modify: `packages/ui/src/api.ts`
- Create: `packages/ui/src/pages/ChatPage.tsx`
- Create: `packages/ui/src/pages/ChatStartPage.tsx`
- Create: `packages/ui/src/chat.css`
- Modify: `packages/ui/src/App.tsx`

**Interfaces:**
- Consumes: chat contracts + schemas from `@agentops/contracts`; `crudHeaders`, `parseJsonResponse`, `parseEmptyResponse` (existing in `api.ts`); `StatusBadge` (existing component); `react-markdown` + `remark-gfm` (already deps).
- Produces (in `api.ts`): `startChat`, `getChat`, `sendChatTurn`, `sendChatDecision`, `closeChat`.

No automated tests — per repo convention (`ui` is verified in a browser). Step 5 is the manual verification.

- [ ] **Step 1: Add the API client functions**

Add to the `@agentops/contracts` import block at the top of `packages/ui/src/api.ts`:

```ts
  ConversationStateSchema,
  StartChatResponseSchema,
  type ConversationState,
  type StartChatRequest,
  type StartChatResponse,
```

Append these functions to `packages/ui/src/api.ts`:

```ts
// --- platform chat ---

export async function startChat(input: StartChatRequest): Promise<StartChatResponse> {
  const res = await fetch('/api/platform/chats', {
    method: 'POST',
    headers: crudHeaders(true),
    body: JSON.stringify(input),
  });
  return parseJsonResponse(res, StartChatResponseSchema);
}

export async function getChat(chatId: string): Promise<ConversationState> {
  const res = await fetch(`/api/platform/chats/${encodeURIComponent(chatId)}`, {
    headers: crudHeaders(false),
  });
  return parseJsonResponse(res, ConversationStateSchema);
}

export async function sendChatTurn(chatId: string, text: string): Promise<void> {
  const res = await fetch(`/api/platform/chats/${encodeURIComponent(chatId)}/turns`, {
    method: 'POST',
    headers: crudHeaders(true),
    body: JSON.stringify({ text }),
  });
  await parseEmptyResponse(res);
}

export async function sendChatDecision(
  chatId: string,
  decision: { proposalId: string; approve: boolean; note?: string },
): Promise<void> {
  const res = await fetch(`/api/platform/chats/${encodeURIComponent(chatId)}/decisions`, {
    method: 'POST',
    headers: crudHeaders(true),
    body: JSON.stringify(decision),
  });
  await parseEmptyResponse(res);
}

export async function closeChat(chatId: string): Promise<void> {
  const res = await fetch(`/api/platform/chats/${encodeURIComponent(chatId)}/close`, {
    method: 'POST',
    headers: crudHeaders(false),
  });
  await parseEmptyResponse(res);
}
```

- [ ] **Step 2: Create the chat styles**

```css
/* packages/ui/src/chat.css */
.chat-log { display: flex; flex-direction: column; gap: 0.75rem; margin: 1rem 0; }
.chat-msg { max-width: 80%; padding: 0.5rem 0.75rem; border-radius: 0.5rem; white-space: pre-wrap; }
.chat-msg.user { align-self: flex-end; background: #dbeafe; }
.chat-msg.agent { align-self: flex-start; background: #f3f4f6; }
.chat-msg.system { align-self: center; background: transparent; color: #6b7280; font-size: 0.85rem; font-style: italic; }
.chat-composer { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
.chat-composer textarea { flex: 1; min-height: 3rem; }
.chat-proposal { align-self: flex-start; border: 1px solid #f59e0b; border-radius: 0.5rem; padding: 0.75rem; background: #fffbeb; }
.chat-proposal .actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
.chat-thinking { color: #6b7280; font-style: italic; }
```

- [ ] **Step 3: Create `ChatPage`**

```tsx
// packages/ui/src/pages/ChatPage.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import { useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ConversationState } from '@agentops/contracts';
import { closeChat, getChat, sendChatDecision, sendChatTurn } from '../api';
import '../chat.css';

const POLL_INTERVAL_MS = 2500;
const MARKDOWN_COMPONENTS = {
  a: (props: ComponentPropsWithoutRef<'a'>) => <a {...props} target="_blank" rel="noreferrer" />,
};

export function ChatPage() {
  const { chatId } = useParams<{ chatId: string }>();
  const [state, setState] = useState<ConversationState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!chatId) return undefined;
    let cancelled = false;
    async function poll() {
      try {
        const next = await getChat(chatId!);
        if (cancelled) return;
        setError(null);
        // Never overwrite a non-empty transcript with an empty closed payload.
        setState((prev) =>
          next.phase === 'closed' && prev && prev.messages.length > next.messages.length
            ? { ...prev, phase: 'closed', pendingProposal: undefined }
            : next,
        );
        if (next.phase === 'closed') stop();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'failed to load chat');
      }
    }
    void poll();
    intervalRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      stop();
    };
  }, [chatId, stop]);

  async function submitTurn() {
    if (!chatId || !draft.trim() || busy) return;
    setBusy(true);
    try {
      await sendChatTurn(chatId, draft.trim());
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to send');
    } finally {
      setBusy(false);
    }
  }

  async function decide(approve: boolean) {
    if (!chatId || !state?.pendingProposal || busy) return;
    setBusy(true);
    try {
      await sendChatDecision(chatId, { proposalId: state.pendingProposal.id, approve });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to send decision');
    } finally {
      setBusy(false);
    }
  }

  if (!state) {
    return (
      <div className="page">
        <a href="/chat" className="back-link">← Back</a>
        {error ? <p className="error-text">{error}</p> : <p>Loading…</p>}
      </div>
    );
  }

  const closed = state.phase === 'closed';
  return (
    <div className="page">
      <a href="/chat" className="back-link">← Back</a>
      <div className="run-header">
        <span className="run-id">{state.chatId}</span>
        <span>{state.phase}</span>
        {!closed && (
          <button type="button" onClick={() => chatId && void closeChat(chatId)}>
            End chat
          </button>
        )}
      </div>
      {error && <p className="error-text">{error}</p>}

      <div className="chat-log">
        {state.messages.map((m) => (
          <div key={m.seq} className={`chat-msg ${m.role}`}>
            {m.role === 'agent' ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                {m.text}
              </ReactMarkdown>
            ) : (
              m.text
            )}
          </div>
        ))}
        {state.phase === 'agent-thinking' && <div className="chat-thinking">agent is working…</div>}
        {state.pendingProposal && (
          <div className="chat-proposal">
            <strong>Proposed: {state.pendingProposal.type}</strong>
            <div>{state.pendingProposal.reason}</div>
            {state.pendingProposal.workflowId && <div>workflow: {state.pendingProposal.workflowId}</div>}
            {state.pendingProposal.repo && <div>repo: {state.pendingProposal.repo}</div>}
            <div className="actions">
              <button type="button" disabled={busy} onClick={() => void decide(true)}>Approve</button>
              <button type="button" disabled={busy} onClick={() => void decide(false)}>Reject</button>
            </div>
          </div>
        )}
      </div>

      {!closed && !state.pendingProposal && (
        <div className="chat-composer">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={state.phase === 'awaiting-answer' ? 'Answer the agent…' : 'Message the agent…'}
          />
          <button type="button" disabled={busy || !draft.trim()} onClick={() => void submitTurn()}>
            Send
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Create `ChatStartPage` and wire routes/nav**

```tsx
// packages/ui/src/pages/ChatStartPage.tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { startChat } from '../api';

export function ChatStartPage() {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function start() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { chatId } = await startChat({ prompt: prompt.trim() || undefined });
      navigate(`/chats/${encodeURIComponent(chatId)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to start chat');
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <h1>Chat with the platform agent</h1>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Optional: start with a question or task…"
        style={{ width: '100%', minHeight: '4rem' }}
      />
      {error && <p className="error-text">{error}</p>}
      <button type="button" disabled={busy} onClick={() => void start()}>
        {busy ? 'Starting…' : 'Start chat'}
      </button>
    </div>
  );
}
```

In `packages/ui/src/App.tsx`, add the imports, a nav link, and two routes:

```tsx
import { ChatPage } from './pages/ChatPage';
import { ChatStartPage } from './pages/ChatStartPage';
```

```tsx
        <Link to="/chat">Chat</Link>
```

```tsx
        <Route path="/chat" element={<ChatStartPage />} />
        <Route path="/chats/:chatId" element={<ChatPage />} />
```

- [ ] **Step 5: Verify in a browser (repo convention — required, not optional)**

```bash
temporal server start-dev &                      # local Temporal
pnpm --filter @agentops/worker dev &             # stub backend, zero token spend
CONTROL_CRUD_TOKEN=dev pnpm --filter @agentops/control dev &
pnpm --filter @agentops/ui dev
```

In the browser: open the app, set the CRUD token to `dev` (the Projects/Agents page has the token field that writes `localStorage['agentops.controlCrudToken']`), click **Chat**, start a chat with a prompt, confirm the agent replies, that a proposal (if the stub emits one) shows Approve/Reject, and that ending the chat stops polling. Confirm the browser console has no errors.

- [ ] **Step 6: Lint/typecheck and commit**

Run: `pnpm --filter @agentops/ui lint && pnpm --filter @agentops/ui typecheck`
Expected: PASS.

```bash
git add packages/ui/src/api.ts packages/ui/src/pages/ChatPage.tsx packages/ui/src/pages/ChatStartPage.tsx packages/ui/src/chat.css packages/ui/src/App.tsx
git commit -m "feat(ui): platform chat page"
```

---

## Task 8: Stub-backend e2e

**Files:**
- Create: `e2e/platform-chat.e2e.test.ts`

**Interfaces:**
- Consumes: the e2e harness in `e2e/helpers.ts` (mirror `e2e/`'s existing platform test — find it with `ls e2e/` and copy its worker/client bootstrap). Uses the `stub` backend (zero token spend).

- [ ] **Step 1: Locate the existing e2e pattern**

Run: `ls e2e/ && sed -n '1,60p' e2e/helpers.ts`
Read how an existing test (e.g. the `platform` or `devCycle` e2e) starts a worker with a `stub` backend and a Temporal test client. Mirror that bootstrap exactly.

- [ ] **Step 2: Write the e2e test**

```ts
// e2e/platform-chat.e2e.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Import the SAME harness helpers the existing e2e tests use (see Step 1):
// e.g. startTestWorker(), makeClient(), STUB_TASK_QUEUE.
import { conversationQuery, decisionSignal, platformChat } from '@agentops/workflows';
// ...harness imports from './helpers'

describe('platformChat e2e (stub backend)', () => {
  // beforeAll/afterAll: start the stub-backed worker + client exactly as the
  // existing platform e2e does. The stub backend must be configured to emit a
  // canned CHAT_TURN with a `fix` proposal on the first turn and a done reply
  // on the second (mirror how the existing platform e2e seeds the stub's
  // canned PLATFORM_RESULT output).

  it('drives a child devCycle when the operator approves a fix', async () => {
    const handle = await /* client */.workflow.start(platformChat, {
      taskQueue: /* STUB_TASK_QUEUE */ '',
      workflowId: 'e2e-chat-1',
      args: [{ prompt: 'fix the flaky test in acme/webapp' }],
    });
    // wait for the proposal
    let state = await handle.query(conversationQuery);
    // (poll a few times if needed until phase === 'awaiting-approval')
    expect(state.phase).toBe('awaiting-approval');
    expect(state.pendingProposal?.type).toBe('fix');
    await handle.signal(decisionSignal, { proposalId: state.pendingProposal!.id, approve: true });
    const result = await handle.result();
    expect(result.childWorkflows).toHaveLength(1);
    expect(result.childWorkflows[0].repo).toBe('acme/webapp');
  });
});
```

Fill in the harness-specific bootstrap from Step 1 (the `//` placeholders). Register `acme/webapp` in the test registry so `resolveRepoConfig` returns `registered: true` (mirror the existing platform e2e's fixture registry — it already uses `acme`/`webapp`).

- [ ] **Step 3: Run the e2e**

Run: `pnpm e2e -- platform-chat`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add e2e/platform-chat.e2e.test.ts
git commit -m "test(e2e): platform chat drives a child devCycle on approve"
```

---

## Final verification

- [ ] **Whole-repo green**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e`
Expected: all PASS.

- [ ] **Confirm no chart change is needed**

This feature reuses the existing `control` deployment and worker (`platformChat` auto-registers via the workflows package export; `control` gains routes only). No `charts/engine` change and no new image/tag. If `pnpm test` surfaces a golden-file diff, something unintended changed — investigate before proceeding.

---

## Self-Review notes (author)

- **Spec coverage:** §3 → Task 1; §4 loop/continueAsNew/idle → Task 4; §5 executePlatformAction/gate → Tasks 3-4; §6 routes+auth → Task 6; §7 UI+prompt → Tasks 5,7; §9 errors → Tasks 4 (unparseable/failed-action) + 6 (400/404/409); §10 testing → Tasks 1-3,6,8 + manual §7; §11 deploy (no change) → Final verification.
- **Read-only credential hardening (spec §5/§12):** intentionally **not** a task here — it is `agentops-platform` work; v1 enforces the gate at the workflow boundary.
- **Type consistency:** signal names are the string literals `'userTurn'`/`'decision'`/`'close'` and the query name `'conversation'` in both the workflow (Task 4) and control (Task 6); proposal ids are `p-${seq}` in Task 4 and echoed verbatim by the UI/decision path.
