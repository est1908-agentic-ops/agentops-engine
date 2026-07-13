import { useCallback, useEffect, useState } from 'react';
import { getCrudToken, getSelfHealSettings, updateSelfHealSettings, type SelfHealSettingsResponse } from '../api';
import { PageShell } from '../components/PageShell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

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
    <PageShell>
      <h1 className="mb-1 text-2xl font-semibold">Settings</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Fleet operator settings. Saves require the control CRUD token (set on Projects).
      </p>

      {loading && <p>Loading…</p>}
      {loadError && <p className="text-sm text-destructive">{loadError}</p>}

      {!loading && !loadError && settings && (
        <Card>
          <CardHeader>
            <CardTitle>Self-heal (M6 Heal)</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-sm text-muted-foreground">
              Scheduled sweep that drives the platform agent to find recent workflow failures and open fix PRs. Cron:{' '}
              <code className="text-foreground">{settings.cron}</code>{' '}
              <Badge variant={settings.scheduleActive ? 'default' : 'secondary'}>
                {settings.scheduleActive ? 'schedule active' : 'schedule absent'}
              </Badge>
            </p>

            <div className="mb-4 flex items-center gap-2">
              <Checkbox
                id="self-heal-enabled"
                checked={enabled}
                disabled={!hasCrudToken}
                onCheckedChange={(value) => {
                  setEnabled(value === true);
                  setDirty(true);
                }}
              />
              <Label htmlFor="self-heal-enabled">Enable self-heal schedule</Label>
            </div>

            {!hasCrudToken && (
              <p className="mb-4 text-sm text-muted-foreground">
                Set the CRUD token on the Projects page to edit this setting.
              </p>
            )}

            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={() => void refresh()} disabled={loading}>
                Reload
              </Button>
              <Button type="button" onClick={() => void handleSave()} disabled={!dirty || saving || !hasCrudToken}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              {dirty && <span className="text-sm text-muted-foreground">(unsaved changes)</span>}
              {savedAt && !dirty && <span className="text-sm text-muted-foreground">(saved {savedAt})</span>}
              {saveError && <span className="text-sm text-destructive">— {saveError}</span>}
            </div>
          </CardContent>
        </Card>
      )}
    </PageShell>
  );
}