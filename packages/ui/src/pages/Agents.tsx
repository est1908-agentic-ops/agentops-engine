import { useCallback, useEffect, useState } from 'react';
import type { AgentScheduleSummary } from '@agentops/contracts';
import { listAgents, runAgent } from '../api';

export function AgentsPage() {
  const [agents, setAgents] = useState<AgentScheduleSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [lastTriggered, setLastTriggered] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await listAgents();
      setAgents(res.agents);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'failed to load agents');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleRun(scheduleId: string) {
    setRunningId(scheduleId);
    setActionError(null);
    try {
      await runAgent(scheduleId);
      setLastTriggered(scheduleId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'failed to trigger agent');
    } finally {
      setRunningId(null);
    }
  }

  const byProject = agents.reduce<Record<string, AgentScheduleSummary[]>>((acc, agent) => {
    const list = acc[agent.project] ?? [];
    list.push(agent);
    acc[agent.project] = list;
    return acc;
  }, {});

  return (
    <main className="page">
      <h1>Agents</h1>
      <p className="muted">Scheduled agents from Temporal. Run now requires the control CRUD token (set on Projects).</p>
      {loading && <p>Loading…</p>}
      {loadError && <p className="error">{loadError}</p>}
      {actionError && <p className="error">{actionError}</p>}
      {lastTriggered && <p className="success">Triggered {lastTriggered}</p>}
      {Object.entries(byProject).map(([project, projectAgents]) => (
        <section key={project} className="card">
          <h2>{project}</h2>
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Workflow</th>
                <th>Cron</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {projectAgents.map((agent) => (
                <tr key={agent.scheduleId}>
                  <td>{agent.agentName}</td>
                  <td>{agent.workflow}</td>
                  <td><code>{agent.cron}</code></td>
                  <td>{agent.paused ? <span className="badge badge-muted">paused</span> : <span className="badge badge-ok">active</span>}</td>
                  <td>
                    <button
                      type="button"
                      disabled={runningId === agent.scheduleId}
                      onClick={() => void handleRun(agent.scheduleId)}
                    >
                      {runningId === agent.scheduleId ? 'Running…' : 'Run now'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      {!loading && agents.length === 0 && !loadError && <p>No agent schedules found.</p>}
    </main>
  );
}