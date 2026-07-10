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

type TrackerType = 'github' | 'linear';

// The subset of form fields relevant to an update. Used by buildUpdatePayload
// to compute the minimal change set against the stored project.
interface UpdateFieldValues {
  token: string;
  configJson: string;
  linearTeamKey: string;
  linearTriggerLabelId: string;
  linearToken: string;
}

// Builds the minimal PUT payload: a field is included only when it is a
// genuine change. Blank = keep (the server's omit-means-keep semantics). For
// the non-secret Linear fields -- which are prefilled on edit -- "unchanged
// from the stored value" is also treated as keep, so editing a Linear project
// never re-sends its current team key/label id and Save stays disabled until
// a real change, matching the GitHub edit path.
function buildUpdatePayload(existing: ManagedProject, v: UpdateFieldValues): UpdateProjectInput {
  const payload: UpdateProjectInput = {};
  if (v.token) payload.token = v.token;
  if (v.configJson) payload.configJson = v.configJson;
  if (existing.trackerType === 'linear') {
    if (v.linearTeamKey && v.linearTeamKey !== existing.linearTeamKey)
      payload.linearTeamKey = v.linearTeamKey;
    if (v.linearTriggerLabelId && v.linearTriggerLabelId !== existing.linearTriggerLabelId)
      payload.linearTriggerLabelId = v.linearTriggerLabelId;
    if (v.linearToken) payload.linearToken = v.linearToken;
  }
  return payload;
}

// A flat bag of every field the form can collect. The page handlers project
// this down to CreateProjectInput / UpdateProjectInput depending on mode, so
// the form itself stays tracker-agnostic about request shapes.
interface ProjectFormValues {
  project: string;
  repo: string;
  trackerType: TrackerType;
  token: string; // GitHub/SCM token (always required on create, regardless of tracker)
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

