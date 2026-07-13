import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { DevCycleRunDetail } from '@agentops/contracts';
import { getDevCycleRun } from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { PageShell } from '../components/PageShell';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';

const POLL_INTERVAL_MS = 3000;

const BLOCK_REASON_HINTS: Record<string, string> = {
  'unregistered-repo':
    'The worker does not know this repo. It may have been registered in the console after the worker last restarted — check the registration, or restart the worker so it reloads the managed registry.',
};

export function DevCycleRunDetailPage() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const [run, setRun] = useState<DevCycleRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!workflowId) {
      return undefined;
    }

    let cancelled = false;

    async function poll() {
      try {
        const detail = await getDevCycleRun(workflowId!);
        if (cancelled) {
          return;
        }
        setRun(detail);
        setError(null);
        if (detail.status !== 'RUNNING' && intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'failed to load run');
        }
      }
    }

    void poll();
    intervalRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [workflowId]);

  if (error) {
    return (
      <PageShell>
        <p className="text-sm text-destructive">{error}</p>
      </PageShell>
    );
  }
  if (!run) {
    return (
      <PageShell>
        <p>Loading…</p>
      </PageShell>
    );
  }

  const blockReasonHint = run.state?.blockReason ? BLOCK_REASON_HINTS[run.state.blockReason] : undefined;

  return (
    <PageShell>
      <a href="/dashboard" className="text-sm text-muted-foreground">
        ← Back
      </a>
      <div className="mb-6 mt-3 flex items-center gap-3">
        <StatusBadge status={run.status} />
        <span className="font-mono text-sm text-muted-foreground">{run.workflowId}</span>
        <a className="ml-auto text-sm text-primary" href={run.temporalUrl} target="_blank" rel="noreferrer">
          Open in Temporal ↗
        </a>
      </div>

      {run.prompt && (
        <div className="mb-5">
          <Label className="mb-1 block">Prompt</Label>
          <p className="whitespace-pre-wrap">{run.prompt}</p>
        </div>
      )}

      {run.error && (
        <div className="mb-5 rounded-md border border-destructive/50 bg-destructive/5 p-4">
          <Label className="mb-1 block">Error</Label>
          <p>{run.error}</p>
        </div>
      )}

      {run.state && (
        <div>
          <Label className="mb-1 block">Dev cycle state</Label>
          <Table>
            <TableBody>
              <TableRow>
                <TableCell className="w-40 font-medium">Stage</TableCell>
                <TableCell>{run.state.stage}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Task status</TableCell>
                <TableCell>{run.state.status}</TableCell>
              </TableRow>
              {run.state.blockReason && (
                <TableRow>
                  <TableCell className="font-medium">Block reason</TableCell>
                  <TableCell>
                    {run.state.blockReason}
                    {blockReasonHint && <p className="mt-1 text-sm text-muted-foreground">{blockReasonHint}</p>}
                  </TableCell>
                </TableRow>
              )}
              {run.state.prRef && (
                <TableRow>
                  <TableCell className="font-medium">PR</TableCell>
                  <TableCell>{run.state.prRef}</TableCell>
                </TableRow>
              )}
              <TableRow>
                <TableCell className="font-medium">Implement attempts</TableCell>
                <TableCell>{run.state.implementAttempts}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Babysit rounds</TableCell>
                <TableCell>{run.state.babysitRounds}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Tokens</TableCell>
                <TableCell>{run.state.cumulativeTokens.toLocaleString()}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      )}
    </PageShell>
  );
}