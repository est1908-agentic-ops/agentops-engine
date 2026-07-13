# Platform chat (`platformChat` workflow) — design

Status: draft v1 · 2026-07-13 · Owner: Artem

## 1. What this is

A new Temporal workflow, registered under workflow type **`platformChat`** (sibling to the existing one-shot `platform`), plus Control UI + BFF surface, that lets an operator hold a **multi-turn, human-in-the-loop conversation** with the platform agent — the demo-style interaction of `temporal-community/temporal-ai-agent`, applied to this repo's platform-ops agent.

The conversation is **bidirectional**: the agent does not just answer, it drives — it asks clarifying questions, proposes tools/actions with their arguments, and waits for a human response before acting. The workflow holds the transcript; each agent turn is a fresh, read-only `runAgent` Job fed the accumulated thread (continuity is transcript-replay, not a live session — the same model the Temporal demo uses).

**Interaction rules (decided in brainstorming):**
- **Read-only investigation runs autonomously within a turn** (Temporal describe/history, Grafana/Loki, Prometheus, read-only kubectl, reading repo clones).
- **Mutating actions are gated.** The agent may not execute terminate/signal/fix directly; it emits a *proposal*, and the workflow executes it only after explicit human approval in the chat.
- **The agent may ask clarifying questions at any time**, pausing the conversation until answered.

**What an operator can do:**
1. Start a chat with an optional first prompt, then converse turn by turn.
2. Answer the agent's clarifying questions.
3. Approve or reject each proposed mutating action (terminate a workflow, signal a workflow, or open a fix PR via a child `devCycle`), with an optional note.
4. Watch each turn's result and read the running transcript, then close the chat when done.

This is **Feature A** of a three-part effort brainstormed together. **Feature B** (self-heal: a scheduled trigger that drives the platform agent on a 30-minute cadence to fix recent failures) and **Feature C** (autonomous auto-merge gated by a Vision/Architecture document) are separate, later specs. A is shippable independently of both and carries no autonomous-action risk.

## 2. Relationship to existing architecture

This is a thin new orchestration wrapper over already-built internals, not a fork:

- **Reuses the existing `platform` agent's internals entirely** — the `runAgent` activity, the toolbelt/skill content, the RBAC/NetworkPolicy role, and the model/backend routing tier (see `docs/superpowers/specs/2026-07-07-platform-agent-design.md`). The chat workflow adds only the interactive lifecycle (transcript state, turn/decision signals, conversation query, `continueAsNew`, idle timeout) on top.
- **Leaves the one-shot `platform` workflow byte-for-byte unchanged** (`packages/workflows/src/platform.ts`). Its callers — today's Control UI "start a run" flow and the future self-heal trigger (Feature B) — keep working with zero regression. This is why a **new workflow type** was chosen over converting `platform` into an interactive one (Approach 1 in brainstorming): one-shot semantics stay simple and battle-tested; the chat prompt/output format diverges freely from `platform`'s `PLATFORM_RESULT:` sentinel.
- **Copies `devCycle`'s interactive pattern** — `devCycle` is already a long-running interactive workflow (`packages/workflows/src/dev-cycle.ts:34-38, 117`): `defineSignal` (`stop`/`cancel`/`clarify`/`resume`), a `stateQuery`, and `condition()` to block/resume between turns. `devCycle`'s `clarifySignal` is currently a stubbed escape hatch (`dev-cycle.ts:99-103`) that stores nothing — this design realizes the same "push a message into a running workflow" idea as a first-class conversation channel.
- **Fixes still converge on `devCycle`.** When a proposal is a code fix, the chat workflow starts a child `devCycle` (`executeChild`), inheriting `implement → full_verify → review → pr → pr_babysit` — the same rule the platform-agent spec follows. The chat workflow never writes code or pushes.
- **First slice's console packages already exist.** `packages/control` (BFF) and `packages/ui` (React SPA) were built by the platform-console slice (`docs/superpowers/specs/2026-07-07-platform-console-design.md`). This feature adds routes to `control` and a page to `ui`; both packages listed multi-turn chat as future work, so this is the deferred follow-on, not a deviation.

