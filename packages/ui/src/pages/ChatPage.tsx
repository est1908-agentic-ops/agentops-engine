import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import { useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ConversationState } from '@agentops/contracts';
import { closeChat, getChat, sendChatDecision, sendChatTurn } from '../api';
import { PageShell } from '../components/PageShell';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';

const POLL_INTERVAL_MS = 2500;
const MARKDOWN_COMPONENTS = {
  a: (props: ComponentPropsWithoutRef<'a'>) => <a {...props} target="_blank" rel="noreferrer" />,
};

const BUBBLE_STYLES: Record<ConversationState['messages'][number]['role'], string> = {
  user: 'self-end bg-blue-100',
  agent: 'self-start bg-muted',
  system: 'self-center bg-transparent text-sm italic text-muted-foreground',
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
      <PageShell>
        <a href="/chat" className="text-sm text-muted-foreground">
          ← Back
        </a>
        {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : <p className="mt-2">Loading…</p>}
      </PageShell>
    );
  }

  const closed = state.phase === 'closed';
  return (
    <PageShell>
      <a href="/chat" className="text-sm text-muted-foreground">
        ← Back
      </a>
      <div className="mb-2 mt-3 flex items-center gap-3">
        <span className="font-mono text-sm text-muted-foreground">{state.chatId}</span>
        <span className="text-sm">{state.phase}</span>
        {!closed && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => chatId && void closeChat(chatId)}>
            End chat
          </Button>
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="my-4 flex flex-col gap-3">
        {state.messages.map((m) => (
          <div key={m.seq} className={`max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 ${BUBBLE_STYLES[m.role]}`}>
            {m.role === 'agent' ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                {m.text}
              </ReactMarkdown>
            ) : (
              m.text
            )}
          </div>
        ))}
        {state.phase === 'agent-thinking' && <div className="italic text-muted-foreground">agent is working…</div>}
        {state.pendingProposal && (
          <Card className="self-start border-amber-500 bg-amber-50">
            <CardContent className="pt-4">
              <p className="font-semibold">Proposed: {state.pendingProposal.type}</p>
              <p>{state.pendingProposal.reason}</p>
              {state.pendingProposal.workflowId && <p>workflow: {state.pendingProposal.workflowId}</p>}
              {state.pendingProposal.repo && <p>repo: {state.pendingProposal.repo}</p>}
              <div className="mt-2 flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => void decide(true)}>
                  Approve
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide(false)}>
                  Reject
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {!closed && !state.pendingProposal && (
        <div className="mt-2 flex gap-2">
          <Textarea
            className="min-h-12"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={state.phase === 'awaiting-answer' ? 'Answer the agent…' : 'Message the agent…'}
          />
          <Button disabled={busy || !draft.trim()} onClick={() => void submitTurn()}>
            Send
          </Button>
        </div>
      )}
    </PageShell>
  );
}