  async function handleRemove(repo: string): Promise<void> {
    if (
      !window.confirm(`Remove managed project for ${repo}? This deletes its stored credential.`)
    ) {
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await deleteProject(repo);
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'failed to remove project');
    } finally {
      setBusy(false);
    }
  }

  if (!hasToken) {
    return (
      <div className="page">
        <h1>Managed Projects</h1>
        <div className="section">
          <p className="muted-text">
            The project-management routes require an operator bearer token (
            <code>CONTROL_CRUD_TOKEN</code>). Paste it below — it is stored only in this browser
            (localStorage) and sent as an X-Control-Crud-Token header on each request.
          </p>
          <label className="field-label" htmlFor="crud-token">
            Control CRUD token
          </label>
          <input
            id="crud-token"
            className="text-input"
            type="password"
            placeholder="paste CONTROL_CRUD_TOKEN"
            value={tokenDraft}
            onChange={(event) => setTokenDraft(event.target.value)}
          />
          <div className="actions">
            <button
              type="button"
              className="run-button"
              disabled={!tokenDraft.trim()}
              onClick={handleSaveToken}
            >
              Save token
            </button>
          </div>
        </div>
        <p>
          <Link to="/" className="back-link">
            ← Back to console
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="projects-header">
        <h1>Managed Projects</h1>
        <div className="header-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={() => void refresh()}
            disabled={loading}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button type="button" className="ghost-button" onClick={handleClearToken}>
            Clear token
          </button>
        </div>
      </div>

      {loadError && <div className="error-box section">{loadError}</div>}
      {formError && <div className="error-box section">{formError}</div>}

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
        <div className="section">
          <button type="button" className="run-button" onClick={() => setMode('add')}>
            + Add project
          </button>
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

      <h2>Registered projects ({projects.length})</h2>
      <table>
        <thead>
          <tr>
            <th>Project</th>
            <th>Repo</th>
            <th>Tracker</th>
            <th>Credential</th>
            <th>Config</th>
            <th>Updated</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => (
            <tr key={project.repo}>
              <td>{project.project}</td>
              <td>
                <code>{project.repo}</code>
              </td>
              <td>
                {project.trackerType === 'linear' ? (
                  <span>
                    Linear · <code>{project.linearTeamKey}</code>
                  </span>
                ) : (
                  'GitHub'
                )}
              </td>
              <td>
                <CredentialBadges project={project} />
              </td>
              <td>{project.config ? 'custom' : 'file'}</td>
              <td>{formatTimestamp(project.updatedAt)}</td>
              <td className="row-actions">
                <Link className="link-button" to={`/?target=${encodeURIComponent(project.repo)}`}>
                  Run
                </Link>
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  onClick={() => setMode({ project })}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="link-button danger"
                  disabled={busy}
                  onClick={() => void handleRemove(project.repo)}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
          {projects.length === 0 && !loading && (
            <tr>
              <td colSpan={7} className="muted-text">
                No managed projects yet. Click “Add project” to register a repo.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <p>
        <Link to="/" className="back-link">
          ← Back to console
        </Link>
      </p>
    </div>
  );
}

function CredentialBadges({ project }: { project: ManagedProject }) {
  if (project.trackerType === 'linear') {
    // A linear project carries both a GitHub SCM credential and a Linear
    // API credential; show both. Never the token value itself.
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
    <span
      className="status-badge"
      style={{ backgroundColor: set ? '#16a34a' : '#9ca3af', marginRight: 4 }}
      title={set ? `${label} credential set` : `no ${label} credential`}
    >
      {label} {set ? '✓' : '—'}
    </span>
  );
}

interface ProjectFormProps {
  title: string;
  submitLabel: string;
  isUpdate?: boolean;
  /** Present iff isUpdate — the project being edited. */
  existing?: ManagedProject;
  disabled: boolean;
  onCancel: () => void;
  onSubmit: (values: ProjectFormValues) => Promise<void>;
}

function ProjectForm({
  title,
  submitLabel,
  isUpdate,
  existing,
  disabled,
  onCancel,
  onSubmit,
}: ProjectFormProps) {
  // trackerType is chosen on create (default github) and immutable on update
  // (derived from the existing project, never sent in the PUT body).
  const existingTracker: TrackerType = existing?.trackerType ?? 'github';
  const [trackerType, setTrackerType] = useState<TrackerType>(existingTracker);
  const [project, setProject] = useState('');
  const [repo, setRepo] = useState('');
  // `token` is the GitHub/SCM token (always present, required on create; on
  // update blank means "keep"). Labelled "GitHub token" to disambiguate from
  // the Linear token below.
  const [token, setToken] = useState('');
  const [configJson, setConfigJson] = useState('');
  // Linear fields are pre-filled from the existing project on update (the
  // non-secret ones); linearToken is never echoed back, blank = keep/rotate.
  const [linearTeamKey, setLinearTeamKey] = useState(
    existing?.trackerType === 'linear' ? existing.linearTeamKey : '',
  );
  const [linearTriggerLabelId, setLinearTriggerLabelId] = useState(
    existing?.trackerType === 'linear' ? existing.linearTriggerLabelId : '',
  );
  const [linearToken, setLinearToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isLinear = trackerType === 'linear';

  // Client-side validation mirrors the contract's superRefine: when the
  // tracker is linear, the three linear fields are required (on create);
  // repo/project/token are always required on create. On update at least one
  // field must change; tracker/repo/project are immutable.
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
  const createReady =
    trimmed.project && trimmed.repo && trimmed.token && (!isLinear || linearReady);
  // Update is submittable only when at least one field genuinely changed.
  // buildUpdatePayload encodes "blank = keep" and, for prefilled non-secret
  // Linear fields, "unchanged = keep" -- so editing a Linear project keeps
  // Save disabled until a real change, same as the GitHub edit path.
  const updatePayload = isUpdate && existing ? buildUpdatePayload(existing, trimmed) : null;
  const canSubmit = isUpdate
    ? !!updatePayload && Object.keys(updatePayload).length > 0 && !submitting
    : !!createReady && !submitting;

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);
    try {
      // Validate config JSON up front so the user gets a clear local error
      // rather than a 400 from the server.
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
    <div className="card form-card section">
      <h3>{title}</h3>
      {/* Tracker selector: create = editable, update = read-only (immutable identity). */}
      <label className="field-label" htmlFor="form-tracker">
        Tracker
      </label>
      <select
        id="form-tracker"
        className="text-input"
        value={trackerType}
        onChange={(event) => setTrackerType(event.target.value as TrackerType)}
        disabled={isUpdate}
      >
        <option value="github">GitHub</option>
        <option value="linear">Linear</option>
      </select>
      {isUpdate && (
        <p className="muted-text" style={{ marginTop: 4 }}>
          Immutable — delete and recreate to change tracker.
        </p>
      )}
      {!isUpdate && (
        <>
          <label className="field-label" htmlFor="form-project">
            Project slug
          </label>
          <input
            id="form-project"
            className="text-input"
            placeholder="acme-web"
            value={project}
            onChange={(event) => setProject(event.target.value)}
          />
          <label className="field-label" htmlFor="form-repo">
            Repo (owner/repo)
          </label>
          <input
            id="form-repo"
            className="text-input"
            placeholder="acme/web"
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
          />
        </>
      )}
      <label className="field-label" htmlFor="form-token">
        {isUpdate ? 'GitHub token (rotate — leave blank to keep)' : 'GitHub token'}
      </label>
      <input
        id="form-token"
        className="text-input"
        type="password"
        placeholder={isUpdate ? 'ghp_… (optional)' : 'ghp_…'}
        value={token}
        onChange={(event) => setToken(event.target.value)}
      />
      {isLinear && (
        <>
          <label className="field-label" htmlFor="form-linear-team-key">
            Linear team key
          </label>
          <input
            id="form-linear-team-key"
            className="text-input"
            placeholder="ENG"
            value={linearTeamKey}
            onChange={(event) => setLinearTeamKey(event.target.value)}
          />
          <label className="field-label" htmlFor="form-linear-trigger-label">
            Linear trigger label ID
          </label>
          <input
            id="form-linear-trigger-label"
            className="text-input"
            placeholder="550e8400-e29b-41d4-a716-446655440000"
            value={linearTriggerLabelId}
            onChange={(event) => setLinearTriggerLabelId(event.target.value)}
          />
          <p className="muted-text" style={{ marginTop: 4 }}>
            A Linear label <strong>UUID</strong>, not its name — find it via the label settings URL
            or Linear’s GraphQL API (
            <code>
              query &#123; team(key: "ENG") &#123; labels &#123; nodes &#123; id name &#125; &#125;
              &#125;
            </code>
            ).
          </p>
          <label className="field-label" htmlFor="form-linear-token">
            {isUpdate ? 'Linear API token (rotate — leave blank to keep)' : 'Linear API token'}
          </label>
          <input
            id="form-linear-token"
            className="text-input"
            type="password"
            placeholder={isUpdate ? 'lin_api_… (optional)' : 'lin_api_…'}
            value={linearToken}
            onChange={(event) => setLinearToken(event.target.value)}
          />
        </>
      )}
      <label className="field-label" htmlFor="form-config">
        Config JSON (optional — {isUpdate ? 'null clears to file-based' : 'omit = file-based'})
      </label>
      <textarea
        id="form-config"
        className="prompt-input"
        rows={3}
        placeholder={
          '{\n  "fastVerifyCommands": ["pnpm lint"],\n  "fullVerifyCommands": ["pnpm test"]\n}'
        }
        value={configJson}
        onChange={(event) => setConfigJson(event.target.value)}
      />
      {error && <p className="error-text">{error}</p>}
      <div className="actions">
        <button
          type="button"
          className="run-button"
          disabled={!canSubmit || disabled}
          onClick={() => void handleSubmit()}
        >
          {submitting ? 'Saving…' : submitLabel}
        </button>
        <button type="button" className="ghost-button" onClick={onCancel} disabled={disabled}>
          Cancel
        </button>
      </div>
    </div>
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
