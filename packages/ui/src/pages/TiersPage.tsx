import { useCallback, useEffect, useState } from 'react';
import { listTiers, replaceTiers, type TiersTable } from '../api';
import type { ModelRef } from '@agentops/contracts';

const EMPTY_ENTRY: ModelRef = { backend: 'claude', model: '' };
const ALLOWED_BACKENDS = ['claude', 'cursor', 'pi', 'codex', 'stub', 'litellm', 'platform'] as const;
const ALLOWED_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

// Deep-clone the tier table into local editable state.
function clone(tiers: TiersTable): TiersTable {
  const out: TiersTable = {};
  for (const [name, entries] of Object.entries(tiers)) {
    out[name] = entries.map((e) => ({ ...e }));
  }
  return out;
}

export function TiersPage() {
  const [tiers, setTiers] = useState<TiersTable>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const loaded = await listTiers();
      setTiers(loaded);
      setDirty(false);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'failed to load tiers');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function mutate(fn: (draft: TiersTable) => void) {
    setTiers((prev) => {
      const draft = clone(prev);
      fn(draft);
      return draft;
    });
    setDirty(true);
  }

  function updateEntry(tierName: string, index: number, patch: Partial<ModelRef>) {
    mutate((draft) => {
      const entry = draft[tierName]?.[index];
      if (entry) Object.assign(entry, patch);
    });
  }

  function addEntry(tierName: string) {
    mutate((draft) => {
      draft[tierName] = [...(draft[tierName] ?? []), { ...EMPTY_ENTRY }];
    });
  }

  function removeEntry(tierName: string, index: number) {
    mutate((draft) => {
      draft[tierName] = (draft[tierName] ?? []).filter((_, i) => i !== index);
    });
  }

  function moveEntry(tierName: string, index: number, dir: -1 | 1) {
    mutate((draft) => {
      const arr = draft[tierName];
      if (!arr) return;
      const target = index + dir;
      if (target < 0 || target >= arr.length) return;
      [arr[index], arr[target]] = [arr[target], arr[index]];
    });
  }

  function addTier() {
    const name = window.prompt('New tier name', 'custom');
    if (!name) return;
    mutate((draft) => {
      if (!draft[name]) draft[name] = [{ ...EMPTY_ENTRY }];
    });
  }

  function renameTier(oldName: string) {
    const newName = window.prompt('Rename tier', oldName);
    if (!newName || newName === oldName) return;
    mutate((draft) => {
      if (draft[newName]) return; // collision: no-op
      draft[newName] = draft[oldName];
      delete draft[oldName];
    });
  }

  function removeTier(tierName: string) {
    if (!window.confirm(`Delete tier "${tierName}"?`)) return;
    mutate((draft) => {
      delete draft[tierName];
    });
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await replaceTiers(tiers);
      setTiers(clone(saved));
      setDirty(false);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'failed to save tiers');
    } finally {
      setSaving(false);
    }
  }

  const tierNames = Object.keys(tiers).sort();

  return (
    <div>
      <h2>Model Tiers</h2>
      <p className="muted">
        Ordered model preference lists. Position 0 is the primary; the rest is the session-limit fallback chain
        (the system advances cross-backend on a <code>SessionLimitError</code>). Edits apply to new runs within ~60s.
      </p>

      {loading && <p>Loading…</p>}
      {loadError && <p className="error">Load error: {loadError}</p>}

      {!loading && !loadError && (
        <>
          <div style={{ marginBottom: '1rem' }}>
            <button onClick={addTier}>+ Add tier</button>{' '}
            <button onClick={() => void refresh()} disabled={loading}>
              Reload
            </button>{' '}
            <button onClick={() => void handleSave()} disabled={!dirty || saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            {dirty && <span className="muted"> (unsaved changes)</span>}
            {savedAt && !dirty && <span className="muted"> (saved {savedAt})</span>}
            {saveError && <span className="error"> — {saveError}</span>}
          </div>

          {tierNames.length === 0 && <p>No tiers configured.</p>}

          {tierNames.map((name) => (
            <fieldset key={name} style={{ marginBottom: '1rem' }}>
              <legend>
                <strong>{name}</strong>{' '}
                <button onClick={() => renameTier(name)}>Rename</button>{' '}
                <button onClick={() => removeTier(name)}>Delete tier</button>
              </legend>
              {(tiers[name] ?? []).map((entry, i) => (
                <div key={i} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.25rem' }}>
                  <span className="muted" style={{ width: '1.5em', textAlign: 'right' }}>
                    {i}
                  </span>
                  <select
                    value={entry.backend}
                    onChange={(e) => updateEntry(name, i, { backend: e.target.value as ModelRef['backend'] })}
                  >
                    {ALLOWED_BACKENDS.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                  <input
                    placeholder="model"
                    value={entry.model}
                    onChange={(e) => updateEntry(name, i, { model: e.target.value })}
                    style={{ width: '20em' }}
                  />
                  <select
                    value={entry.effort ?? ''}
                    onChange={(e) => updateEntry(name, i, { effort: (e.target.value || undefined) as ModelRef['effort'] })}
                  >
                    <option value="">(effort)</option>
                    {ALLOWED_EFFORTS.map((eff) => (
                      <option key={eff} value={eff}>
                        {eff}
                      </option>
                    ))}
                  </select>
                  <button onClick={() => moveEntry(name, i, -1)} disabled={i === 0} title="Move up">
                    ↑
                  </button>
                  <button
                    onClick={() => moveEntry(name, i, 1)}
                    disabled={i === (tiers[name]?.length ?? 0) - 1}
                    title="Move down"
                  >
                    ↓
                  </button>
                  <button onClick={() => removeEntry(name, i)} title="Remove">
                    ✕
                  </button>
                </div>
              ))}
              <button onClick={() => addEntry(name)}>+ Add entry</button>
            </fieldset>
          ))}
        </>
      )}
    </div>
  );
}
