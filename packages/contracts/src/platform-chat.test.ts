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
      pending: {
        kind: 'proposal',
        proposal: { type: 'terminate', workflowId: 'wf-1', reason: 'stuck 3h' },
      },
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
      pendingProposal: {
        id: 'p-2',
        type: 'signal',
        workflowId: 'wf-1',
        signalName: 'resume',
        reason: 'unblock',
      },
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
      ExecutePlatformActionRequestSchema.parse({
        type: 'terminate',
        workflowId: 'wf-1',
        reason: '',
      }),
    ).toThrow();
    expect(PlatformChatInputSchema.parse({}).prompt).toBeUndefined();
  });
});