## 3. Contracts (`packages/contracts/src/platform-chat.ts`)

New file, distinct from `platform-agent.ts` (which is single-shot request/result) and `control-api.ts`.

```ts
export const ChatRoleSchema = z.enum(['user', 'agent', 'system']);

export const ChatMessageSchema = z.object({
  seq: z.number().int().nonnegative(), // deterministic ordering — a workflow-side counter, never Date.now()/random
  role: ChatRoleSchema,
  text: z.string(),
  kind: z.enum(['reply', 'question', 'proposal', 'decision', 'action-result', 'error']).optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ActionProposalSchema = z.object({
  id: z.string(),                 // workflow-assigned, derived from seq (deterministic)
  type: z.enum(['terminate', 'signal', 'fix']),
  workflowId: z.string().optional(), // for terminate/signal
  signalName: z.string().optional(), // for signal
  repo: z.string().optional(),       // for fix
  goal: z.string().optional(),       // for fix
  reason: z.string(),
});
export type ActionProposal = z.infer<typeof ActionProposalSchema>;

// What the agent emits each turn (parsed from a sentinel line, see below).
export const AgentTurnSchema = z.object({
  message: z.string(),            // markdown shown in the transcript
  pending: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('question') }),
    z.object({ kind: z.literal('proposal'), proposal: ActionProposalSchema.omit({ id: true }) }),
  ]).optional(),
  done: z.boolean().default(false), // agent considers the task complete
});
export type AgentTurn = z.infer<typeof AgentTurnSchema>;

export const ChatPhaseSchema = z.enum([
  'awaiting-user',     // idle, waiting for the next human turn
  'agent-thinking',    // a runAgent turn is in flight
  'awaiting-answer',   // agent asked a question, waiting for the human
  'awaiting-approval', // agent proposed an action, waiting for approve/reject
  'closed',
]);

export const ConversationStateSchema = z.object({
  chatId: z.string(),
  phase: ChatPhaseSchema,
  messages: z.array(ChatMessageSchema),
  pendingProposal: ActionProposalSchema.optional(), // present iff phase === 'awaiting-approval'
});
export type ConversationState = z.infer<typeof ConversationStateSchema>;

export const PlatformChatInputSchema = z.object({
  prompt: z.string().optional(),   // optional first user turn
  hintRepos: z.array(z.string()).optional(),
});
export type PlatformChatInput = z.infer<typeof PlatformChatInputSchema>;

// Returned when the chat closes — for audit in Temporal's UI; the live transcript is served from the query.
export const PlatformChatResultSchema = z.object({
  turns: z.number().int().nonnegative(),
  actionsExecuted: z.array(z.object({
    type: z.enum(['terminate', 'signal']),
    workflowId: z.string(),
    reason: z.string(),
  })).default([]),
  childWorkflows: z.array(z.object({
    workflowId: z.string(),
    repo: z.string(),
    goal: z.string(),
  })).default([]),
});
export type PlatformChatResult = z.infer<typeof PlatformChatResultSchema>;
```

The agent's structured turn is emitted as a single sentinel-delimited line (`CHAT_TURN: {json}`), parsed by a new pure function in `packages/policies` (mirroring `parsePlatformResult`), validated against `AgentTurnSchema`. Proposal `id`s are assigned workflow-side from the message `seq` so they are deterministic.

## 4. Workflow orchestration flow (`packages/workflows/src/platform-chat.ts`, function `platformChat`)

State held in the workflow (all deterministic — no I/O, no `Date.now()`, no random):

```ts
let messages: ChatMessage[] = [];
let seq = 0;
let phase: ChatPhase = 'awaiting-user';
let pendingUserInput: string | undefined;    // set by userTurn signal
let pendingDecision: Decision | undefined;    // set by decision signal
let pendingProposal: ActionProposal | undefined;
let closed = false;
```

