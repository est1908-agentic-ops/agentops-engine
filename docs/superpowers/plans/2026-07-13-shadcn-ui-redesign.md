# shadcn/ui Redesign of `packages/ui` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `packages/ui` from hand-rolled CSS to shadcn/ui (Tailwind v4 + Radix primitives), pixel-matching the Model Tiers page to the approved mockup and restyling every other page with the same primitive vocabulary, with zero behavior/API changes.

**Architecture:** Add Tailwind + shadcn/ui to `packages/ui` only (scoped to this package, not the monorepo root). Both the legacy stylesheets and the new Tailwind/shadcn setup coexist until every page has been migrated, so the app keeps building and running after every task; the legacy CSS is deleted in the second-to-last task once nothing references it.

**Tech Stack:** Tailwind CSS v4 (`@tailwindcss/vite`), shadcn/ui CLI (`nova` preset, Radix-based), `lucide-react` icons, `sonner` toasts. React 19 + Vite 6 + TypeScript 6 (unchanged).

**Spec:** `docs/superpowers/specs/2026-07-13-shadcn-ui-redesign-design.md`

---

## Before you start

All commands below assume the repo root as your working directory (`/Users/est1908/.superset/worktrees/ebad4cb3-db7d-4930-aad4-12f443c10254/green-puppet` or wherever this worktree lives) and `pnpm` as the package manager, per `AGENTS.md`.

**A note on the shadcn CLI**, confirmed by an actual trial run against a scratch copy of this package before this plan was written:
- The installed CLI (`npx shadcn@latest`) is a newer, **preset-based** version — it does not use the classic "style: new-york / base color: slate" prompt. It requires Tailwind + a working `@/*` import alias to exist *before* `init` runs (Task 1), then `init` (Task 2) just detects them, writes `components.json`, and drops in the generated theme.
- **This repo pins `typescript@^6.0.3`, which has removed the `baseUrl` compiler option** (`error TS5102: Option 'baseUrl' has been removed`). Do **not** add `baseUrl` to `tsconfig.json` — a bare `paths` map resolves correctly under `moduleResolution: "Bundler"` without it. This was confirmed by actually compiling generated shadcn components against `typescript@6.0.3` in the trial.

---

### Task 1: Tailwind + path-alias prerequisites

**Files:**
- Modify: `packages/ui/package.json`
- Create: `packages/ui/src/index.css`
- Modify: `packages/ui/src/main.tsx`
- Modify: `packages/ui/vite.config.ts`
- Modify: `packages/ui/tsconfig.json`

- [ ] **Step 1: Add the Tailwind build dependencies**

```bash
pnpm --filter @agentops/ui add -D tailwindcss @tailwindcss/vite @types/node
```

- [ ] **Step 2: Create the Tailwind entry stylesheet**

Create `packages/ui/src/index.css`:

```css
@import "tailwindcss";
```

- [ ] **Step 3: Import it alongside the legacy stylesheet**

