import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { startChat } from '../api';
import { PageShell } from '../components/PageShell';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

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
    <PageShell>
      <h1 className="mb-6 text-2xl font-semibold">Chat with the platform agent</h1>
      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Optional: start with a question or task…"
        className="min-h-24"
      />
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      <Button type="button" className="mt-4" disabled={busy} onClick={() => void start()}>
        {busy ? 'Starting…' : 'Start chat'}
      </Button>
    </PageShell>
  );
}