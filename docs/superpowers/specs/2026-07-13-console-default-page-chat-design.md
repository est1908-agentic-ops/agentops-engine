# Platform Console default page → Chat — design

Status: draft v1 · 2026-07-13 · Owner: unattended run (issue-agentic-ops-engine-71)

## 1. Goal

When someone opens the Platform Console (`packages/ui`, the `@agentops/ui` Vite + React
Router SPA) at its root URL `/`, they should land on the **chat** experience instead of the
current run-launcher dashboard. Chat should be the default face of the console.

## 2. Current state

- `packages/ui/src/App.tsx` is a code-based `react-router-dom` router. The index route
  `path="/"` renders `HomePage` (`App.tsx:44`).
- `HomePage` (`pages/HomePage.tsx`) is *not* just a landing screen — it is the
  run-launcher + recent-runs dashboard: it starts platform runs and devcycle runs, offers
  suggested prompts and hint-repo input, and lists recent runs of both kinds. It is reachable
  **only** via `/` today (no nav link points to it).
- Chat lives at two routes: `/chat` → `ChatStartPage` (the "start a new chat" screen, which
  on submit navigates to `/chats/:chatId`) and `/chats/:chatId` → `ChatPage` (the conversation
  view). `App.tsx:48-49`.
- The top nav (`App.tsx:12-17`) exposes: Projects, Chat, Tiers, Settings. No Home/Dashboard link.
- Two "← Back to console" links in `ProjectsPage.tsx` (`:202`, `:340`) point to `/`.

The key constraint: because `HomePage` is only reachable at `/`, making chat the default must
**not** orphan it — the run launcher and recent-runs list have to remain reachable.

## 3. Approaches considered

**A. Redirect the index to `/chat`; give the dashboard its own route + nav link.**
`path="/"` becomes `<Navigate to="/chat" replace />`. `HomePage` moves to a new route
(`/dashboard`) and gains a nav link so it stays reachable. The two "Back to console" links
repoint to `/dashboard`.
Trade-off: touches a few more spots (nav array, one route swap, one new route, two link
hrefs) than a bare element swap, but keeps `/chat` as the single canonical start-chat URL and
keeps NavLink active-state correct. Low complexity, no behavior lost.

**B. Render `ChatStartPage` directly as the index element** (`path="/"` element becomes
`<ChatStartPage />`), and move `HomePage` to a new route + nav link.
Trade-off: `ChatStartPage` would then render at two URLs (`/` and `/chat`), the "Chat"
NavLink would *not* show active when on `/` (NavLink matches the `/chat` path, not `/`), and
there'd be two canonical URLs for one screen. Rejected — it creates duplicate/ambiguous
routing state for no benefit over A.

**C. Fold the run launcher into the chat page and drop `HomePage` entirely.**
Make `/` the chat start screen and surface run-launching/recent-runs from within it (or delete
them).
Trade-off: this is a real information-architecture redesign — it would remove or relocate the
devcycle run launcher and the merged recent-runs table, which are load-bearing features. That
is scope well beyond "default page should be chat." Rejected as scope creep and feature loss.

## 4. Chosen approach — A

Approach A is the smallest change that satisfies the goal without losing any existing
capability. It keeps a single canonical URL per screen, keeps the "Chat" nav link's active
state honest, and preserves the run-launcher dashboard behind a proper route + nav entry
instead of silently orphaning it. B is rejected for producing a screen reachable at two URLs
with a broken active state; C is rejected because it bundles an unrelated IA/feature redesign
into what should be a routing default change.

This is scoped to one coherent change: "which page is the console default, and keep the old
default reachable."

## 5. Design — what changes

All changes are in `packages/ui`; no backend, contract, or API changes.

- **`src/App.tsx`**
  - Change the index route from `<Route path="/" element={<HomePage />} />` to a redirect:
    `<Route path="/" element={<Navigate to="/chat" replace />} />` (import `Navigate` from
    `react-router-dom`). `replace` so the redirect doesn't add a history entry.
  - Add a dashboard route for the existing page: `<Route path="/dashboard" element={<HomePage />} />`.
    (`HomePage` component and its file are unchanged; only its route path changes.)
  - Add a nav link for it to `NAV_LINKS` so it's reachable and discoverable — `{ to: '/dashboard',
    label: 'Dashboard' }`, placed first (before Projects) since it's the run-launcher/overview.
    The existing "Chat" nav link is unchanged and now doubles as the way back to the default.

- **`src/pages/ProjectsPage.tsx`**
  - Repoint the two `<Link to="/">← Back to console</Link>` links (`:202`, `:340`) to
    `/dashboard`, so "back to console" still lands on the run-launcher dashboard rather than
    bouncing through the new chat redirect. Link text unchanged.

### Data flow / behavior after the change

- Open `/` → immediate client-side redirect to `/chat` → `ChatStartPage`. The "Chat" nav link
  renders active. Starting a chat still navigates to `/chats/:chatId` (unchanged).
- The run launcher + recent-runs dashboard is available at `/dashboard` and via the new nav
  link; all its behavior (platform/devcycle run start, suggested prompts, hint repos, recent
  runs table, `?target=` query param) is untouched.
- Deep links to `/runs/:workflowId`, `/dev-runs/:workflowId`, `/projects`, `/chats/:chatId`,
  `/tiers`, `/settings` are unaffected.

### Error handling

No new failure surface. The redirect is a pure client-side route element; `ChatStartPage`
retains its own start-chat error handling. No async, no network, nothing to fail in the
routing change itself.

## 6. Assumptions

- **Dashboard route path/label.** The old default has no existing name in nav. I chose route
  `/dashboard` with nav label **"Dashboard"** (over `/runs`, which reads as ambiguous next to
  the existing `/runs/:workflowId` detail route, and over `/home`). Assumption: a clearly named
  dashboard entry is preferable to reusing `/runs`.
- **Default target is `/chat` (the start screen), not a specific existing chat.** There is no
  concept of a "current/last chat" to resume, so the default is the start-a-new-chat screen.
- **Redirect, not element-swap, and the old page is kept.** The task says the *default* should
  be chat; it does not say to remove the run launcher. I assume the run-launcher/recent-runs
  dashboard must remain reachable (it has no other home), hence the new route + nav link.
- **Nav ordering.** Dashboard placed first in the nav. Assumption: overview/launcher belongs at
  the front of the nav even though it's no longer the default landing route.

## 7. Self-review

- No placeholders or TBDs.
- No contradictions: every section treats chat as the new default and `HomePage` as preserved
  at `/dashboard`.
- Single coherent change: a routing-default swap plus the minimal follow-through (keep old page
  reachable, fix two back-links) required to not regress. No unrelated work bundled in.
