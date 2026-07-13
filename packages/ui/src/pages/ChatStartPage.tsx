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