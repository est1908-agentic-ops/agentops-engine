import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ManagedProject } from '@agentops/contracts';
import { getCrudToken, getProject, listProjects, setCrudToken } from '../api';
import { PageShell } from '../components/PageShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

// Projects are onboarded by PR to the platform repo now, not through this
// console -- POST/PUT/DELETE /api/projects were retired along with the
// managed-project CRUD store. `GET /api/projects` and `GET /api/projects/:repo`
// stay open/unauthenticated (see create-control-server.ts), so this page is a
// plain viewer: it never needs the control CRUD token itself. That token is
// still collected here because it's the one place in the console where an
// operator pastes it into localStorage for the *other* write actions
// (Settings self-heal toggle, tier routing edits, run/chat start) to use.
export function ProjectsPage() {
  const [hasToken, setHasToken] = useState<boolean>(() => getCrudToken().length > 0);
  const [tokenDraft, setTokenDraft] = useState('');
  const [projects, setProjects] = useState<ManagedProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [detail, setDetail] = useState<ManagedProject | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setProjects(await listProjects());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'failed to load projects');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function handleSaveToken() {
    setCrudToken(tokenDraft.trim());
    setTokenDraft('');
    setHasToken(tokenDraft.trim().length > 0);
  }

  function handleClearToken() {
    setCrudToken('');
    setHasToken(false);
  }

  async function handleViewDetail(repo: string): Promise<void> {
    setSelectedRepo(repo);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      setDetail(await getProject(repo));
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : 'failed to load project');
    } finally {
      setDetailLoading(false);
    }
  }

  function handleCloseDetail() {
    setSelectedRepo(null);
    setDetail(null);
    setDetailError(null);
  }

  return (
    <PageShell>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Managed Projects</h1>
        <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <p className="mb-4 text-sm text-muted-foreground">
        Read-only. Projects are onboarded by opening a PR against the platform repo, not from this console.
      </p>

      <Card className="mb-6">
        <CardContent className="space-y-2 pt-6">
          <Label htmlFor="crud-token" className="mb-1 block">
            Control CRUD token
          </Label>
          <p className="text-sm text-muted-foreground">
            Not used to view projects (the read routes are open). Stored only in this browser and sent as an
            X-Control-Crud-Token header by the console's other write actions (Settings, Tiers, run/chat start).
          </p>
          {hasToken ? (
            <div className="flex items-center gap-2">
              <Badge variant="default">token set</Badge>
              <Button type="button" variant="outline" size="sm" onClick={handleClearToken}>
                Clear token
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Input
                id="crud-token"
                type="password"
                placeholder="paste CONTROL_CRUD_TOKEN"
                value={tokenDraft}
                onChange={(event) => setTokenDraft(event.target.value)}
              />
              <Button type="button" size="sm" disabled={!tokenDraft.trim()} onClick={handleSaveToken}>
                Save token
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {loadError && (
        <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm">{loadError}</div>
      )}

      <h2 className="mb-3 text-base font-semibold">Registered projects ({projects.length})</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Project</TableHead>
            <TableHead>Repo</TableHead>
            <TableHead>Tracker</TableHead>
            <TableHead>Credential</TableHead>
            <TableHead>Config</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {projects.map((project) => (
            <TableRow key={project.repo}>
              <TableCell>{project.project}</TableCell>
              <TableCell>
                <code>{project.repo}</code>
              </TableCell>
              <TableCell>
                {project.trackerType === 'linear' ? (
                  <span>
                    Linear · <code>{project.linearTeamKey}</code>
                  </span>
                ) : (
                  'GitHub'
                )}
              </TableCell>
              <TableCell>
                <CredentialBadges project={project} />
              </TableCell>
              <TableCell>{project.config ? 'custom' : 'file'}</TableCell>
              <TableCell>{formatTimestamp(project.updatedAt)}</TableCell>
              <TableCell className="flex gap-3 whitespace-nowrap">
                <Link className="text-sm text-primary" to={`/dashboard?target=${encodeURIComponent(project.repo)}`}>
                  Run
                </Link>
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-sm"
                  onClick={() => void handleViewDetail(project.repo)}
                >
                  View
                </Button>
              </TableCell>
            </TableRow>
          ))}
          {projects.length === 0 && !loading && (
            <TableRow>
              <TableCell colSpan={7} className="text-muted-foreground">
                No managed projects registered.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      {selectedRepo && (
        <Card className="mt-6">
          <CardContent className="space-y-3 pt-6">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">{selectedRepo}</h3>
              <Button type="button" variant="outline" size="sm" onClick={handleCloseDetail}>
                Close
              </Button>
            </div>
            {detailLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
            {detailError && <p className="text-sm text-destructive">{detailError}</p>}
            {detail && <ProjectDetail project={detail} />}
          </CardContent>
        </Card>
      )}

      <p className="mt-4">
        <Link to="/dashboard" className="text-sm text-muted-foreground">
          ← Back to console
        </Link>
      </p>
    </PageShell>
  );
}

function ProjectDetail({ project }: { project: ManagedProject }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
      <dt className="text-muted-foreground">Project</dt>
      <dd>{project.project}</dd>
      <dt className="text-muted-foreground">Repo</dt>
      <dd>
        <code>{project.repo}</code>
      </dd>
      <dt className="text-muted-foreground">Tracker</dt>
      <dd>
        {project.trackerType === 'linear' ? (
          <span>
            Linear · team <code>{project.linearTeamKey}</code> · trigger label{' '}
            <code>{project.linearTriggerLabelId}</code>
          </span>
        ) : (
          'GitHub'
        )}
      </dd>
      <dt className="text-muted-foreground">Credential</dt>
      <dd>
        <CredentialBadges project={project} />
      </dd>
      <dt className="text-muted-foreground">Config</dt>
      <dd>
        {project.config ? (
          <pre className="max-w-full overflow-x-auto rounded-md bg-muted p-2 text-xs">
            {JSON.stringify(project.config, null, 2)}
          </pre>
        ) : (
          'file-based (agentops.json in repo)'
        )}
      </dd>
      <dt className="text-muted-foreground">Created</dt>
      <dd>{formatTimestamp(project.createdAt)}</dd>
      <dt className="text-muted-foreground">Updated</dt>
      <dd>{formatTimestamp(project.updatedAt)}</dd>
    </dl>
  );
}

function CredentialBadges({ project }: { project: ManagedProject }) {
  if (project.trackerType === 'linear') {
    return (
      <>
        <CredentialBadge set={project.credentialSet} label="GH" />
        <CredentialBadge set={project.linearCredentialSet} label="Linear" />
      </>
    );
  }
  return <CredentialBadge set={project.credentialSet} label="GitHub" />;
}

function CredentialBadge({ set, label }: { set: boolean; label: string }) {
  return (
    <Badge
      className="mr-1 border-transparent text-white"
      style={{ backgroundColor: set ? '#16a34a' : '#9ca3af' }}
      title={set ? `${label} credential set` : `no ${label} credential`}
    >
      {label} {set ? '✓' : '—'}
    </Badge>
  );
}

function formatTimestamp(iso: string): string {
  if (!iso) {
    return '—';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString();
}
