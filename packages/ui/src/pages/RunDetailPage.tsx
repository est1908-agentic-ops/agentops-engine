import { useEffect, useRef, useState } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import { useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { RunDetail } from '@agentops/contracts';
import { getRun, siblingTemporalUrl } from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { PageShell } from '../components/PageShell';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const POLL_INTERVAL_MS = 3000;

const MARKDOWN_COMPONENTS = {
  a: (props: ComponentPropsWithoutRef<'a'>) => <a {...props} target="_blank" rel="noreferrer" />,
};

export function RunDetailPage() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!workflowId) {
      return undefined;
    }

    let cancelled = false;

    async function poll() {
      try {
        const detail = await getRun(workflowId!);
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

  return (
    <PageShell>
      <a href="/" className="text-sm text-muted-foreground">
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
        <Card className="mb-5 border-destructive/50 bg-destructive/5">
          <CardContent className="pt-4">
            <Label className="mb-1 block">Error</Label>
            <p>{run.error}</p>
          </CardContent>
        </Card>
      )}

      {run.result && (
        <>
          <div className="mb-5">
            <Label className="mb-1 block">Summary</Label>
            <div className="rounded-md border bg-card p-4 text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                {run.result.summary}
              </ReactMarkdown>
            </div>
          </div>

          {run.result.actionsTaken.length > 0 && (
            <div className="mb-5">
              <Label className="mb-1 block">Actions taken</Label>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Workflow</TableHead>
                    <TableHead>Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {run.result.actionsTaken.map((action, index) => (
                    <TableRow key={index}>
                      <TableCell>{action.type}</TableCell>
                      <TableCell>
                        <a
                          className="text-primary"
                          href={siblingTemporalUrl(run.temporalUrl, action.workflowId)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {action.workflowId}
                        </a>
                      </TableCell>
                      <TableCell>{action.reason}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {run.result.childWorkflows.length > 0 && (
            <div>
              <Label className="mb-1 block">Child workflows</Label>
              <div className="flex flex-wrap gap-3">
                {run.result.childWorkflows.map((child) => (
                  <Card key={child.workflowId} className="w-56">
                    <CardContent className="pt-4">
                      <p className="mb-1 text-sm font-semibold">{child.repo}</p>
                      <p className="mb-2 text-sm text-muted-foreground">{child.goal}</p>
                      <a
                        className="text-sm text-primary"
                        href={siblingTemporalUrl(run.temporalUrl, child.workflowId)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {child.workflowId} ↗
                      </a>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </PageShell>
  );
}