The legacy `styles.css` stays imported until every page is migrated (Task 13 removes it). Modify `packages/ui/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import './styles.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 4: Wire the Tailwind Vite plugin and the `@/*` alias**

Replace `packages/ui/vite.config.ts`:

```ts
import path from 'path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
```

- [ ] **Step 5: Add the `@/*` path mapping to tsconfig — no `baseUrl`**

Replace `packages/ui/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": false,
    "declaration": false,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "types": ["vite/client"],
    "noEmit": true,
    "rootDir": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src", "vite.config.ts"]
}
```

- [ ] **Step 6: Verify it typechecks and builds**

```bash
pnpm --filter @agentops/ui typecheck
pnpm --filter @agentops/ui build
```
Expected: both succeed (no page code has changed yet, so this only proves the new tooling doesn't break the existing app).

- [ ] **Step 7: Commit**

```bash
git add packages/ui/package.json packages/ui/src/index.css packages/ui/src/main.tsx packages/ui/vite.config.ts packages/ui/tsconfig.json pnpm-lock.yaml
git commit -m "chore(ui): add Tailwind CSS and the @/* import alias"
```

---

### Task 2: Run shadcn init (`nova` preset)

**Files:**
- Create: `packages/ui/components.json`
- Create: `packages/ui/src/lib/utils.ts`
- Create: `packages/ui/src/components/ui/button.tsx`
- Modify: `packages/ui/src/index.css` (rewritten by the CLI)
- Modify: `packages/ui/package.json` (new dependencies added by the CLI)

- [ ] **Step 1: Run init**

```bash
npx shadcn@latest init -t vite -b radix -p nova -c packages/ui -y
```
Expected output: `Writing components.json`, `Created 2 files: src/components/ui/button.tsx, src/lib/utils.ts`, `Updating src/index.css`, ending in `Project initialization completed.`

If the CLI's own dependency-install step fails inside the pnpm workspace (it may not correctly detect `pnpm` two directories up), install what it listed manually and re-run with `--force`:
```bash
pnpm --filter @agentops/ui add class-variance-authority clsx tailwind-merge lucide-react radix-ui tw-animate-css @fontsource-variable/geist shadcn
npx shadcn@latest init -t vite -b radix -p nova -c packages/ui -y --force
```

- [ ] **Step 2: Verify the generated config**

```bash
cat packages/ui/components.json
```
Expected: `"style": "radix-nova"`, `"baseColor": "neutral"`, `"iconLibrary": "lucide"`, `"aliases": { "components": "@/components", "utils": "@/lib/utils", ... }`.

- [ ] **Step 3: Reconcile the workspace lockfile**

```bash
pnpm install
```
Expected: no errors; `pnpm-lock.yaml` picks up the new dependencies (`class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `radix-ui`, `tw-animate-css`, `@fontsource-variable/geist`, `shadcn`).

- [ ] **Step 4: Verify it still typechecks and builds**

```bash
pnpm --filter @agentops/ui typecheck
pnpm --filter @agentops/ui build
```
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/components.json packages/ui/src/lib/utils.ts packages/ui/src/components/ui/button.tsx packages/ui/src/index.css packages/ui/package.json pnpm-lock.yaml
git commit -m "chore(ui): initialize shadcn/ui (nova preset)"
```

---

### Task 3: Override the primary color to the app's existing blue

**Files:**
- Modify: `packages/ui/src/index.css`

The generated theme defaults `--primary` to near-black. Override it to the app's existing accent blue (today's `.run-button`/link color, and the mockup's Save button / primary-tier badge color) so the migration doesn't shift brand color.

- [ ] **Step 1: Edit the `:root` block**

In `packages/ui/src/index.css`, find the `:root { ... }` block the CLI generated (it starts with `--background: oklch(1 0 0);`) and change these two lines:

```css
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
```
to:
```css
  --primary: #2563eb;
  --primary-foreground: #ffffff;
```
Leave the `.dark` block's `--primary` untouched — it's unused in this pass (no dark-mode toggle is wired up, per the spec).

- [ ] **Step 2: Verify visually**

```bash
pnpm --filter @agentops/ui dev
```
Open the printed local URL, open the browser devtools console, and confirm no errors. (No page uses `bg-primary`/`text-primary` yet, so there's nothing to see color-wise until Task 5 — this step just confirms the dev server still boots.) Stop the server (Ctrl-C) when done.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/index.css
git commit -m "style(ui): set shadcn primary color to the app's existing blue"
```

---

### Task 4: Add the remaining shadcn primitives

**Files:**
- Create: `packages/ui/src/components/ui/card.tsx`
- Create: `packages/ui/src/components/ui/input.tsx`
- Create: `packages/ui/src/components/ui/select.tsx`
- Create: `packages/ui/src/components/ui/table.tsx`
- Create: `packages/ui/src/components/ui/badge.tsx`
- Create: `packages/ui/src/components/ui/label.tsx`
- Create: `packages/ui/src/components/ui/textarea.tsx`
- Create: `packages/ui/src/components/ui/checkbox.tsx`
- Create: `packages/ui/src/components/ui/dialog.tsx`
- Create: `packages/ui/src/components/ui/alert-dialog.tsx`
- Create: `packages/ui/src/components/ui/sonner.tsx`
- Modify: `packages/ui/package.json` (adds `sonner`, `next-themes`)

- [ ] **Step 1: Add the components**

```bash
npx shadcn@latest add card input select table badge label textarea dialog alert-dialog checkbox sonner -c packages/ui -y
```
Expected: `Created 11 files` listing each of the files above (button.tsx already exists from Task 2 and is skipped).

- [ ] **Step 2: Reconcile the lockfile**

```bash
pnpm install
```

- [ ] **Step 3: Verify it typechecks and builds**

```bash
pnpm --filter @agentops/ui typecheck
pnpm --filter @agentops/ui build
```

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/ui packages/ui/package.json pnpm-lock.yaml
git commit -m "chore(ui): add card, input, select, table, badge, label, textarea, checkbox, dialog, alert-dialog, sonner"
```

---

### Task 5: App shell — nav, page container, toast mount

**Files:**
- Create: `packages/ui/src/components/PageShell.tsx`
- Modify: `packages/ui/src/App.tsx`

- [ ] **Step 1: Add the shared page container**

Create `packages/ui/src/components/PageShell.tsx` — the Tailwind replacement for today's `.page` class, used by every page from here on:

```tsx
import type { ReactNode } from 'react';

export function PageShell({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-3xl px-4 py-8 pb-16">{children}</div>;
}
```

- [ ] **Step 2: Rebuild the app shell**

Replace `packages/ui/src/App.tsx` — same route set and nav links as today (`ff277cb` already trimmed it to Projects/Chat/Tiers/Settings), restyled, plus the `<Toaster />` mount for `sonner` (used first by `TiersPage` in Task 7):

```tsx
import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom';
import { Toaster } from '@/components/ui/sonner';
import { DevCycleRunDetailPage } from './pages/DevCycleRunDetailPage';
import { HomePage } from './pages/HomePage';
import { ProjectsPage } from './pages/ProjectsPage';
import { RunDetailPage } from './pages/RunDetailPage';
import { ChatPage } from './pages/ChatPage';
import { ChatStartPage } from './pages/ChatStartPage';
import { TiersPage } from './pages/TiersPage';
import { SettingsPage } from './pages/SettingsPage';

const NAV_LINKS = [
  { to: '/projects', label: 'Projects' },
  { to: '/chat', label: 'Chat' },
  { to: '/tiers', label: 'Tiers' },
  { to: '/settings', label: 'Settings' },
];

export function App() {
  return (
    <BrowserRouter>
      <Toaster />
      <header className="border-b bg-background">
        <nav className="mx-auto flex max-w-3xl items-center gap-6 px-4 py-3">
          <span className="text-sm font-semibold">Agentic Ops</span>
          <div className="flex gap-4">
            {NAV_LINKS.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                className={({ isActive }) =>
                  `text-sm font-medium transition-colors ${
                    isActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                  }`
                }
              >
                {link.label}
              </NavLink>
            ))}
          </div>
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/runs/:workflowId" element={<RunDetailPage />} />
        <Route path="/dev-runs/:workflowId" element={<DevCycleRunDetailPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/chat" element={<ChatStartPage />} />
        <Route path="/chats/:chatId" element={<ChatPage />} />
        <Route path="/tiers" element={<TiersPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </BrowserRouter>
  );
}
```

- [ ] **Step 3: Verify it typechecks**

```bash
pnpm --filter @agentops/ui typecheck
```
Expected: fails here — the page files still return `<div className="page">`, not `<PageShell>`, which is fine and expected (unchanged, not yet migrated); this step only needs to confirm `App.tsx` and `PageShell.tsx` themselves have no type errors. If the compiler surfaces unrelated pre-existing page errors, ignore them; they're resolved page-by-page starting in Task 6.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/App.tsx packages/ui/src/components/PageShell.tsx
git commit -m "feat(ui): rebuild app shell nav on shadcn, mount sonner Toaster"
```

---

### Task 6: Rebuild `StatusBadge`

**Files:**
- Modify: `packages/ui/src/components/StatusBadge.tsx`

- [ ] **Step 1: Replace the raw span with shadcn's `Badge`**

The seven-status color map has no shadcn variant equivalent, so it's kept as an inline `style` override (inline styles always win over the class-based background, regardless of Tailwind specificity):

```tsx
import type { RunStatus } from '@agentops/contracts';
import { Badge } from '@/components/ui/badge';

const STATUS_COLORS: Record<RunStatus, string> = {
  RUNNING: '#2563eb',
  COMPLETED: '#16a34a',
  FAILED: '#dc2626',
  CANCELLED: '#d97706',
  TERMINATED: '#dc2626',
  TIMED_OUT: '#dc2626',
  CONTINUED_AS_NEW: '#2563eb',
};

export function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <Badge className="border-transparent text-white" style={{ backgroundColor: STATUS_COLORS[status] }}>
      {status}
    </Badge>
  );
}
```

- [ ] **Step 2: Verify it typechecks**

```bash
pnpm --filter @agentops/ui typecheck
```
Expected: no new errors from this file (consumers — `HomePage`, `RunDetailPage`, `DevCycleRunDetailPage` — are migrated in later tasks and may still show their own pre-existing errors until then).

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/StatusBadge.tsx
git commit -m "feat(ui): rebuild StatusBadge on shadcn Badge"
```

---

### Task 7: Rebuild the Model Tiers page (pixel-matched to the mockup)

**Files:**
- Modify: `packages/ui/src/pages/TiersPage.tsx`

State model, `clone`/`mutate` pattern, and the `listTiers`/`replaceTiers` calls are unchanged — only rendering changes, plus: `window.prompt` (add/rename tier) becomes a controlled `Dialog` with disabled-until-valid submit (same collision rule as today, now with inline helper text instead of a silent no-op — the same pattern `ProjectForm` already uses elsewhere), `window.confirm` (delete tier) becomes an `AlertDialog`, and a `sonner` toast fires on successful save (additive, alongside the existing inline "(saved …)" text).

- [ ] **Step 1: Replace the file**

```tsx
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
```

- [ ] **Step 2: Verify it typechecks**

```bash
pnpm --filter @agentops/ui typecheck
```
Expected: no errors from `TiersPage.tsx`.

- [ ] **Step 3: Manually verify in the browser**

```bash
pnpm --filter @agentops/ui dev
```
Against a running backend (or the `stub` backend), open `/tiers` and check: existing tiers render as cards with the legend strip above them; add a tier (dialog, disabled submit on blank/collision, inline error text on collision); rename a tier the same way; add/reorder/remove a model row; delete a tier (alert dialog); Save shows the dirty/saved state and fires a toast. Stop the server when done.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/pages/TiersPage.tsx
git commit -m "feat(ui): rebuild Model Tiers page on shadcn, matching the design mockup"
```

---

### Task 8: Rebuild the Home/Console page

**Files:**
- Modify: `packages/ui/src/pages/HomePage.tsx`

All state, effects, and `handleRun` logic are unchanged — only the returned JSX changes.

- [ ] **Step 1: Replace the file**

```tsx
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { DevCycleTarget, RunListItem } from '@agentops/contracts';
import { listDevCycleRuns, listDevCycleTargets, listRepos, listRuns, startDevCycleRun, startRun } from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { PageShell } from '../components/PageShell';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const SUGGESTED_PROMPTS = [
  'Check recent failed workflows — anything strange?',
  'Investigate the last workflow failures and propose fixes',
  'Check cluster pod health in dev-agents',
];

const PLATFORM_TARGET = 'platform';

interface ConsoleRun {
  kind: 'platform' | 'devcycle';
  run: RunListItem;
}

export function HomePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [prompt, setPrompt] = useState('');
  const [target, setTarget] = useState(PLATFORM_TARGET);
  const [targets, setTargets] = useState<DevCycleTarget[]>([]);
  const [hintReposText, setHintReposText] = useState('');
  const [repoSuggestions, setRepoSuggestions] = useState<string[]>([]);
  const [runs, setRuns] = useState<ConsoleRun[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listRepos()
      .then(setRepoSuggestions)
      .catch(() => setRepoSuggestions([]));
    listDevCycleTargets()
      .then(setTargets)
      .catch(() => setTargets([]));

    Promise.allSettled([listRuns(), listDevCycleRuns()])
      .then(([platformRuns, devcycleRuns]) => {
        const merged: ConsoleRun[] = [
          ...(platformRuns.status === 'fulfilled'
            ? platformRuns.value.map((run) => ({ kind: 'platform' as const, run }))
            : []),
          ...(devcycleRuns.status === 'fulfilled'
            ? devcycleRuns.value.map((run) => ({ kind: 'devcycle' as const, run }))
            : []),
        ];
        merged.sort((a, b) => new Date(b.run.startTime).getTime() - new Date(a.run.startTime).getTime());
        setRuns(merged);
      })
      .catch(() => setRuns([]));
  }, []);

  useEffect(() => {
    const requested = searchParams.get('target');
    if (requested) {
      setTarget(requested);
    }
  }, [searchParams]);

  const isPlatformTarget = target === PLATFORM_TARGET;
  const knownTarget = isPlatformTarget || targets.some((candidate) => candidate.repo === target);
  const canSubmit = prompt.trim().length > 0 && !submitting;

  async function handleRun() {
    setSubmitting(true);
    setError(null);
    try {
      if (isPlatformTarget) {
        const hintRepos = hintReposText
          .split(',')
          .map((repo) => repo.trim())
          .filter(Boolean);
        const { workflowId } = await startRun({
          prompt: prompt.trim(),
          hintRepos: hintRepos.length > 0 ? hintRepos : undefined,
        });
        navigate(`/runs/${workflowId}`);
      } else {
        const { workflowId } = await startDevCycleRun({ repo: target, prompt: prompt.trim() });
        navigate(`/dev-runs/${workflowId}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to start run');
      setSubmitting(false);
    }
  }

  return (
    <PageShell>
      <h1 className="mb-6 text-2xl font-semibold">Platform Console</h1>

      <div className="mb-4 space-y-1.5">
        <Label htmlFor="target">Target</Label>
        <Select value={target} onValueChange={setTarget}>
          <SelectTrigger id="target" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={PLATFORM_TARGET}>Platform agent</SelectItem>
            {targets.map((candidate) => (
              <SelectItem key={candidate.repo} value={candidate.repo}>
                {candidate.project} ({candidate.repo})
              </SelectItem>
            ))}
            {!knownTarget && <SelectItem value={target}>{target}</SelectItem>}
          </SelectContent>
        </Select>
      </div>

      <div className="mb-4 space-y-1.5">
        <Label htmlFor="prompt">
          {isPlatformTarget
            ? 'What should the platform agent investigate?'
            : `What should the dev agent build in ${target}?`}
        </Label>
        <Textarea id="prompt" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </div>

      {isPlatformTarget && (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            {SUGGESTED_PROMPTS.map((suggestion) => (
              <Button
                key={suggestion}
                type="button"
                variant="secondary"
                size="sm"
                className="rounded-full"
                onClick={() => setPrompt(suggestion)}
              >
                {suggestion}
              </Button>
            ))}
          </div>

          <div className="mb-4 space-y-1.5">
            <Label htmlFor="hint-repos">Hint repos (optional)</Label>
            <Input
              id="hint-repos"
              placeholder="owner/repo, owner/repo2"
              value={hintReposText}
              onChange={(e) => setHintReposText(e.target.value)}
              list="repo-suggestions"
            />
            <datalist id="repo-suggestions">
              {repoSuggestions.map((repo) => (
                <option key={repo} value={repo} />
              ))}
            </datalist>
          </div>
        </>
      )}

      <div className="mt-5">
        <Button type="button" disabled={!canSubmit} onClick={handleRun}>
          {submitting ? 'Starting…' : 'Run'}
        </Button>
      </div>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

      <h2 className="mb-3 mt-10 text-base font-semibold">Recent runs</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Status</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Prompt</TableHead>
            <TableHead>Started</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map(({ kind, run }) => (
            <TableRow key={run.workflowId}>
              <TableCell>
                <StatusBadge status={run.status} />
              </TableCell>
              <TableCell>{kind === 'platform' ? 'platform' : 'dev cycle'}</TableCell>
              <TableCell>{run.promptSnippet ?? run.workflowId}</TableCell>
              <TableCell>{new Date(run.startTime).toLocaleString()}</TableCell>
              <TableCell>
                <Link
                  className="text-primary underline underline-offset-2"
                  to={kind === 'platform' ? `/runs/${run.workflowId}` : `/dev-runs/${run.workflowId}`}
                >
                  Open
                </Link>
              </TableCell>
            </TableRow>
          ))}
          {runs.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-muted-foreground">
                No runs yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </PageShell>
  );
}
```

- [ ] **Step 2: Verify it typechecks**

```bash
pnpm --filter @agentops/ui typecheck
```

- [ ] **Step 3: Manually verify in the browser**

Open `/`: switch target between "Platform agent" and a dev target, type a prompt, click a suggested-prompt chip, start a run, confirm the recent-runs table renders with `StatusBadge`s.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/pages/HomePage.tsx
git commit -m "feat(ui): rebuild Home/Console page on shadcn"
```

---

### Task 9: Rebuild the Projects page

**Files:**
- Modify: `packages/ui/src/pages/ProjectsPage.tsx`

All types, `buildUpdatePayload`, and the create/update/list logic are unchanged. `window.confirm` on remove becomes a controlled `AlertDialog`.

- [ ] **Step 1: Replace the file**

```tsx
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
```

- [ ] **Step 2: Verify it typechecks**

```bash
pnpm --filter @agentops/ui typecheck
```

- [ ] **Step 3: Manually verify in the browser**

Open `/projects` with no CRUD token set (confirm the token-gate card), paste a token, create a GitHub project, create a Linear project (confirm the conditional fields), edit a project (confirm Save stays disabled until a real change), remove a project (confirm the alert dialog).

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/pages/ProjectsPage.tsx
git commit -m "feat(ui): rebuild Projects page on shadcn"
```

---

### Task 10: Rebuild the Chat pages

**Files:**
- Modify: `packages/ui/src/pages/ChatStartPage.tsx`
- Modify: `packages/ui/src/pages/ChatPage.tsx`

Bubble/proposal colors from `chat.css` are ported to Tailwind utility classes directly on the JSX (no new stylesheet). `chat.css` itself is deleted in Task 13 once nothing imports it.

- [ ] **Step 1: Replace `ChatStartPage.tsx`**

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { startChat } from '../api';
import { PageShell } from '../components/PageShell';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export function ChatStartPage() {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function start() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { chatId } = await startChat({ prompt: prompt.trim() || undefined });
      navigate(`/chats/${encodeURIComponent(chatId)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to start chat');
      setBusy(false);
    }
  }

  return (
    <PageShell>
      <h1 className="mb-6 text-2xl font-semibold">Chat with the platform agent</h1>
      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Optional: start with a question or task…"
        className="min-h-24"
      />
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      <Button type="button" className="mt-4" disabled={busy} onClick={() => void start()}>
        {busy ? 'Starting…' : 'Start chat'}
      </Button>
    </PageShell>
  );
}
```

- [ ] **Step 2: Replace `ChatPage.tsx`**

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import { useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ConversationState } from '@agentops/contracts';
import { closeChat, getChat, sendChatDecision, sendChatTurn } from '../api';
import { PageShell } from '../components/PageShell';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';

const POLL_INTERVAL_MS = 2500;
const MARKDOWN_COMPONENTS = {
  a: (props: ComponentPropsWithoutRef<'a'>) => <a {...props} target="_blank" rel="noreferrer" />,
};

const BUBBLE_STYLES: Record<ConversationState['messages'][number]['role'], string> = {
  user: 'self-end bg-blue-100',
  agent: 'self-start bg-muted',
  system: 'self-center bg-transparent text-sm italic text-muted-foreground',
};

export function ChatPage() {
  const { chatId } = useParams<{ chatId: string }>();
  const [state, setState] = useState<ConversationState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!chatId) return undefined;
    let cancelled = false;
    async function poll() {
      try {
        const next = await getChat(chatId!);
        if (cancelled) return;
        setError(null);
        setState((prev) =>
          next.phase === 'closed' && prev && prev.messages.length > next.messages.length
            ? { ...prev, phase: 'closed', pendingProposal: undefined }
            : next,
        );
        if (next.phase === 'closed') stop();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'failed to load chat');
      }
    }
    void poll();
    intervalRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      stop();
    };
  }, [chatId, stop]);

  async function submitTurn() {
    if (!chatId || !draft.trim() || busy) return;
    setBusy(true);
    try {
      await sendChatTurn(chatId, draft.trim());
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to send');
    } finally {
      setBusy(false);
    }
  }

  async function decide(approve: boolean) {
    if (!chatId || !state?.pendingProposal || busy) return;
    setBusy(true);
    try {
      await sendChatDecision(chatId, { proposalId: state.pendingProposal.id, approve });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to send decision');
    } finally {
      setBusy(false);
    }
  }

  if (!state) {
    return (
      <PageShell>
        <a href="/chat" className="text-sm text-muted-foreground">
          ← Back
        </a>
        {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : <p className="mt-2">Loading…</p>}
      </PageShell>
    );
  }

  const closed = state.phase === 'closed';
  return (
    <PageShell>
      <a href="/chat" className="text-sm text-muted-foreground">
        ← Back
      </a>
      <div className="mb-2 mt-3 flex items-center gap-3">
        <span className="font-mono text-sm text-muted-foreground">{state.chatId}</span>
        <span className="text-sm">{state.phase}</span>
        {!closed && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => chatId && void closeChat(chatId)}>
            End chat
          </Button>
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="my-4 flex flex-col gap-3">
        {state.messages.map((m) => (
          <div key={m.seq} className={`max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 ${BUBBLE_STYLES[m.role]}`}>
            {m.role === 'agent' ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                {m.text}
              </ReactMarkdown>
            ) : (
              m.text
            )}
          </div>
        ))}
        {state.phase === 'agent-thinking' && <div className="italic text-muted-foreground">agent is working…</div>}
        {state.pendingProposal && (
          <Card className="self-start border-amber-500 bg-amber-50">
            <CardContent className="pt-4">
              <p className="font-semibold">Proposed: {state.pendingProposal.type}</p>
              <p>{state.pendingProposal.reason}</p>
              {state.pendingProposal.workflowId && <p>workflow: {state.pendingProposal.workflowId}</p>}
              {state.pendingProposal.repo && <p>repo: {state.pendingProposal.repo}</p>}
              <div className="mt-2 flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => void decide(true)}>
                  Approve
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide(false)}>
                  Reject
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {!closed && !state.pendingProposal && (
        <div className="mt-2 flex gap-2">
          <Textarea
            className="min-h-12"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={state.phase === 'awaiting-answer' ? 'Answer the agent…' : 'Message the agent…'}
          />
          <Button disabled={busy || !draft.trim()} onClick={() => void submitTurn()}>
            Send
          </Button>
        </div>
      )}
    </PageShell>
  );
}
```

- [ ] **Step 3: Verify it typechecks**

```bash
pnpm --filter @agentops/ui typecheck
```

- [ ] **Step 4: Manually verify in the browser**

Start a chat with an initial prompt, send a follow-up turn, and (against the `stub` backend, which can be scripted to emit a question/proposal) confirm the answer-a-question and approve/reject-a-proposal flows render correctly.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/pages/ChatStartPage.tsx packages/ui/src/pages/ChatPage.tsx
git commit -m "feat(ui): rebuild Chat pages on shadcn"
```

---

### Task 11: Rebuild the Settings page

**Files:**
- Modify: `packages/ui/src/pages/SettingsPage.tsx`

- [ ] **Step 1: Replace the file**

```tsx
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
```

- [ ] **Step 2: Verify it typechecks**

```bash
pnpm --filter @agentops/ui typecheck
```

- [ ] **Step 3: Manually verify in the browser**

Open `/settings`, toggle the checkbox (confirm it's disabled without a CRUD token), Save, confirm the dirty/saved states.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/pages/SettingsPage.tsx
git commit -m "feat(ui): rebuild Settings page on shadcn"
```

---

### Task 12: Rebuild the run-detail pages

**Files:**
- Modify: `packages/ui/src/pages/RunDetailPage.tsx`
- Modify: `packages/ui/src/pages/DevCycleRunDetailPage.tsx`

- [ ] **Step 1: Replace `RunDetailPage.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import { useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { RunDetail } from '@agentops/contracts';
import { getRun, siblingTemporalUrl } from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { PageShell } from '../components/PageShell';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const POLL_INTERVAL_MS = 3000;

const MARKDOWN_COMPONENTS = {
  a: (props: ComponentPropsWithoutRef<'a'>) => <a {...props} target="_blank" rel="noreferrer" />,
};

export function RunDetailPage() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!workflowId) {
      return undefined;
    }

    let cancelled = false;

    async function poll() {
      try {
        const detail = await getRun(workflowId!);
        if (cancelled) {
          return;
        }
        setRun(detail);
        setError(null);
        if (detail.status !== 'RUNNING' && intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'failed to load run');
        }
      }
    }

    void poll();
    intervalRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [workflowId]);

  if (error) {
    return (
      <PageShell>
        <p className="text-sm text-destructive">{error}</p>
      </PageShell>
    );
  }
  if (!run) {
    return (
      <PageShell>
        <p>Loading…</p>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <a href="/" className="text-sm text-muted-foreground">
        ← Back
      </a>
      <div className="mb-6 mt-3 flex items-center gap-3">
        <StatusBadge status={run.status} />
        <span className="font-mono text-sm text-muted-foreground">{run.workflowId}</span>
        <a className="ml-auto text-sm text-primary" href={run.temporalUrl} target="_blank" rel="noreferrer">
          Open in Temporal ↗
        </a>
      </div>

      {run.prompt && (
        <div className="mb-5">
          <Label className="mb-1 block">Prompt</Label>
          <p className="whitespace-pre-wrap">{run.prompt}</p>
        </div>
      )}

      {run.error && (
        <Card className="mb-5 border-destructive/50 bg-destructive/5">
          <CardContent className="pt-4">
            <Label className="mb-1 block">Error</Label>
            <p>{run.error}</p>
          </CardContent>
        </Card>
      )}

      {run.result && (
        <>
          <div className="mb-5">
            <Label className="mb-1 block">Summary</Label>
            <div className="rounded-md border bg-card p-4 text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                {run.result.summary}
              </ReactMarkdown>
            </div>
          </div>

          {run.result.actionsTaken.length > 0 && (
            <div className="mb-5">
              <Label className="mb-1 block">Actions taken</Label>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Workflow</TableHead>
                    <TableHead>Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {run.result.actionsTaken.map((action, index) => (
                    <TableRow key={index}>
                      <TableCell>{action.type}</TableCell>
                      <TableCell>
                        <a
                          className="text-primary"
                          href={siblingTemporalUrl(run.temporalUrl, action.workflowId)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {action.workflowId}
                        </a>
                      </TableCell>
                      <TableCell>{action.reason}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {run.result.childWorkflows.length > 0 && (
            <div>
              <Label className="mb-1 block">Child workflows</Label>
              <div className="flex flex-wrap gap-3">
                {run.result.childWorkflows.map((child) => (
                  <Card key={child.workflowId} className="w-56">
                    <CardContent className="pt-4">
                      <p className="mb-1 text-sm font-semibold">{child.repo}</p>
                      <p className="mb-2 text-sm text-muted-foreground">{child.goal}</p>
                      <a
                        className="text-sm text-primary"
                        href={siblingTemporalUrl(run.temporalUrl, child.workflowId)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {child.workflowId} ↗
                      </a>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </PageShell>
  );
}
```

- [ ] **Step 2: Replace `DevCycleRunDetailPage.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { DevCycleRunDetail } from '@agentops/contracts';
import { getDevCycleRun } from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { PageShell } from '../components/PageShell';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';

const POLL_INTERVAL_MS = 3000;

const BLOCK_REASON_HINTS: Record<string, string> = {
  'unregistered-repo':
    'The worker does not know this repo. It may have been registered in the console after the worker last restarted — check the registration, or restart the worker so it reloads the managed registry.',
};

export function DevCycleRunDetailPage() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const [run, setRun] = useState<DevCycleRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!workflowId) {
      return undefined;
    }

    let cancelled = false;

    async function poll() {
      try {
        const detail = await getDevCycleRun(workflowId!);
        if (cancelled) {
          return;
        }
        setRun(detail);
        setError(null);
        if (detail.status !== 'RUNNING' && intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'failed to load run');
        }
      }
    }

    void poll();
    intervalRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [workflowId]);

  if (error) {
    return (
      <PageShell>
        <p className="text-sm text-destructive">{error}</p>
      </PageShell>
    );
  }
  if (!run) {
    return (
      <PageShell>
        <p>Loading…</p>
      </PageShell>
    );
  }

  const blockReasonHint = run.state?.blockReason ? BLOCK_REASON_HINTS[run.state.blockReason] : undefined;

  return (
    <PageShell>
      <a href="/" className="text-sm text-muted-foreground">
        ← Back
      </a>
      <div className="mb-6 mt-3 flex items-center gap-3">
        <StatusBadge status={run.status} />
        <span className="font-mono text-sm text-muted-foreground">{run.workflowId}</span>
        <a className="ml-auto text-sm text-primary" href={run.temporalUrl} target="_blank" rel="noreferrer">
          Open in Temporal ↗
        </a>
      </div>

      {run.prompt && (
        <div className="mb-5">
          <Label className="mb-1 block">Prompt</Label>
          <p className="whitespace-pre-wrap">{run.prompt}</p>
        </div>
      )}

      {run.error && (
        <div className="mb-5 rounded-md border border-destructive/50 bg-destructive/5 p-4">
          <Label className="mb-1 block">Error</Label>
          <p>{run.error}</p>
        </div>
      )}

      {run.state && (
        <div>
          <Label className="mb-1 block">Dev cycle state</Label>
          <Table>
            <TableBody>
              <TableRow>
                <TableCell className="w-40 font-medium">Stage</TableCell>
                <TableCell>{run.state.stage}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Task status</TableCell>
                <TableCell>{run.state.status}</TableCell>
              </TableRow>
              {run.state.blockReason && (
                <TableRow>
                  <TableCell className="font-medium">Block reason</TableCell>
                  <TableCell>
                    {run.state.blockReason}
                    {blockReasonHint && <p className="mt-1 text-sm text-muted-foreground">{blockReasonHint}</p>}
                  </TableCell>
                </TableRow>
              )}
              {run.state.prRef && (
                <TableRow>
                  <TableCell className="font-medium">PR</TableCell>
                  <TableCell>{run.state.prRef}</TableCell>
                </TableRow>
              )}
              <TableRow>
                <TableCell className="font-medium">Implement attempts</TableCell>
                <TableCell>{run.state.implementAttempts}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Babysit rounds</TableCell>
                <TableCell>{run.state.babysitRounds}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Tokens</TableCell>
                <TableCell>{run.state.cumulativeTokens.toLocaleString()}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      )}
    </PageShell>
  );
}
```

- [ ] **Step 3: Verify it typechecks**

```bash
pnpm --filter @agentops/ui typecheck
```

- [ ] **Step 4: Manually verify in the browser**

Open an existing run at `/runs/:workflowId` and a dev-cycle run at `/dev-runs/:workflowId`; confirm the header, prompt/error sections, summary markdown, actions-taken table, child-workflow cards (run detail), and the key/value state table (dev-cycle detail) all render.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/pages/RunDetailPage.tsx packages/ui/src/pages/DevCycleRunDetailPage.tsx
git commit -m "feat(ui): rebuild run-detail pages on shadcn"
```

---

### Task 13: Remove the legacy stylesheets

**Files:**
- Delete: `packages/ui/src/styles.css`
- Delete: `packages/ui/src/chat.css`
- Modify: `packages/ui/src/main.tsx`

Every page now renders through `PageShell` + shadcn primitives, so nothing references the old classnames.

- [ ] **Step 1: Confirm nothing still references the legacy classnames**

```bash
grep -rn 'className="page"\|className="section"\|className="card"\|status-badge\|chat-log\|chat-msg\|chat-composer\|chat-proposal\|chat-thinking' packages/ui/src
```
Expected: no matches (every page was migrated in Tasks 5–12).

- [ ] **Step 2: Drop the imports and delete the files**

```tsx
// packages/ui/src/main.tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('root element not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

```bash
rm packages/ui/src/styles.css packages/ui/src/chat.css
```

- [ ] **Step 3: Verify it typechecks and builds**

```bash
pnpm --filter @agentops/ui typecheck
pnpm --filter @agentops/ui build
```

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/main.tsx
git rm packages/ui/src/styles.css packages/ui/src/chat.css
git commit -m "chore(ui): remove legacy hand-rolled stylesheets"
```

---

### Task 14: Full manual verification pass

**Files:** none (verification only).

Per the spec's testing section — `packages/ui` has no automated test suite and this migration doesn't add one, so this pass is the acceptance check.

- [ ] **Step 1: Run the full local check**

```bash
pnpm lint && pnpm typecheck && pnpm test
```
Expected: all green.

- [ ] **Step 2: Walk every page in the browser**

```bash
pnpm --filter @agentops/ui dev
```
Against a running backend (or the `stub` backend), confirm end-to-end for each page:
- **Tiers** (`/tiers`): add/rename/delete a tier; add/reorder/remove a model row; Save shows dirty/saved state and a toast.
- **Projects** (`/projects`): token gate; create/edit/delete a GitHub project; create a Linear project (conditional fields); delete confirmation dialog.
- **Chat** (`/chat` → `/chats/:chatId`): start a chat, send a turn, answer a question, approve/reject a proposal, end the chat.
- **Settings** (`/settings`): toggle + save the self-heal checkbox.
- **Home** (`/`): switch target, use a suggested prompt, start a run, see it in the recent-runs table.
- **Run detail** (`/runs/:workflowId`, `/dev-runs/:workflowId`): open an existing run of each kind.

- [ ] **Step 3: Fix anything found, then commit**

If the walkthrough surfaces a real bug (not just a cosmetic Tailwind class tweak), fix it, re-run the relevant check, and commit:

```bash
git add -A
git commit -m "fix(ui): address issues found in manual verification"
```
(Skip this step entirely if the walkthrough found nothing to fix.)

---

### Task 15: Open the PR, pass CI, and resolve the Bugbot review

**Files:** none (integration / review).

> Sequential and partly asynchronous — CI and Bugbot run on the remote PR.
> **HARD GATE: Do not mark this task complete until CI is green AND (Bugbot has
> reviewed with all comments resolved, OR Bugbot does not review this repo at
> all — see the note in Step 5).**

- [ ] **Step 1: Sync the latest `main`**

```bash
git fetch origin
git merge origin/main
pnpm lint && pnpm typecheck && pnpm test   # resolve conflicts + commit first if any; fix fallout
```

- [ ] **Step 2: Push and open the PR**

```bash
git status --short && git rev-parse --abbrev-ref HEAD   # clean tree, on feature branch (not main)
git push -u origin HEAD
gh pr create --base main --fill --title "feat(ui): migrate packages/ui to shadcn/ui"
```

- [ ] **Step 3: Subagent code review**

REQUIRED SUB-SKILL: `requesting-code-review`. Dispatch a code reviewer subagent (BASE_SHA = merge-base with `main`, HEAD_SHA = HEAD). Fix Critical and Important findings, commit, push, then proceed.

- [ ] **Step 4: Make every CI check pass**

```bash
gh pr checks --watch
```
On failure: `gh run view --log-failed`, reproduce locally, fix, commit, push, re-watch. Do not proceed while red.

- [ ] **Step 5: Wait for the Bugbot review**

```bash
gh pr view --json reviews,comments
gh pr comment --body "bugbot run"   # only if it hasn't reviewed yet
```
**Note:** Bugbot has previously been confirmed removed from this repo (agentops-engine) — if no Bugbot review appears within a few minutes and `bugbot run` gets no response, treat Step 5/6 as not applicable and go straight to Step 7. Re-verify this is still true before skipping (a `gh pr view` with genuinely zero reviews of any kind after several minutes is the confirmation).

- [ ] **Step 6: Address each Bugbot comment** (skip if Step 5 confirmed Bugbot is inactive)

REQUIRED SUB-SKILL: `receiving-code-review`. Verify before acting — reply to false positives; TDD-fix real findings, commit each referencing the finding, push once.

**Then mark each addressed thread resolved:**

```bash
gh api graphql -f query='query($o:String!,$r:String!,$p:Int!){repository(owner:$o,name:$r){pullRequest(number:$p){reviewThreads(first:100){nodes{id isResolved path comments(first:1){nodes{body}}}}}}}' -F o=<owner> -F r=<repo> -F p=<number>
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=<thread-id>
```

**After pushing:** return to Step 4 (re-watch CI), then Step 5 (wait for re-review). Loop until Bugbot reports no unresolved comments.

- [ ] **Step 7: Final verification**

```bash
gh pr checks                          # all green
gh pr view --json reviews,comments    # no comment left unaddressed (or confirmed no reviewer configured)
pnpm lint && pnpm typecheck && pnpm test   # suite green locally
```
Confirm no unresolved review threads remain, then mark this task complete.
