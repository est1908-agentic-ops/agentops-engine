import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ManagedProject } from '@agentops/contracts';
import {
  createProject,
  deleteProject,
  getCrudToken,
  listProjects,
  setCrudToken,
  updateProject,
  type UpdateProjectInput,
} from '../api';
import { PageShell } from '../components/PageShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

type TrackerType = 'github' | 'linear';

interface UpdateFieldValues {
  token: string;
  configJson: string;
  linearTeamKey: string;
  linearTriggerLabelId: string;
  linearToken: string;
}

function buildUpdatePayload(existing: ManagedProject, v: UpdateFieldValues): UpdateProjectInput {
  const payload: UpdateProjectInput = {};
  if (v.token) payload.token = v.token;
  if (v.configJson) payload.configJson = v.configJson;
  if (existing.trackerType === 'linear') {
    if (v.linearTeamKey && v.linearTeamKey !== existing.linearTeamKey) payload.linearTeamKey = v.linearTeamKey;
    if (v.linearTriggerLabelId && v.linearTriggerLabelId !== existing.linearTriggerLabelId)
      payload.linearTriggerLabelId = v.linearTriggerLabelId;
    if (v.linearToken) payload.linearToken = v.linearToken;
  }
  return payload;
}

interface ProjectFormValues {
  project: string;
  repo: string;
  trackerType: TrackerType;
  token: string;
  configJson: string;
  linearTeamKey: string;
  linearTriggerLabelId: string;
  linearToken: string;
}

type Mode = 'add' | { project: ManagedProject } | null;

