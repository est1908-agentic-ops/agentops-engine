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