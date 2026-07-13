# shadcn/ui redesign of `packages/ui` — design

Status: draft v1 · 2026-07-13 · Owner: Artem

## 1. What this is

`packages/ui` is a plain React 19 + Vite SPA with hand-rolled CSS (`styles.css`, `chat.css`), no component library, no Tailwind. A design mockup (`Model Tiers.pdf`, a "print" export from a Claude-design project) shows a shadcn/ui-styled redesign of the app shell (top nav) and the **Model Tiers** page in detail: card-per-tier layout, labeled `BACKEND`/`MODEL`/`EFFORT` fields, a legend strip, icon buttons for rename/delete/move/remove, and a `+ Add tier` / `Reload` / `Save` action row.

This spec covers migrating the **entire app** — six routed pages (Home/Console, Projects, Chat start, Chat, Tiers, Settings) plus the two run-detail pages (`RunDetailPage`, `DevCycleRunDetailPage`) — onto shadcn/ui primitives. The Tiers page is pixel-matched to the mockup; every other page gets the same primitive vocabulary applied to its **existing** layout and behavior — no new features, no information-architecture changes, no backend/contract changes.

**Decided in brainstorming:**
- Full-app scope (not Tiers-only), in one spec/plan — this is a systematic visual migration of one cohesive app, not independent features, so it does not need sub-project decomposition.
- Two mockup elements have no backing concept in the code today and are **not** being built: the green-dot "● fleet operator" header badge (no session/connection-status concept exists anywhere) and the grip-handle icon suggesting tier drag-reorder (tiers are stored as `Record<string, ModelRef[]>` with no order field — order is today's `Object.keys(tiers).sort()`, alphabetical). Both are reduced to the current functionality: no status badge, no drag-reorder.
- Light mode only — no dark-mode toggle in this pass.

## 2. Foundation

- The installed `shadcn` CLI (v4-line) uses a **named-preset** system, not the classic style/base-color prompt — confirmed by an actual trial run (`npx shadcn@latest init -t vite -b radix -p nova -c packages/ui -y`) against a scratch copy of this package. Manual prerequisites (Tailwind + path alias) must exist *before* `init` runs, or it fails with "No Tailwind CSS configuration found":
  1. `pnpm --filter @agentops/ui add tailwindcss @tailwindcss/vite` and `pnpm --filter @agentops/ui add -D @types/node`.
  2. `src/index.css`: `@import "tailwindcss";`.
  3. `vite.config.ts`: add the `tailwindcss()` plugin and `resolve.alias['@']`.
  4. `packages/ui/tsconfig.json`: add `"paths": { "@/*": ["./src/*"] }` to `compilerOptions` — **no `baseUrl`**. This repo pins `typescript@^6.0.3`, which has removed `baseUrl` entirely (`error TS5102: Option 'baseUrl' has been removed`, confirmed in the trial); bare `paths` resolves correctly under `moduleResolution: "Bundler"` without it.
  5. Then `npx shadcn@latest init -t vite -b radix -p nova -c packages/ui -y` — preset **`nova`** (Lucide icons + Geist font; the CLI's own default) is the closest match to the mockup's clean, professional dashboard look. This writes `packages/ui/components.json` (`"style": "radix-nova"`, `"baseColor": "neutral"`, `"iconLibrary": "lucide"`), creates `src/lib/utils.ts` (`cn()`), `src/components/ui/button.tsx`, and rewrites `src/index.css` with the full CSS-variable theme (adds `@import "tw-animate-css"`, `@import "shadcn/tailwind.css"`, `@import "@fontsource-variable/geist"`, a `:root`/`.dark` oklch variable block, and `@theme inline` mappings).
  - **New dependencies this adds** (confirmed from the trial's `package.json` diff): `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `radix-ui`, `tw-animate-css`, `@fontsource-variable/geist`, `shadcn` (runtime helper the preset's generated CSS imports from), plus dev deps `tailwindcss`, `@tailwindcss/vite`, `@types/node`.
  - Primitives added via `npx shadcn@latest add button card input select table badge label textarea dialog alert-dialog checkbox sonner -c packages/ui -y` (button already exists from init; the CLI skips re-writing identical files). `sonner` additionally pulls in `sonner` and `next-themes` (its generated `src/components/ui/sonner.tsx` calls `next-themes`'s `useTheme()`; with no `ThemeProvider` mounted — this pass is light-only, §1 — it falls back to its `"system"` default, which is harmless since `.dark` is never applied).
- Theme override: in `src/index.css`, change `:root`'s `--primary` and `--primary-foreground` from the generated near-black (`oklch(0.205 0 0)` / `oklch(0.985 0 0)`) to the app's existing blue — `--primary: #2563eb; --primary-foreground: #ffffff;` (a plain hex value works identically to `oklch(...)` here; it's substituted as-is into `var(--primary)` wherever Tailwind's generated utilities reference it, confirmed via the trial's generated `button.tsx` which consumes `bg-primary`/`text-primary-foreground`). The `.dark` block's own `--primary` is left as generated (unused — no toggle wires up `.dark` in this pass, §1).
- Icons: `lucide-react` (already pulled in by the preset) replaces today's raw glyph characters (`↑ ↓ ✕ ✓ —`).
- `src/styles.css` and `src/chat.css` are deleted; their rules are superseded by Tailwind utilities + the generated theme. The one exception is `.summary-text` (the `react-markdown` output styling in `ChatPage`/`RunDetailPage`) — since that targets dynamically-rendered HTML from markdown, not componentized JSX, it's ported as a scoped Tailwind `@layer components` block (same selectors, Tailwind-equivalent values) rather than removed.

## 3. App shell (`App.tsx`)

- Header: "Agentic Ops" wordmark left, nav links (Projects, Chat, Tiers, Settings — the exact current set from `App.tsx`, unchanged) styled with shadcn nav treatment (active-route underline/color via `useLocation`). No status badge (§1).
- Page container: a shared shell (max-width wrapper) replacing today's ad-hoc `.page` class, applied consistently across all routes including `RunDetailPage`/`DevCycleRunDetailPage` which currently also use `.page`.

## 4. Model Tiers page — pixel-matched to the mockup

`TiersPage.tsx` keeps its exact state model and API calls (`listTiers`/`replaceTiers`, the `mutate`/`clone` pattern, `dirty`/`saving`/`savedAt` tracking) — only the rendering layer changes:

- Header: eyebrow text "ROUTING CONFIGURATION", `<h1>Model Tiers</h1>`, description paragraph (unchanged copy), action row (`+ Add tier`, `Reload`, `Save`) as `Button` variants (outline / outline / primary), right-aligned.
- Legend strip: a muted info bar with `Badge`s for "0 Primary…", "1 Fallback…", "effort …", plus a right-aligned "`N` tiers configured" count — matches the mockup's horizontal legend row.
- Each tier renders as a `Card`:
  - Header row: tier name (bold) + "`N` models" (muted, `Badge variant="secondary"` or plain muted text) on the left; `Rename` (pencil icon) and `Delete tier` (trash icon) as `Button variant="outline" size="sm"` on the right.
  - Each model row: a numbered `Badge` (0 = filled/primary blue "PRIMARY", N>0 = outline "FALLBACK N"), then labeled `BACKEND` (`Select`, options = today's `ALLOWED_BACKENDS`), `MODEL` (`Input`), `EFFORT` (`Select`, options = today's `ALLOWED_EFFORTS` plus the existing "(default)" empty option) — same field semantics as today, restyled.
  - Row actions: move-up/move-down/remove as `Button variant="ghost" size="icon"` with `ChevronUp`/`ChevronDown`/`X` icons, same disabled-at-boundary logic as today.
  - "`+ Add fallback model`" as a `Button variant="ghost" size="sm"` at the card's bottom, same `addEntry` call.
- `window.prompt` → `Dialog` with an `Input` for the tier name. Both **Add tier** and **Rename tier** keep today's collision rule (name must not already exist) but the dialog's submit button is disabled while the name is blank or collides, with inline helper text explaining why — the same disabled-until-valid pattern `ProjectForm` already uses, replacing today's silent no-op.
- `window.confirm` (delete tier) → `AlertDialog` ("Delete tier "`name`"? This can't be undone.").
- Save feedback: keep the inline "(unsaved changes)" / "(saved `HH:MM:SS`)" / error text (matches today's low-key style), and additionally fire a `sonner` toast on a successful save (new, purely additive — doesn't replace the inline text, since a toast alone would be too easy to miss and the mockup doesn't show one either way).
- No drag-reorder for tiers (§1) — sort stays `Object.keys(tiers).sort()`.

## 5. Remaining pages — same primitives, existing layout/behavior

No mockup exists for these; each keeps its current fields, calls, and flows, restyled with the primitive set from §2:

- **HomePage** (`/`, "Platform Console"): target `Select`, prompt `Textarea`, suggested-prompt chips as `Badge`/`Button` chips, hint-repos `Input` (keeps the native `<datalist>` — shadcn has no combobox-with-freeform-suggestions primitive that's a drop-in replacement, and building one is out of scope here), `Button` for Run, recent-runs `Table` using the restyled `StatusBadge`.
- **ProjectsPage** (`/projects`): CRUD token gate card, `Table` of registered projects (`CredentialBadges` → `Badge`), `ProjectForm` → `Card` with `Select`/`Input`/`Textarea` fields (GitHub vs. Linear conditional fields unchanged), `window.confirm` on remove → `AlertDialog`.
- **ChatStartPage** (`/chat`) and **ChatPage** (`/chats/:chatId`): start form → `Textarea` + `Button`; transcript → message bubbles restyled with Tailwind utilities (keeping the user/agent/system alignment and color distinction `chat.css` has today), the proposal card → `Card` with `Button` approve/reject, composer → `Textarea` + `Button`. Markdown rendering (`react-markdown`/`remark-gfm`) unchanged, styled via the ported `.summary-text`-equivalent block (§2).
- **SettingsPage** (`/settings`): self-heal card → `Card`, cron display as `<code>`, `scheduleActive` indicator → `Badge`, enable checkbox → shadcn `Checkbox` (new primitive, added alongside the others), Save/Reload → `Button`.
- **RunDetailPage** / **DevCycleRunDetailPage**: header (`StatusBadge` restyled, Temporal link), prompt/summary sections → `Card`, child-run cards (`.child-cards`/`.card`) → `Card` grid, unchanged polling/data logic.
- **`StatusBadge`**: re-implemented on shadcn `Badge` with the same `RunStatus`→color mapping it has today (color values carried over as inline style or a small variant map, since shadcn's default `Badge` variants don't cover this domain's 7 statuses).

**Noted but out of scope:** `src/pages/Agents.tsx` is dead code — it was unrouted when Agents/Console tabs were removed from nav (`ff277cb`, PR #66) but the file was never deleted. This spec doesn't touch it either way; flagging so it isn't mistaken for a page this migration missed.

## 6. Testing

Per `AGENTS.md`'s definition of done (`pnpm lint && pnpm typecheck && pnpm test`):

- `packages/ui` has no existing test suite today (no `.test.`/`.spec.` files, no `test` script) and this migration doesn't introduce one — it's a visual/structural change with no new business logic to unit-test.
- `pnpm --filter @agentops/ui typecheck` and `pnpm --filter @agentops/ui build` must stay green.
- Each page is manually verified in a browser (`vite dev` against a running backend, or the `stub` backend) covering: Tiers (add/rename/delete tier, add/reorder/remove model entries, save/dirty states), Projects (token gate, create/edit/delete, GitHub and Linear tracker forms), Chat (start, send a turn, answer a question, approve/reject a proposal), Settings (toggle + save), Home (start a run), Run/DevCycleRun detail (render an existing run).
- No API/contract changes anywhere in this spec, so no `packages/contracts`/`packages/control` test changes are needed.

## 7. Non-goals

- Dark mode / theme toggle (§1).
- The "fleet operator" status badge and tier drag-reorder (§1) — and the `TiersTable` contract change (an order field) that drag-reorder would require.
- Any new page, route, or feature not present in the app today.
- Adding a component/visual test harness to `packages/ui`.
- Deleting the already-dead `src/pages/Agents.tsx` (§5, flagged only).
- A combobox primitive for `HomePage`'s hint-repos field — keeps the native `<datalist>`.
