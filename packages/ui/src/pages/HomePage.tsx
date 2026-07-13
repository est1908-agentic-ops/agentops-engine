import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { DevCycleTarget, RunListItem } from '@agentops/contracts';
import { listDevCycleRuns, listDevCycleTargets, listRepos, listRuns, startDevCycleRun, startRun } from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { PageShell } from '../components/PageShell';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

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

  useEffect(() => {
    const requested = searchParams.get('target');
    if (requested) {
      setTarget(requested);
    }
  }, [searchParams]);

  const isPlatformTarget = target === PLATFORM_TARGET;
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
    <PageShell>
      <h1 className="mb-6 text-2xl font-semibold">Platform Console</h1>

      <div className="mb-4 space-y-1.5">
        <Label htmlFor="target">Target</Label>
        <Select value={target} onValueChange={setTarget}>
          <SelectTrigger id="target" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={PLATFORM_TARGET}>Platform agent</SelectItem>
            {targets.map((candidate) => (
              <SelectItem key={candidate.repo} value={candidate.repo}>
                {candidate.project} ({candidate.repo})
              </SelectItem>
            ))}
            {!knownTarget && <SelectItem value={target}>{target}</SelectItem>}
          </SelectContent>
        </Select>
      </div>

      <div className="mb-4 space-y-1.5">
        <Label htmlFor="prompt">
          {isPlatformTarget
            ? 'What should the platform agent investigate?'
            : `What should the dev agent build in ${target}?`}
        </Label>
        <Textarea id="prompt" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </div>

      {isPlatformTarget && (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            {SUGGESTED_PROMPTS.map((suggestion) => (
              <Button
                key={suggestion}
                type="button"
                variant="secondary"
                size="sm"
                className="rounded-full"
                onClick={() => setPrompt(suggestion)}
              >
                {suggestion}
              </Button>
            ))}
          </div>

          <div className="mb-4 space-y-1.5">
            <Label htmlFor="hint-repos">Hint repos (optional)</Label>
            <Input
              id="hint-repos"
              placeholder="owner/repo, owner/repo2"
              value={hintReposText}
              onChange={(e) => setHintReposText(e.target.value)}
              list="repo-suggestions"
            />
            <datalist id="repo-suggestions">
              {repoSuggestions.map((repo) => (
                <option key={repo} value={repo} />
              ))}
            </datalist>
          </div>
        </>
      )}

      <div className="mt-5">
        <Button type="button" disabled={!canSubmit} onClick={handleRun}>
          {submitting ? 'Starting…' : 'Run'}
        </Button>
      </div>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

      <h2 className="mb-3 mt-10 text-base font-semibold">Recent runs</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Status</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Prompt</TableHead>
            <TableHead>Started</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map(({ kind, run }) => (
            <TableRow key={run.workflowId}>
              <TableCell>
                <StatusBadge status={run.status} />
              </TableCell>
              <TableCell>{kind === 'platform' ? 'platform' : 'dev cycle'}</TableCell>
              <TableCell>{run.promptSnippet ?? run.workflowId}</TableCell>
              <TableCell>{new Date(run.startTime).toLocaleString()}</TableCell>
              <TableCell>
                <Link
                  className="text-primary underline underline-offset-2"
                  to={kind === 'platform' ? `/runs/${run.workflowId}` : `/dev-runs/${run.workflowId}`}
                >
                  Open
                </Link>
              </TableCell>
            </TableRow>
          ))}
          {runs.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-muted-foreground">
                No runs yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </PageShell>
  );
}