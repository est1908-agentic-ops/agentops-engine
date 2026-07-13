import { useCallback, useEffect, useState } from 'react';
import {
  getCrudToken,
  getSelfHealSettings,
  updateSelfHealSettings,
  type SelfHealSettingsResponse,
} from '../api';

export function SettingsPage() {
  const [settings, setSettings] = useState<SelfHealSettingsResponse | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const hasCrudToken = Boolean(getCrudToken());

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const loaded = await getSelfHealSettings();
      setSettings(loaded);
      setEnabled(loaded.enabled);
      setDirty(false);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'failed to load settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await updateSelfHealSettings({ enabled });
      setSettings(saved);
      setEnabled(saved.enabled);
      setDirty(false);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="page">
      <h1>Settings</h1>
      <p className="muted">Fleet operator settings. Saves require the control CRUD token (set on Projects).</p>

      {loading && <p>Loading…</p>}
      {loadError && <p className="error">{loadError}</p>}

      {!loading && !loadError && settings && (
        <section className="card">
          <h2>Self-heal (M6 Heal)</h2>
          <p className="muted">
            Scheduled sweep that drives the platform agent to find recent workflow failures and open fix PRs.
            Cron: <code>{settings.cron}</code>
            {settings.scheduleActive ? (
              <span className="badge badge-ok" style={{ marginLeft: '0.5rem' }}>
                schedule active
              </span>
            ) : (
              <span className="badge badge-muted" style={{ marginLeft: '0.5rem' }}>
                schedule absent
              </span>
            )}
          </p>

          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '1rem' }}>
            <input
              type="checkbox"
              checked={enabled}
              disabled={!hasCrudToken}
              onChange={(e) => {
                setEnabled(e.target.checked);
                setDirty(true);
              }}
            />
            <span>Enable self-heal schedule</span>
          </label>

          {!hasCrudToken && (
            <p className="muted">Set the CRUD token on the Projects page to edit this setting.</p>
          )}

          <div>
            <button type="button" onClick={() => void refresh()} disabled={loading}>
              Reload
            </button>{' '}
            <button type="button" onClick={() => void handleSave()} disabled={!dirty || saving || !hasCrudToken}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            {dirty && <span className="muted"> (unsaved changes)</span>}
            {savedAt && !dirty && <span className="muted"> (saved {savedAt})</span>}
            {saveError && <span className="error"> — {saveError}</span>}
          </div>
        </section>
      )}
    </main>
  );
}