import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { DevCycleRunDetail } from '@agentops/contracts';
import { getDevCycleRun } from '../api';
import { StatusBadge } from '../components/StatusBadge';

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

  const blockReasonHint = run.state?.blockReason ? BLOCK_REASON_HINTS[run.state.blockReason] : undefined;

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

      {run.state && (
        <div className="section">
          <div className="field-label">Dev cycle state</div>
          <table>
            <tbody>
              <tr>
                <th>Stage</th>
                <td>{run.state.stage}</td>
              </tr>
              <tr>
                <th>Task status</th>
                <td>{run.state.status}</td>
              </tr>
              {run.state.blockReason && (
                <tr>
                  <th>Block reason</th>
                  <td>
                    {run.state.blockReason}
                    {blockReasonHint && <p className="muted-text">{blockReasonHint}</p>}
                  </td>
                </tr>
              )}
              {run.state.prRef && (
                <tr>
                  <th>PR</th>
                  <td>{run.state.prRef}</td>
                </tr>
              )}
              <tr>
                <th>Implement attempts</th>
                <td>{run.state.implementAttempts}</td>
              </tr>
              <tr>
                <th>Babysit rounds</th>
                <td>{run.state.babysitRounds}</td>
              </tr>
              <tr>
                <th>Tokens</th>
                <td>{run.state.cumulativeTokens.toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
