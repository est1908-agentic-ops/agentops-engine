# Budget dashboard (simple slice) — design

**Date:** 2026-07-13  
**Builds on:**  
- `docs/superpowers/specs/2026-07-07-platform-console-design.md` (explicitly called out a future "budgets view" as deferred work unlocked by the control + ui packages)  
- `docs/superpowers/specs/2026-07-07-agent-run-stats-design.md` (persistent `agent_run_stats` with per-run tokens/backend/model)  
- Rate window work (M5 / `packages/backends/src/rate-window/`, worker main.ts `CLAUDE_RATE_WINDOW_*` / `PI_RATE_WINDOW_*`)  
- Existing TiersPage / settings patterns for operator surfaces

## Goal

Deliver a minimal "Budgets" page (and supporting `/api/budgets` endpoint) so an operator can see:

- Configured subscription rate/reset windows for the main CLI subscription lanes (Claude and PI).
- Basic money spending estimate focused on OpenRouter traffic, derived from existing `agent_run_stats` token counts + a static pricing map.

This is the "simple" first slice of the request in issue #72. It uses data and connections that already exist in the control plane (ENGINE_DB + env config) with very little new surface area.

## Non-goals (for this slice)

- Live "current utilization" counters (e.g. "17/50 calls used in the window right now").
- Direct calls to provider account APIs (OpenRouter /credits, /auth/key, Claude usage, etc.).
- Historical charts / time series.
- Capturing or displaying provider-native "resets at HH:MM" times from SessionLimitError messages.
- Per-project attribution of spend.
- Alerts, self-heal integration, or budget brakes changes.
- Any modification to rate limiting behavior, RunStats schema (we compute client-side), or worker.

These are explicitly left for a follow-up issue.

## Assumptions

- The table `agent_run_stats` lives in the same Postgres instance/database that control already connects to via `ENGINE_DB_*` env vars (current worker code confirms `ENGINE_DB_NAME ?? 'agentops_engine'` is used for stats).
- "Current subscriptions reset windows" for the simple page means the *configured* limits + window sizes (human-readable). Live fill level is future.
- A simple in-memory aggregate over the (currently small) stats table is acceptable for the first dashboard.
- Pricing is best-effort and static for now; the numbers are illustrative and can be updated without a contract change.
- The page is read-only operator tooling (no CRUD token required, like /api/tiers and /api/settings/self-heal today).
- Fits existing shadcn/ui + PageShell + card patterns (see recent shadcn-ui-redesign and TiersPage).

## Components

### 1. Contracts (`packages/contracts/src/control-api.ts`)

Add minimal schemas:

```ts
export const RateWindowViewSchema = z.object({
  maxCalls: z.number().int().nonnegative(),
  windowHours: z.number().nonnegative(),
  configured: z.boolean(),
});
export type RateWindowView = z.infer<typeof RateWindowViewSchema>;

export const BudgetsResponseSchema = z.object({
  rateWindows: z.object({
    claude: RateWindowViewSchema,
    pi: RateWindowViewSchema,
  }),
  openRouter: z.object({
    estimatedUsd: z.number(),
    totalTokens: z.number().int().nonnegative(),
    period: z.string(), // e.g. "all time (from agent_run_stats)"
    modelBreakdown: z.array(z.object({ model: z.string(), tokens: z.number(), estimatedUsd: z.number() })),
  }),
});
```

No change to RunStats or other core contracts.

### 2. Control BFF

- New file `packages/control/src/budgets-routes.ts` exporting `handleGetBudgets(deps)`.
- `ControlDeps` gains optional `statsStore?: { all(): Promise<RunStats[]> }`.
- In `create-control-server.ts`: add route `if (req.method === 'GET' && pathname === '/api/budgets')`.
- In `main.ts`:
  - Build a stats reader (re-using the same Pool pattern as tierStore/engineSettingsStore when `ENGINE_DB_HOST` present).
  - Instantiate `new PostgresStatsStore(pool)` (idempotent ensureSchema is harmless for a reader) or fall back.
  - Pass it down.
  - Log "agentops control: /api/budgets ENABLED (ENGINE_DB_HOST set)" etc.
- Rate window values are read directly from `process.env` (same names the worker uses):
  - `CLAUDE_RATE_WINDOW_MAX_CALLS` + `CLAUDE_RATE_WINDOW_MS` → `windowHours = ms / (1000*60*60)`
  - Same for `PI_RATE_WINDOW_*`
  - If not a positive number, `configured: false` and show sensible "not configured" in UI.
- Spend calculation (in the handler):
  - Call `statsStore.all()` (or empty array).
  - Filter rows where `model.toLowerCase().includes('openrouter')`.
  - Sum `tokensIn + tokensOut`.
  - Apply a small static price map (per million tokens) for common models seen in the tier files. Fall back to a conservative average for unknown openrouter models.
  - Return `estimatedUsd` rounded reasonably (e.g. 4 decimals or to cents).
- No auth gate (read-only operator data).

### 3. UI

- `packages/ui/src/api.ts`: add `getBudgets(): Promise<BudgetsResponse>`.
- New page `packages/ui/src/pages/BudgetsPage.tsx`:
  - Uses `PageShell`.
  - Two main sections (or cards): "Rate Windows" and "OpenRouter Spend".
  - Rate windows: simple cards or table showing name, max calls, window size (hours), "configured" badge.
  - Spend: summary "Estimated OpenRouter spend: $X.XXXX (all time from recorded runs)", total tokens, and a small breakdown table (model | tokens | est. $). Uses existing table/badge components.
  - "Reload" button.
  - Footer note: "Live window utilization and exact provider account data are tracked in the follow-up issue."
- `packages/ui/src/App.tsx`:
  - Add nav link (e.g. after Tiers): `{ to: '/budgets', label: 'Budgets' }`
  - Add `<Route path="/budgets" element={<BudgetsPage />} />`
- No new heavy dependencies.

### 4. Helm / wiring (minimal)

No chart changes needed for the simple slice — the feature is enabled exactly when `ENGINE_DB_HOST` is already set for tiers/settings (the same condition). The env vars for rate windows are already passed to the engine pods.

## Data flow

```
Operator opens /budgets
  → ui fetch('/api/budgets')
  → control handler
      → read CLAUDE_RATE_WINDOW_* / PI_RATE_WINDOW_* from process.env
      → if statsStore: statsStore.all() → filter openrouter models → price * tokens / 1e6
      → return validated shape
  → render cards + table
```

All reads are best-effort; missing data produces graceful "not configured" / "0" / "stats unavailable" states.

## Testing / verification

- Contracts: add a small test in an existing control-api test file or the run-stats style test.
- Control: unit test for `handleGetBudgets` (inject fake stats store returning a couple openrouter + non-openrouter rows; verify rate window parsing and usd math).
- Manual: `pnpm --filter @agentops/control dev` + ui dev, visit the page (with and without DB). In real cluster the numbers will be real.
- Golden render for chart not required (no new Deployment values).
- Full `pnpm lint && pnpm typecheck && pnpm test` must be green.

No e2e change (the stub path has no real stats).

## Open questions / risks

- Pricing map will drift from reality — acceptable for the simple slice; the follow-up can replace it with fetched values.
- `all()` on a very large stats table: currently the table is small and the design doc for agent-run-stats already flagged unbounded growth. For the dashboard we can later add `since` filtering if needed.
- The simple page does not solve "how much budget do I have left right now on my Claude plan" — that is the main remaining item.

This slice is deliberately the smallest change that gives a real page an operator can look at and say "here is our OpenRouter spend and what the rate limits are configured to."
