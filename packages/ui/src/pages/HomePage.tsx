import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { DevCycleTarget, RunListItem } from '@agentops/contracts';
import { listDevCycleRuns, listDevCycleTargets, listRepos, listRuns, startDevCycleRun, startRun } from '../api';
import { StatusBadge } from '../components/StatusBadge';

const SUGGESTED_PROMPTS = [
  'Check recent failed workflows — anything strange?',
  'Investigate the last workflow failures and propose fixes',
  'Check cluster pod health in dev-agents',
];

const PLATFORM_TARGET = 'platform';

interface ConsoleRun {
  kind: 'platform' | 'devcycle';
  run: RunListItem;
}

export function HomePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [prompt, setPrompt] = useState('');
  const [target, setTarget] = useState(PLATFORM_TARGET);
  const [targets, setTargets] = useState<DevCycleTarget[]>([]);
  const [hintReposText, setHintReposText] = useState('');
  const [repoSuggestions, setRepoSuggestions] = useState<string[]>([]);
  const [runs, setRuns] = useState<ConsoleRun[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRepos()
      .then(setRepoSuggestions)
      .catch(() => setRepoSuggestions([]));
    listDevCycleTargets()
      .then(setTargets)
      .catch(() => setTargets([]));

    Promise.allSettled([listRuns(), listDevCycleRuns()])
      .then(([platformRuns, devcycleRuns]) => {
        const merged: ConsoleRun[] = [
          ...(platformRuns.status === 'fulfilled'
            ? platformRuns.value.map((run) => ({ kind: 'platform' as const, run }))
            : []),
          ...(devcycleRuns.status === 'fulfilled'
            ? devcycleRuns.value.map((run) => ({ kind: 'devcycle' as const, run }))
            : []),
        ];
        merged.sort((a, b) => new Date(b.run.startTime).getTime() - new Date(a.run.startTime).getTime());
        setRuns(merged);
      })
      .catch(() => setRuns([]));
  }, []);

  // /?target=<repo> (the Projects page's Run shortcut) pre-selects a project.
  useEffect(() => {
    const requested = searchParams.get('target');
    if (requested) {
      setTarget(requested);
    }
  }, [searchParams]);

  const isPlatformTarget = target === PLATFORM_TARGET;
  // The requested target may not be in the fetched list (yet, or at all) --
  // render it as an extra option so the select reflects the real state.
  const knownTarget = isPlatformTarget || targets.some((candidate) => candidate.repo === target);
  const canSubmit = prompt.trim().length > 0 && !submitting;

  async function handleRun() {
    setSubmitting(true);
    setError(null);
    try {
      if (isPlatformTarget) {
        const hintRepos = hintReposText
          .split(',')
          .map((repo) => repo.trim())
          .filter(Boolean);
        const { workflowId } = await startRun({
          prompt: prompt.trim(),
          hintRepos: hintRepos.length > 0 ? hintRepos : undefined,
        });
        navigate(`/runs/${workflowId}`);
      } else {
        const { workflowId } = await startDevCycleRun({ repo: target, prompt: prompt.trim() });
        navigate(`/dev-runs/${workflowId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to start run');
      setSubmitting(false);
    }
  }

  return (
    <div className="page">
      <h1>Platform Console</h1>

      <label className="field-label" htmlFor="target">
        Target
      </label>
      <select id="target" className="text-input" value={target} onChange={(event) => setTarget(event.target.value)}>
        <option value={PLATFORM_TARGET}>Platform agent</option>
        {targets.map((candidate) => (
          <option key={candidate.repo} value={candidate.repo}>
            {candidate.project} ({candidate.repo})
          </option>
        ))}
        {!knownTarget && <option value={target}>{target}</option>}
      </select>

      <label className="field-label" htmlFor="prompt">
        {isPlatformTarget ? 'What should the platform agent investigate?' : `What should the dev agent build in ${target}?`}
      </label>
      <textarea
        id="prompt"
        className="prompt-input"
        rows={4}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />

      {isPlatformTarget && (
        <>
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
        </>
      )}

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
            <th>Type</th>
            <th>Prompt</th>
            <th>Started</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {runs.map(({ kind, run }) => (
            <tr key={run.workflowId}>
              <td>
                <StatusBadge status={run.status} />
              </td>
              <td>{kind === 'platform' ? 'platform' : 'dev cycle'}</td>
              <td>{run.promptSnippet ?? run.workflowId}</td>
              <td>{new Date(run.startTime).toLocaleString()}</td>
              <td>
                <Link to={kind === 'platform' ? `/runs/${run.workflowId}` : `/dev-runs/${run.workflowId}`}>Open</Link>
              </td>
            </tr>
          ))}
          {runs.length === 0 && (
            <tr>
              <td colSpan={5}>No runs yet.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