Signals / query (names mirror the `devCycle` convention):
- `defineSignal<[string]>('userTurn')` — a human message, or the answer to a `question`.
- `defineSignal<[Decision]>('decision')` — `{ proposalId, approve: boolean, note?: string }`, a response to a `proposal`.
- `defineSignal<[]>('close')` — end the conversation.
- `defineQuery<ConversationState>('conversation')` — the full state the UI renders.

Loop:
1. If `input.prompt` is set, seed it as the first `userTurn`.
2. `await condition(() => pendingUserInput !== undefined || pendingDecision !== undefined || closed, IDLE_TIMEOUT_MS)`.
   - Returns `false` on timeout → treat as `close` (auto-close abandoned chats).
   - `closed` → assemble and return the final result (§below), exit.
3. Assemble the transcript (messages + the just-received answer/decision), set `phase = 'agent-thinking'`, and call the `runAgent` activity with role `platformChat` (§5), the rendered chat prompt (§7 prompts), and `hintRepos` as context.
4. Parse the agent's `CHAT_TURN:` line → append an `agent`/`reply` message. Then:
   - **no `pending`** → `phase = 'awaiting-user'` (or exit if `done`), loop.
   - **`pending.kind === 'question'`** → `phase = 'awaiting-answer'`, loop (blocks on next `userTurn`).
   - **`pending.kind === 'proposal'`** → assign `pendingProposal` (id from `seq`), `phase = 'awaiting-approval'`, loop (blocks on `decision`).