export function ProjectsPage() {
  const [hasToken, setHasToken] = useState<boolean>(() => getCrudToken().length > 0);
  const [tokenDraft, setTokenDraft] = useState('');
  const [projects, setProjects] = useState<ManagedProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

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
    if (hasToken) {
      void refresh();
    }
  }, [hasToken, refresh]);

  function handleSaveToken() {
    setCrudToken(tokenDraft.trim());
    setTokenDraft('');
    setHasToken(tokenDraft.trim().length > 0);
  }

  function handleClearToken() {
    setCrudToken('');
    setHasToken(false);
    setProjects([]);
    setMode(null);
  }

  async function handleCreate(values: ProjectFormValues): Promise<void> {
    setBusy(true);
    setFormError(null);
    try {
      await createProject({
        project: values.project,
        repo: values.repo,
        token: values.token,
        configJson: values.configJson.trim() || undefined,
        ...(values.trackerType === 'linear' && {
          trackerType: 'linear',
          linearTeamKey: values.linearTeamKey.trim(),
          linearTriggerLabelId: values.linearTriggerLabelId.trim(),
          linearToken: values.linearToken.trim(),
        }),
      });
      setMode(null);
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'failed to create project');
      throw err;
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdate(existing: ManagedProject, values: ProjectFormValues): Promise<void> {
    setBusy(true);
    setFormError(null);
    try {
      const payload = buildUpdatePayload(existing, {
        token: values.token.trim(),
        configJson: values.configJson.trim(),
        linearTeamKey: values.linearTeamKey.trim(),
        linearTriggerLabelId: values.linearTriggerLabelId.trim(),
        linearToken: values.linearToken.trim(),
      });
      await updateProject(existing.repo, payload);
      setMode(null);
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'failed to update project');
      throw err;
    } finally {
      setBusy(false);
    }
  }

  async function performRemove(repo: string): Promise<void> {
    setBusy(true);
    setFormError(null);
    try {
      await deleteProject(repo);
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'failed to remove project');
    } finally {
      setBusy(false);
      setDeleteTarget(null);
    }
  }

  if (!hasToken) {
    return (
      <PageShell>
        <h1 className="mb-6 text-2xl font-semibold">Managed Projects</h1>
        <Card>
          <CardContent className="pt-6">
            <p className="mb-4 text-sm text-muted-foreground">
              The project-management routes require an operator bearer token (
              <code>CONTROL_CRUD_TOKEN</code>). Paste it below — it is stored only in this browser (localStorage)
              and sent as an X-Control-Crud-Token header on each request.
            </p>
            <Label htmlFor="crud-token" className="mb-1 block">
              Control CRUD token
            </Label>
            <Input
              id="crud-token"
              type="password"
              placeholder="paste CONTROL_CRUD_TOKEN"
              value={tokenDraft}
              onChange={(event) => setTokenDraft(event.target.value)}
            />
            <div className="mt-4">
              <Button type="button" disabled={!tokenDraft.trim()} onClick={handleSaveToken}>
                Save token
              </Button>
            </div>
          </CardContent>
        </Card>
        <p className="mt-4">
          <Link to="/" className="text-sm text-muted-foreground">
            ← Back to console
          </Link>
        </p>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Managed Projects</h1>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={handleClearToken}>
            Clear token
          </Button>
        </div>
      </div>

      {loadError && (
        <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm">{loadError}</div>
      )}
      {formError && (
        <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm">{formError}</div>
      )}

      {mode === 'add' ? (
        <ProjectForm
          title="Add managed project"
          submitLabel="Create"
          disabled={busy}
          onCancel={() => {
            setMode(null);
            setFormError(null);
          }}
          onSubmit={async (values) => {
            await handleCreate(values);
          }}
        />
      ) : (
        <div className="mb-5">
          <Button type="button" onClick={() => setMode('add')}>
            + Add project
          </Button>
        </div>
      )}

      {mode && typeof mode === 'object' && (
        <ProjectForm
          key={mode.project.repo}
          title={`Edit ${mode.project.project} (${mode.project.repo})`}
          submitLabel="Save"
          isUpdate
          existing={mode.project}
          disabled={busy}
          onCancel={() => {
            setMode(null);
            setFormError(null);
          }}
          onSubmit={async (values) => {
            await handleUpdate(mode.project, values);
          }}
        />
      )}

      <h2 className="mb-3 mt-8 text-base font-semibold">Registered projects ({projects.length})</h2>
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
                <Link className="text-sm text-primary" to={`/?target=${encodeURIComponent(project.repo)}`}>
                  Run
                </Link>
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-sm"
                  disabled={busy}
                  onClick={() => setMode({ project })}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-sm text-destructive"
                  disabled={busy}
                  onClick={() => setDeleteTarget(project.repo)}
                >
                  Remove
                </Button>
              </TableCell>
            </TableRow>
          ))}
          {projects.length === 0 && !loading && (
            <TableRow>
              <TableCell colSpan={7} className="text-muted-foreground">
                No managed projects yet. Click "Add project" to register a repo.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <p className="mt-4">
        <Link to="/" className="text-sm text-muted-foreground">
          ← Back to console
        </Link>
      </p>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove managed project for {deleteTarget}?</AlertDialogTitle>
            <AlertDialogDescription>This deletes its stored credential.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => deleteTarget && void performRemove(deleteTarget)}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
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

interface ProjectFormProps {
  title: string;
  submitLabel: string;
  isUpdate?: boolean;
  existing?: ManagedProject;
  disabled: boolean;
  onCancel: () => void;
  onSubmit: (values: ProjectFormValues) => Promise<void>;
}

function ProjectForm({ title, submitLabel, isUpdate, existing, disabled, onCancel, onSubmit }: ProjectFormProps) {
  const existingTracker: TrackerType = existing?.trackerType ?? 'github';
  const [trackerType, setTrackerType] = useState<TrackerType>(existingTracker);
  const [project, setProject] = useState('');
  const [repo, setRepo] = useState('');
  const [token, setToken] = useState('');
  const [configJson, setConfigJson] = useState('');
  const [linearTeamKey, setLinearTeamKey] = useState(existing?.trackerType === 'linear' ? existing.linearTeamKey : '');
  const [linearTriggerLabelId, setLinearTriggerLabelId] = useState(
    existing?.trackerType === 'linear' ? existing.linearTriggerLabelId : '',
  );
  const [linearToken, setLinearToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isLinear = trackerType === 'linear';

  const trimmed = {
    project: project.trim(),
    repo: repo.trim(),
    token: token.trim(),
    linearTeamKey: linearTeamKey.trim(),
    linearTriggerLabelId: linearTriggerLabelId.trim(),
    linearToken: linearToken.trim(),
    configJson: configJson.trim(),
  };
  const linearReady = trimmed.linearTeamKey && trimmed.linearTriggerLabelId && trimmed.linearToken;
  const createReady = trimmed.project && trimmed.repo && trimmed.token && (!isLinear || linearReady);
  const updatePayload = isUpdate && existing ? buildUpdatePayload(existing, trimmed) : null;
  const canSubmit = isUpdate
    ? !!updatePayload && Object.keys(updatePayload).length > 0 && !submitting
    : !!createReady && !submitting;

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);
    try {
      if (trimmed.configJson && trimmed.configJson !== 'null') {
        JSON.parse(trimmed.configJson);
      }
      await onSubmit({
        project: trimmed.project,
        repo: trimmed.repo,
        trackerType,
        token: trimmed.token,
        configJson: trimmed.configJson,
        linearTeamKey: trimmed.linearTeamKey,
        linearTriggerLabelId: trimmed.linearTriggerLabelId,
        linearToken: trimmed.linearToken,
      });
    } catch (err) {
      if (err instanceof SyntaxError) {
        setError(`Config is not valid JSON: ${err.message}`);
      } else {
        setError(err instanceof Error ? err.message : 'request failed');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="mb-5">
      <CardContent className="space-y-4 pt-6">
        <h3 className="font-semibold">{title}</h3>

        <div className="space-y-1.5">
          <Label htmlFor="form-tracker">Tracker</Label>
          <Select value={trackerType} onValueChange={(value) => setTrackerType(value as TrackerType)} disabled={isUpdate}>
            <SelectTrigger id="form-tracker" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="github">GitHub</SelectItem>
              <SelectItem value="linear">Linear</SelectItem>
            </SelectContent>
          </Select>
          {isUpdate && <p className="text-sm text-muted-foreground">Immutable — delete and recreate to change tracker.</p>}
        </div>

        {!isUpdate && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="form-project">Project slug</Label>
              <Input id="form-project" placeholder="acme-web" value={project} onChange={(e) => setProject(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="form-repo">Repo (owner/repo)</Label>
              <Input id="form-repo" placeholder="acme/web" value={repo} onChange={(e) => setRepo(e.target.value)} />
            </div>
          </>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="form-token">{isUpdate ? 'GitHub token (rotate — leave blank to keep)' : 'GitHub token'}</Label>
          <Input
            id="form-token"
            type="password"
            placeholder={isUpdate ? 'ghp_… (optional)' : 'ghp_…'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </div>

        {isLinear && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="form-linear-team-key">Linear team key</Label>
              <Input
                id="form-linear-team-key"
                placeholder="ENG"
                value={linearTeamKey}
                onChange={(e) => setLinearTeamKey(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="form-linear-trigger-label">Linear trigger label ID</Label>
              <Input
                id="form-linear-trigger-label"
                placeholder="550e8400-e29b-41d4-a716-446655440000"
                value={linearTriggerLabelId}
                onChange={(e) => setLinearTriggerLabelId(e.target.value)}
              />
              <p className="text-sm text-muted-foreground">
                A Linear label <strong>UUID</strong>, not its name — find it via the label settings URL or Linear's
                GraphQL API (
                <code>
                  query &#123; team(key: "ENG") &#123; labels &#123; nodes &#123; id name &#125; &#125; &#125;
                </code>
                ).
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="form-linear-token">
                {isUpdate ? 'Linear API token (rotate — leave blank to keep)' : 'Linear API token'}
              </Label>
              <Input
                id="form-linear-token"
                type="password"
                placeholder={isUpdate ? 'lin_api_… (optional)' : 'lin_api_…'}
                value={linearToken}
                onChange={(e) => setLinearToken(e.target.value)}
              />
            </div>
          </>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="form-config">
            Config JSON (optional — {isUpdate ? 'null clears to file-based' : 'omit = file-based'})
          </Label>
          <Textarea
            id="form-config"
            rows={3}
            placeholder={'{\n  "fastVerifyCommands": ["pnpm lint"],\n  "fullVerifyCommands": ["pnpm test"]\n}'}
            value={configJson}
            onChange={(e) => setConfigJson(e.target.value)}
          />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex gap-2">
          <Button type="button" disabled={!canSubmit || disabled} onClick={() => void handleSubmit()}>
            {submitting ? 'Saving…' : submitLabel}
          </Button>
          <Button type="button" variant="outline" onClick={onCancel} disabled={disabled}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
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