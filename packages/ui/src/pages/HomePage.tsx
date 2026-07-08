import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { RunListItem } from '@agentops/contracts';
import { listRepos, listRuns, startRun } from '../api';
import { StatusBadge } from '../components/StatusBadge';

const SUGGESTED_PROMPTS = [
  'Check recent failed workflows — anything strange?',
  'Investigate the last workflow failures and propose fixes',
  'Check cluster pod health in dev-agents',
];

export function HomePage() {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState('');
  const [hintReposText, setHintReposText] = useState('');
  const [repoSuggestions, setRepoSuggestions] = useState<string[]>([]);
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRepos()
      .then(setRepoSuggestions)
      .catch(() => setRepoSuggestions([]));
    listRuns()
      .then(setRuns)
      .catch(() => setRuns([]));
  }, []);

  const canSubmit = prompt.trim().length > 0 && !submitting;

  async function handleRun() {
    setSubmitting(true);
    setError(null);
    try {
      const hintRepos = hintReposText
        .split(',')
        .map((repo) => repo.trim())
        .filter(Boolean);
      const { workflowId } = await startRun({
        prompt: prompt.trim(),
        hintRepos: hintRepos.length > 0 ? hintRepos : undefined,
      });
      navigate(`/runs/${workflowId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to start run');
      setSubmitting(false);
    }
  }

  return (
    <div className="page">
      <h1>Platform Console</h1>

      <label className="field-label" htmlFor="prompt">
        What should the platform agent investigate?
      </label>
      <textarea
        id="prompt"
        className="prompt-input"
        rows={4}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />

      <div className="chip-row">
        {SUGGESTED_PROMPTS.map((suggestion) => (
          <button key={suggestion} type="button" className="chip" onClick={() => setPrompt(suggestion)}>
            {suggestion}
          </button>
        ))}
      </div>

      <label className="field-label" htmlFor="hint-repos">
        Hint repos (optional)
      </label>
      <input
        id="hint-repos"
        className="text-input"
        placeholder="owner/repo, owner/repo2"
        value={hintReposText}
        onChange={(event) => setHintReposText(event.target.value)}
        list="repo-suggestions"
      />
      <datalist id="repo-suggestions">
        {repoSuggestions.map((repo) => (
          <option key={repo} value={repo} />
        ))}
      </datalist>

      <div className="actions">
        <button type="button" className="run-button" disabled={!canSubmit} onClick={handleRun}>
          {submitting ? 'Starting…' : 'Run'}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}

      <h2>Recent runs</h2>
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Prompt</th>
            <th>Started</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.workflowId}>
              <td>
                <StatusBadge status={run.status} />
              </td>
              <td>{run.promptSnippet ?? run.workflowId}</td>
              <td>{new Date(run.startTime).toLocaleString()}</td>
              <td>
                <Link to={`/runs/${run.workflowId}`}>Open</Link>
              </td>
            </tr>
          ))}
          {runs.length === 0 && (
            <tr>
              <td colSpan={4}>No runs yet.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
