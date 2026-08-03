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
    const out =
      'CHAT_TURN: {"message":"Terminate it?","pending":{"kind":"proposal","proposal":{"type":"terminate","workflowId":"wf-1","reason":"stuck"}}}';
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
