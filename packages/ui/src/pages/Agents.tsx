import { useCallback, useEffect, useState } from 'react';
import type { AgentScheduleSummary } from '@agentops/contracts';
import { listAgents, runAgent } from '../api';
import { PageShell } from '../components/PageShell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

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
    <PageShell>
      <h1 className="mb-2 text-2xl font-semibold">Agents</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Scheduled agents from Temporal. Run now requires the control CRUD token (set on Projects).
      </p>
      {loading && <p>Loading…</p>}
      {loadError && <p className="text-sm text-destructive">{loadError}</p>}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}
      {lastTriggered && <p className="text-sm text-green-600">Triggered {lastTriggered}</p>}
      {Object.entries(byProject).map(([project, projectAgents]) => (
        <Card key={project} className="mb-4">
          <CardHeader>
            <CardTitle>{project}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Workflow</TableHead>
                  <TableHead>Cron</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {projectAgents.map((agent) => (
                  <TableRow key={agent.scheduleId}>
                    <TableCell>{agent.agentName}</TableCell>
                    <TableCell>{agent.workflow}</TableCell>
                    <TableCell>
                      <code>{agent.cron}</code>
                    </TableCell>
                    <TableCell>
                      {agent.paused ? (
                        <Badge variant="secondary">paused</Badge>
                      ) : (
                        <Badge className="border-transparent text-white" style={{ backgroundColor: '#16a34a' }}>
                          active
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        size="sm"
                        disabled={runningId === agent.scheduleId}
                        onClick={() => void handleRun(agent.scheduleId)}
                      >
                        {runningId === agent.scheduleId ? 'Running…' : 'Run now'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}
      {!loading && agents.length === 0 && !loadError && <p>No agent schedules found.</p>}
    </PageShell>
  );
}