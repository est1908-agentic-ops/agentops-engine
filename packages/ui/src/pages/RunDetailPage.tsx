import { useEffect, useRef, useState } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import { useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { RunDetail } from '@agentops/contracts';
import { getRun, siblingTemporalUrl } from '../api';
import { StatusBadge } from '../components/StatusBadge';

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
      <div className="page">
        <p className="error-text">{error}</p>
      </div>
    );
  }
  if (!run) {
    return (
      <div className="page">
        <p>Loading…</p>
      </div>
    );
  }

  return (
    <div className="page">
      <a href="/" className="back-link">
        ← Back
      </a>
      <div className="run-header">
        <StatusBadge status={run.status} />
        <span className="run-id">{run.workflowId}</span>
        <a className="temporal-link" href={run.temporalUrl} target="_blank" rel="noreferrer">
          Open in Temporal ↗
        </a>
      </div>

      {run.prompt && (
        <div className="section">
          <div className="field-label">Prompt</div>
          <p className="prompt-text">{run.prompt}</p>
        </div>
      )}

      {run.error && (
        <div className="section error-box">
          <div className="field-label">Error</div>
          <p>{run.error}</p>
        </div>
      )}

      {run.result && (
        <>
          <div className="section">
            <div className="field-label">Summary</div>
            <div className="summary-text">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                {run.result.summary}
              </ReactMarkdown>
            </div>
          </div>

          {run.result.actionsTaken.length > 0 && (
            <div className="section">
              <div className="field-label">Actions taken</div>
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Workflow</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {run.result.actionsTaken.map((action, index) => (
                    <tr key={index}>
                      <td>{action.type}</td>
                      <td>
                        <a href={siblingTemporalUrl(run.temporalUrl, action.workflowId)} target="_blank" rel="noreferrer">
                          {action.workflowId}
                        </a>
                      </td>
                      <td>{action.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {run.result.childWorkflows.length > 0 && (
            <div className="section">
              <div className="field-label">Child workflows</div>
              <div className="child-cards">
                {run.result.childWorkflows.map((child) => (
                  <div className="card" key={child.workflowId}>
                    <h3>{child.repo}</h3>
                    <p>{child.goal}</p>
                    <a href={siblingTemporalUrl(run.temporalUrl, child.workflowId)} target="_blank" rel="noreferrer">
                      {child.workflowId} ↗
                    </a>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
