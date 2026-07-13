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