5. On a `decision`:
   - **reject** → append a `system`/`decision` message with the note; feed it back as the next turn (agent reacts).
   - **approve** → execute the proposal:
     - `terminate` / `signal` → call the new `executePlatformAction` activity (§5), which holds the write creds.
     - `fix` → `executeChild(devCycle, taskInput)` (native SDK call, inside the determinism boundary; `taskInput` built by loading the repo's `ProductConfig` via the existing `load-product-config` helper, exactly as `platform.ts` does).
   - Append an `action-result` `system` message with the outcome, then feed it back as the next turn.
6. **History bounding:** when `messages.length` (or an estimated token size) crosses `CONTINUE_AS_NEW_THRESHOLD`, `continueAsNew` carrying a summarized head + the recent tail, so token growth and Temporal history size stay bounded across long chats.

**Final result** (returned when the chat closes) is a small `PlatformChatResult` — `{ turns: number, actionsExecuted: PlatformAction[], childWorkflows: {workflowId, repo, goal}[] }` — for auditability in Temporal's UI; the live transcript is served from the query while running.

## 5. Credentials & mutation-gate enforcement

The gate is enforced at the **workflow boundary**: the agent's turn *proposes* a mutation, and only an approved proposal is executed — by the workflow, never by the agent Job.

- **Approved terminate/signal are executed workflow-side** via a new activity `executePlatformAction({ type, workflowId, signalName?, reason })`, using the worker's already-wired Temporal `workflowClient` (`ActivityDependencies.workflowClient`, `packages/activities/src/create-activities.ts:60`) whose `getHandle` already exposes `terminate` (this design adds `signal`). Called only after an `approve` decision.
- **Approved fixes never touch this workflow's creds** — they run as a child `devCycle`, which uses that repo's own already-provisioned registry token to push and open a PR. The chat workflow never pushes.
- **The chat prompt instructs the agent to emit proposals, not execute** mutations, and the `CHAT_TURN:` output format has no "execute" verb — the only mutation path the agent has is a proposal the human must approve.

**v1 reuses the existing `platform` backend** (`tier: 'platform'`) for chat turns, so no new routing/RBAC is required to ship. The residual gap — a misbehaving or prompt-injected agent Job could still self-execute terminate/signal using the `platform` role's inherited Temporal write creds — is closed by the **read-only chat credential profile** hardening (a dedicated `platformChat` backend whose Job gets only the read subset), which is `agentops-platform`-side work tracked in §12. Once that lands, chat turns switch to `tier: 'platformChat'` (a one-line change) and the gate becomes capability-enforced as well as boundary-enforced.

## 6. Control BFF (`packages/control`)

New routes, added to the dispatch table in `packages/control/src/create-control-server.ts`, one handler file per route, following the existing gateway/control zero-framework style. **All chat routes are gated by `CONTROL_CRUD_TOKEN`** via `authorizeProjectCrud`'s `X-Control-Crud-Token` mechanism (`create-control-server.ts:137-142`) — a chat surface is far more invocable than the one-shot form, so auth is non-optional.

| Route | Behavior |
|---|---|
| `POST /api/platform/chats` | Validate `PlatformChatInput`. `chatId = \`platform-chat-${randomUUID()}\``. `client.workflow.start(platformChat, { taskQueue, workflowId: chatId, args:[input], memo:{ prompt } })`. 202 `{ chatId, runId }`. 409 on already-started. |
| `GET /api/platform/chats` | `client.workflow.list({ query: 'WorkflowType="platformChat" ORDER BY StartTime DESC' })` → list items (status + `promptSnippet` from memo), same shape/mapping as the existing runs list. |
| `GET /api/platform/chats/:chatId` | `handle.query('conversation')` → `ConversationState` (validated). 404 on unknown; if the workflow has closed, fall back to `handle.result()` for the final summary. **This is what the UI polls.** |
| `POST /api/platform/chats/:chatId/turns` | Body `{ text }` → `handle.signal('userTurn', text)`. 202. |
| `POST /api/platform/chats/:chatId/decisions` | Body `{ proposalId, approve, note? }` → `handle.signal('decision', …)`. 202. |
| `POST /api/platform/chats/:chatId/close` | `handle.signal('close')`. 202. |

Error convention matches the existing `control` JSON `{ "error": "…" }` shape. **Note (flagged, not fixed here):** `POST /api/platform/runs` is currently unauthenticated at the app layer; tightening it is out of scope for this spec.

## 7. UI (`packages/ui`) and prompts

**UI** — new `ChatPage` at route `/chats/:chatId`, plus a "Chat" entry point on `HomePage` (a button that `POST`s a new chat and navigates to it; an optional first prompt reuses the existing prompt textarea).
- Transcript of message bubbles (user right / agent left / system inline), agent messages rendered through the existing `react-markdown` + `remark-gfm`.
- A composer textarea (send → `POST …/turns`); when `phase === 'awaiting-answer'` the composer is the answer.
- When `phase === 'awaiting-approval'`, an inline **approve/reject card** showing the `pendingProposal` (type, target, reason) + an optional note field → `POST …/decisions`.
- An "agent is working…" indicator while `phase === 'agent-thinking'`.
- **Polls** `GET /api/platform/chats/:chatId` every ~2–3s (reusing `RunDetailPage`'s `setInterval` approach, `RunDetailPage.tsx:10`), stopping when `phase === 'closed'`. Token-level streaming is a non-goal for v1 — a turn is a whole Job run, not a token stream.
- Flat CSS, no new dependencies (`react-markdown` already present).

**Prompts** — new pack `packages/prompts/platform-chat/` (versioned, per convention): a conversational system framing that (a) states the agent is in a multi-turn chat, (b) reproduces the platform toolbelt/skill content, (c) instructs it to run only read-only tools directly and to emit any mutation as a proposal, (d) specifies the `CHAT_TURN: {json}` output format matching `AgentTurnSchema`, and (e) tells it to ask clarifying questions when under-specified rather than guessing.

## 8. Safety and budgets

- **Read-only chat Jobs** (§5) — the primary guardrail; the agent cannot mutate.
- **Human approval** required for every mutating action; PRs additionally get `devCycle`'s full CI/review/babysit gate.
- **Brakes** — reuse `packages/policies` brake mechanisms: a per-turn `maxTokens`/`maxIterations` budget and a per-chat cumulative budget; on breach the turn ends with a surfaced error message and the chat stays open.
- **Idle timeout** (§4) auto-closes abandoned chats so interactive workflows don't dangle.
- **`continueAsNew`** bounds history/token growth on long chats.
- **Auth** on all chat routes (§6).

## 9. Error handling

- **Unparseable `CHAT_TURN:` output** → bounded retry (like `platform.ts`'s `MAX_RESULT_CALLS`), then append an `error` `system` message; the chat stays alive so the operator can retry or rephrase.
- **`runAgent` activity failure** → Temporal retries per the activity's retry policy; a non-retryable/terminal failure surfaces as an `error` message rather than killing the workflow.
- **Approved action fails** (`executePlatformAction` throws, or a child `devCycle` fails to start) → append an `action-result` message describing the failure; the agent reacts on the next turn.
- **BFF:** unknown/closed chat → 404/409; body validation failure → 400.

## 10. Testing

Per AGENTS.md's definition of done (`pnpm lint && pnpm typecheck && pnpm test`; `pnpm e2e` for workflow/policy/activity/backend changes):

- **`packages/contracts`** — schema tests for `platform-chat.ts` (same style as `platform-agent.test.ts`).
- **`packages/policies`** — unit tests for the `CHAT_TURN:` parser (valid reply/question/proposal, malformed input, exhaustive).
- **`packages/workflows`** — `TestWorkflowEnvironment` tests mocking `runAgent`: reply → `phase` returns to `awaiting-user`; question → blocks until `userTurn`; proposal + `approve` → `executePlatformAction`/`executeChild` called with the right args; proposal + `reject` → not called, rejection fed back; idle timeout → workflow closes; `continueAsNew` fires past the threshold.
- **`stub`-backend e2e** — a scripted chat: first turn returns a `reply`, second returns a `proposal`, an `approve` signal drives a child `devCycle` start (asserted), matching `platform`'s zero-token-spend e2e pattern.
- **`packages/control`** — handler unit tests with a fake `Client` (start/list/query/signal): auth enforced (401 without token), start returns `{chatId,runId}`, query maps to `ConversationState`, signals dispatched with correct args, 404/409 paths.
- **`packages/ui`** — no automated tests; verified in a browser on the stub backend (start a chat, answer a question, approve a proposal, watch it complete), per this repo's frontend-verification convention.
- **Helm** — golden-file test (`charts/engine/tests/render.golden.yaml`) for any new `platformChat` read-only RBAC/role resources.

## 11. Helm / deploy

- Reuses the existing `control` Deployment/Service/Ingress (this feature only adds routes to the same server) and the same worker (the `platformChat` workflow registers alongside `platform`/`devCycle` on the existing task queue).
- New chart resources only for the **read-only chat role** (ServiceAccount + scoped tokens/kubeconfig per §5), golden-file tested.
- No new image or tag-bump line — `control` and the worker images are unchanged in structure.

## 12. Preconditions (tracked, not built here)

- **Read-only chat credential profile** (`agentops-platform`, hardening — see §5): a dedicated `platformChat` backend whose Job gets only the read subset (Temporal describe/history/list, Grafana, read-only kubeconfig, read-only forge tokens) and *no* terminate/signal write creds. Not required to ship v1 (which reuses the `platform` backend and enforces the gate at the workflow boundary); it upgrades the gate to capability-enforced. When it lands, chat turns switch to `tier: 'platformChat'`.
- **Temporal + Control auth** (`agentops-platform`): the existing Traefik-level auth in front of the Control UI/Temporal host — `platformChat` is at least as powerful as `platform`, so the same precondition applies.

*(No new write-action creds precondition: `executePlatformAction` uses the worker's already-wired Temporal `workflowClient`, which the worker constructs today for Schedule/reconcile ops — `packages/worker/src/main.ts:422-427, 461`.)*

## 13. Non-goals (v1)

- Token-level streaming of a turn (polling only).
- Feature B — self-heal's scheduled 30-minute trigger driving the platform agent (separate spec).
- Feature C — autonomous auto-merge gated by a Vision/Architecture document (separate spec).
- Chatting with `devCycle` (this is the platform agent only).
- Tightening `POST /api/platform/runs` auth (flagged in §6, out of scope).
