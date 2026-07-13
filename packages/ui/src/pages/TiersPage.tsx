import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Pencil, RotateCw, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { listTiers, replaceTiers, type TiersTable } from '../api';
import type { ModelRef } from '@agentops/contracts';
import { PageShell } from '../components/PageShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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

const EMPTY_ENTRY: ModelRef = { backend: 'claude', model: '' };
const ALLOWED_BACKENDS = ['claude', 'cursor', 'pi', 'codex', 'stub', 'litellm', 'platform'] as const;
const ALLOWED_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
// Radix's Select forbids an empty-string item value, so "(default)" is a
// sentinel mapped back to undefined on read/write instead of ModelRef['effort'] itself.
const DEFAULT_EFFORT_SENTINEL = '__default__';

// Deep-clone the tier table into local editable state.
function clone(tiers: TiersTable): TiersTable {
  const out: TiersTable = {};
  for (const [name, entries] of Object.entries(tiers)) {
    out[name] = entries.map((e) => ({ ...e }));
  }
  return out;
}

type TierDialogState = { mode: 'add' } | { mode: 'rename'; oldName: string } | null;

export function TiersPage() {
  const [tiers, setTiers] = useState<TiersTable>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [tierDialog, setTierDialog] = useState<TierDialogState>(null);
  const [tierNameDraft, setTierNameDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

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

  const tierNameTrimmed = tierNameDraft.trim();
  const tierNameCollides =
    tierDialog?.mode === 'add'
      ? Boolean(tiers[tierNameTrimmed])
      : tierDialog?.mode === 'rename'
        ? tierNameTrimmed !== tierDialog.oldName && Boolean(tiers[tierNameTrimmed])
        : false;
  const canSubmitTierDialog = tierNameTrimmed.length > 0 && !tierNameCollides;

  function openAddTierDialog() {
    setTierDialog({ mode: 'add' });
    setTierNameDraft('');
  }

  function openRenameTierDialog(oldName: string) {
    setTierDialog({ mode: 'rename', oldName });
    setTierNameDraft(oldName);
  }

  function confirmTierDialog() {
    if (!tierDialog || !canSubmitTierDialog) return;
    const name = tierNameTrimmed;
    if (tierDialog.mode === 'add') {
      mutate((draft) => {
        if (!draft[name]) draft[name] = [{ ...EMPTY_ENTRY }];
      });
    } else {
      const oldName = tierDialog.oldName;
      mutate((draft) => {
        if (draft[name]) return;
        draft[name] = draft[oldName];
        delete draft[oldName];
      });
    }
    setTierDialog(null);
  }

  function confirmDeleteTier() {
    if (!deleteTarget) return;
    mutate((draft) => {
      delete draft[deleteTarget];
    });
    setDeleteTarget(null);
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await replaceTiers(tiers);
      setTiers(clone(saved));
      setDirty(false);
      setSavedAt(new Date().toLocaleTimeString());
      toast.success('Tiers saved');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'failed to save tiers');
    } finally {
      setSaving(false);
    }
  }

  const tierNames = Object.keys(tiers).sort();

  return (
    <PageShell>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Routing configuration
      </p>
      <div className="mb-2 flex items-start justify-between gap-4">
        <h1 className="text-2xl font-semibold">Model Tiers</h1>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="outline" size="sm" onClick={openAddTierDialog}>
            + Add tier
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            <RotateCw /> Reload
          </Button>
          <Button type="button" size="sm" onClick={() => void handleSave()} disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">
        Ordered model preference lists. Position 0 is the primary; the rest is the session-limit fallback chain
        (the system advances cross-backend on a <code>SessionLimitError</code>). Edits apply to new runs within
        ~60s.
      </p>
      {dirty && <span className="text-sm text-muted-foreground">(unsaved changes)</span>}
      {savedAt && !dirty && <span className="text-sm text-muted-foreground">(saved {savedAt})</span>}
      {saveError && <span className="text-sm text-destructive"> — {saveError}</span>}

      {loading && <p className="mt-4">Loading…</p>}
      {loadError && <p className="mt-4 text-sm text-destructive">Load error: {loadError}</p>}

      {!loading && !loadError && (
        <>
          <div className="my-4 flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
            <Badge>0</Badge>
            <span className="text-muted-foreground">Primary — first choice for new runs</span>
            <Badge variant="outline">1</Badge>
            <span className="text-muted-foreground">Fallback — tried in order on a session limit</span>
            <Badge variant="outline">effort</Badge>
            <span className="text-muted-foreground">Reasoning effort passed to the backend</span>
            <span className="ml-auto text-muted-foreground">{tierNames.length} tiers configured</span>
          </div>

          {tierNames.length === 0 && <p>No tiers configured.</p>}

          <div className="space-y-4">
            {tierNames.map((name) => (
              <Card key={name}>
                <CardHeader className="flex items-center justify-between">
                  <div className="flex items-baseline gap-2">
                    <span className="font-semibold">{name}</span>
                    <span className="text-sm text-muted-foreground">{(tiers[name] ?? []).length} models</span>
                  </div>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => openRenameTierDialog(name)}>
                      <Pencil /> Rename
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => setDeleteTarget(name)}>
                      <Trash2 /> Delete tier
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {(tiers[name] ?? []).map((entry, i) => (
                    <div key={i} className="flex items-end gap-3">
                      <div className="flex w-32 shrink-0 items-center gap-2 pb-2">
                        <Badge variant={i === 0 ? 'default' : 'outline'} className="w-6 shrink-0 justify-center">
                          {i}
                        </Badge>
                        <span className="text-xs font-medium text-muted-foreground">
                          {i === 0 ? 'PRIMARY' : `FALLBACK ${i}`}
                        </span>
                      </div>
                      <div className="flex-1 space-y-1">
                        <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Backend</Label>
                        <Select
                          value={entry.backend}
                          onValueChange={(value) => updateEntry(name, i, { backend: value as ModelRef['backend'] })}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ALLOWED_BACKENDS.map((b) => (
                              <SelectItem key={b} value={b}>
                                {b}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex-[2] space-y-1">
                        <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Model</Label>
                        <Input
                          placeholder="model"
                          value={entry.model}
                          onChange={(e) => updateEntry(name, i, { model: e.target.value })}
                        />
                      </div>
                      <div className="flex-1 space-y-1">
                        <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Effort</Label>
                        <Select
                          value={entry.effort ?? DEFAULT_EFFORT_SENTINEL}
                          onValueChange={(value) =>
                            updateEntry(name, i, {
                              effort: (value === DEFAULT_EFFORT_SENTINEL ? undefined : value) as ModelRef['effort'],
                            })
                          }
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={DEFAULT_EFFORT_SENTINEL}>(default)</SelectItem>
                            {ALLOWED_EFFORTS.map((eff) => (
                              <SelectItem key={eff} value={eff}>
                                {eff}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex shrink-0 gap-1 pb-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => moveEntry(name, i, -1)}
                          disabled={i === 0}
                          title="Move up"
                        >
                          <ChevronUp />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => moveEntry(name, i, 1)}
                          disabled={i === (tiers[name]?.length ?? 0) - 1}
                          title="Move down"
                        >
                          <ChevronDown />
                        </Button>
                        <Button type="button" variant="ghost" size="icon" onClick={() => removeEntry(name, i)} title="Remove">
                          <X />
                        </Button>
                      </div>
                    </div>
                  ))}
                  <Button type="button" variant="ghost" size="sm" onClick={() => addEntry(name)}>
                    + Add fallback model
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>

          <Button type="button" variant="outline" className="mt-4 w-full border-dashed" onClick={openAddTierDialog}>
            + Add tier
          </Button>
        </>
      )}

      <Dialog open={tierDialog !== null} onOpenChange={(open) => !open && setTierDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tierDialog?.mode === 'rename' ? `Rename "${tierDialog.oldName}"` : 'New tier'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="tier-name">Tier name</Label>
            <Input id="tier-name" value={tierNameDraft} onChange={(e) => setTierNameDraft(e.target.value)} autoFocus />
            {tierNameCollides && (
              <p className="text-sm text-destructive">A tier named "{tierNameTrimmed}" already exists.</p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setTierDialog(null)}>
              Cancel
            </Button>
            <Button type="button" disabled={!canSubmitTierDialog} onClick={confirmTierDialog}>
              {tierDialog?.mode === 'rename' ? 'Rename' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete tier "{deleteTarget}"?</AlertDialogTitle>
            <AlertDialogDescription>This can't be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeleteTier}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  );
}