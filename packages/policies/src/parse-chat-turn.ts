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