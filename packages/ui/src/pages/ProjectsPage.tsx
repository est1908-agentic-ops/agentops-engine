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
  type CreateProjectInput,
} from '../api';

type Mode = 'add' | { repo: string; project: string } | null;

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

  async function handleCreate(input: CreateProjectInput): Promise<void> {
    setBusy(true);
    setFormError(null);
    try {
      await createProject(input);
      setMode(null);
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'failed to create project');
      throw err;
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdate(repo: string, token: string | undefined, configJson: string | undefined): Promise<void> {
    setBusy(true);
    setFormError(null);
    try {
      await updateProject(repo, { token: token || undefined, configJson });
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
    if (!window.confirm(`Remove managed project for ${repo}? This deletes its stored credential.`)) {
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
            The project-management routes require an operator bearer token (<code>CONTROL_CRUD_TOKEN</code>). Paste it
            below — it is stored only in this browser (localStorage) and sent as an X-Control-Crud-Token header on each request.
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
            <button type="button" className="run-button" disabled={!tokenDraft.trim()} onClick={handleSaveToken}>
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
          <button type="button" className="ghost-button" onClick={() => void refresh()} disabled={loading}>
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
          key={mode.repo}
          title={`Edit ${mode.project} (${mode.repo})`}
          submitLabel="Save"
          isUpdate
          disabled={busy}
          onCancel={() => {
            setMode(null);
            setFormError(null);
          }}
          onSubmit={async (values) => {
            await handleUpdate(mode.repo, values.token, values.configJson);
          }}
        />
      )}

      <h2>Registered projects ({projects.length})</h2>
      <table>
        <thead>
          <tr>
            <th>Project</th>
            <th>Repo</th>
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
                <span className="status-badge" style={{ backgroundColor: project.credentialSet ? '#16a34a' : '#9ca3af' }}>
                  {project.credentialSet ? 'set' : 'none'}
                </span>
              </td>
              <td>{project.config ? 'custom' : 'file'}</td>
              <td>{formatTimestamp(project.updatedAt)}</td>
              <td className="row-actions">
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  onClick={() => setMode({ repo: project.repo, project: project.project })}
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
              <td colSpan={6} className="muted-text">
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

interface ProjectFormProps {
  title: string;
  submitLabel: string;
  isUpdate?: boolean;
  disabled: boolean;
  onCancel: () => void;
  onSubmit: (values: CreateProjectInput) => Promise<void>;
}

function ProjectForm({ title, submitLabel, isUpdate, disabled, onCancel, onSubmit }: ProjectFormProps) {
  const [project, setProject] = useState('');
  const [repo, setRepo] = useState('');
  const [token, setToken] = useState('');
  const [configJson, setConfigJson] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // For an update, repo/project are immutable -- no inputs for them; the
  // only editable fields are token (rotate) and config (set/clear/keep).
  const canSubmit = isUpdate
    ? (token.trim().length > 0 || configJson.trim().length > 0) && !submitting
    : project.trim().length > 0 && repo.trim().length > 0 && token.trim().length > 0 && !submitting;

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);
    try {
      // Validate config JSON up front so the user gets a clear local error
      // rather than a 400 from the server.
      if (configJson.trim() && configJson.trim() !== 'null') {
        JSON.parse(configJson.trim());
      }
      await onSubmit({
        project: project.trim(),
        repo: repo.trim(),
        token: token.trim(),
        configJson: configJson.trim() || undefined,
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
        {isUpdate ? 'Rotate token (leave blank to keep)' : 'GitHub token'}
      </label>
      <input
        id="form-token"
        className="text-input"
        type="password"
        placeholder={isUpdate ? 'ghp_… (optional)' : 'ghp_…'}
        value={token}
        onChange={(event) => setToken(event.target.value)}
      />
      <label className="field-label" htmlFor="form-config">
        Config JSON (optional — {isUpdate ? 'null clears to file-based' : 'omit = file-based'})
      </label>
      <textarea
        id="form-config"
        className="prompt-input"
        rows={3}
        placeholder={'{\n  "fastVerifyCommands": ["pnpm lint"],\n  "fullVerifyCommands": ["pnpm test"]\n}'}
        value={configJson}
        onChange={(event) => setConfigJson(event.target.value)}
      />
      {error && <p className="error-text">{error}</p>}
      <div className="actions">
        <button type="button" className="run-button" disabled={!canSubmit || disabled} onClick={() => void handleSubmit()}>
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
