# Design — Task issue-agentic-ops-engine-109

**Goal:** Add Claude usage info to the Budgets panel.

## Goal (restated)

The `/budgets` page today shows two things: (1) *configured* subscription rate
windows for `claude` and `pi` (max calls / window hours, plus a "configured"
badge, but **no live usage**), and (2) an estimated-USD OpenRouter spend section
derived from recorded `agent_run_stats` rows. Claude is the primary backend the
platform runs on, yet its actual usage is invisible on the Budgets page — an
operator can see the *limit* Claude is configured with but not *how much has been
used*. This change adds a Claude usage section that surfaces recorded Claude
activity (token counts and call counts) drawn from the same `agent_run_stats`
data the OpenRouter section already uses.

## Approaches considered

### A. Aggregate recorded Claude usage from `agent_run_stats` (recommended)

Mirror the existing OpenRouter section, but keyed on Claude rows. In
`handleGetBudgets`, filter the `statsStore.all()` rows to those served by the
Claude backend (`backend === 'claude'`), aggregate total input/output tokens, a
total call count, and a per-model breakdown, and return a new `claude` block in
`BudgetsResponse`. The UI renders a "Claude usage (recorded runs)" section next
to the rate-window cards.

- **Trade-off:** Reuses data and code paths that already exist; zero new secrets,
  network egress, or dependencies. But it reflects only what *this platform*
  recorded via the Claude CLI `usage` output — it is **not** the provider's
  authoritative account usage, and because Claude runs on a flat subscription
  (not per-token billing) it deliberately shows **usage counts, not a USD
  estimate**. Cost/complexity: low.

### B. Call the Anthropic Admin/usage API directly

Fetch real subscription/usage figures from Anthropic's usage endpoint in the
control BFF and display authoritative numbers.

- **Trade-off:** Gives the "how much of my plan is left" answer operators
  ultimately want, but requires an admin API key/secret wired through Helm,
  outbound network access from control, error/rate-limit handling, and a data
  model for a provider API that the platform doesn't otherwise touch. The prior
  budget-dashboard slice (`2026-07-13-budget-dashboard-simple-design.md`)
  **explicitly listed "Direct calls to provider account APIs (… Claude usage,
  etc.)" as a non-goal** deferred to a follow-up. Cost/complexity: high; scope
  creep beyond the established slice.

### C. Surface live rate-window utilization ("17/50 calls used")

Expose the running fill level of the Claude rate-window limiter so the Budgets
page shows current-window consumption against the configured limit.

- **Trade-off:** This is the most operationally useful number, but the limiter
  state lives in the **worker** process (`packages/backends/src/rate-window/`),
  not in control, so it would require a cross-process mechanism (shared store,
  new endpoint, or persisting window state) to read it from the BFF. Also
  explicitly a non-goal of the prior slice ("Live current-utilization
  counters"). Cost/complexity: medium-high, architectural.

## Chosen approach

**Approach A.** It is the smallest change that genuinely satisfies "add Claude
usage info to the Budgets panel," it is symmetric with the OpenRouter section the
page already ships (so it fits the existing contract, handler, and UI patterns
exactly), and it introduces no new secrets, network calls, or dependencies.

B and C are rejected primarily because both were *explicitly deferred as
non-goals* by the existing budget-dashboard design, and both carry materially
more surface area (a provider secret + egress for B; cross-process limiter state
for C) than the issue warrants. A also leaves a clean seam: when the follow-up
adds authoritative provider data (B) or live utilization (C), it augments the
same `claude` block rather than reworking it.

## Assumptions

- **"Usage info" means recorded token + call usage, not billed cost.** Claude
  runs on a flat CLI subscription in this platform, so a USD estimate would be
  misleading. I show total input tokens, output tokens, total tokens, call count,
  and a per-model breakdown — no dollar figure for Claude. *(Rejecting an
  invented price table for a subscription lane; USD stays OpenRouter-only.)*
- **Claude rows are identified by `backend === 'claude'`.** `dev-cycle.ts` and
  the other workflow writers persist `backend: result.resolvedBackend` and the
  Claude backend resolves to `'claude'` (confirmed in
  `create-activities.test.ts:592`). This is more precise than the OpenRouter
  section's `model.includes('openrouter')` substring match; I use the backend
  field because Claude model strings (e.g. `claude-opus-4-8`) are less uniform.
  As a defensive fallback the filter also accepts rows whose `model` starts with
  `claude`.
- **Scope is all recorded runs (no time window),** matching the OpenRouter
  section's existing "all recorded runs" period string. Time-range filtering
  remains follow-up work, consistent with the prior slice.
- **Section placement:** the Claude usage section renders inside the existing
  Budgets page, associated with the Claude rate-window card area (usage sits
  logically next to the Claude limit), above the OpenRouter spend section.
- **No auth gate**, matching the read-only operator posture of the existing
  `/api/budgets` handler.

## Design — components & data flow

Symmetric extension of the existing budgets slice; four small edits, one
consistent data path (`agent_run_stats → handler aggregation → contract → UI`).

### 1. Contracts — `packages/contracts/src/control-api.ts`

Add a `ClaudeUsageSchema` and reference it from `BudgetsResponseSchema`:

- `ClaudeUsageSchema`: `{ totalTokens, tokensIn, tokensOut, calls, period,
  modelBreakdown: [{ model, tokens, calls }] }` — all non-negative ints except
  `period: string`. Note the model breakdown carries `tokens` + `calls` and
  deliberately **no** `estimatedUsd` (subscription lane).
- Extend `BudgetsResponseSchema` with a `claude: ClaudeUsageSchema` field. This
  is additive; existing `rateWindows` and `openRouter` fields are unchanged.

### 2. Control BFF — `packages/control/src/budgets-routes.ts`

In `handleGetBudgets`, after loading `rows` (reuse the existing
`statsStore.all()` best-effort read — do **not** query twice):

- Filter Claude rows: `backend === 'claude' || model.toLowerCase().startsWith('claude')`.
- Aggregate `tokensIn`, `tokensOut`, `totalTokens`, `calls` (row count), and a
  `byModel` map accumulating tokens + calls per model.
- Build `modelBreakdown` sorted by tokens descending (same ordering convention
  as OpenRouter).
- `period`: `'from agent_run_stats (all recorded runs)'` when rows exist, else
  `'no data yet'` — mirror the OpenRouter string.
- Add the `claude` block to the response object; the existing
  `BudgetsResponseSchema.parse(body)` now validates it too.

No new deps on `BudgetsRouteDeps`; the same injected `statsStore` supplies the
rows.

### 3. UI — `packages/ui/src/pages/BudgetsPage.tsx`

- `getBudgets` in `api.ts` needs no signature change (it already returns the full
  `BudgetsResponse`); the widened contract flows through automatically.
- Add a "Claude usage (recorded runs)" section, styled like the OpenRouter card:
  a headline showing total tokens and call count, a muted `period` line, and a
  breakdown `Table` (Model | Tokens | Calls) reusing the existing shadcn
  `Card`/`Table` components. Show a "No Claude runs recorded yet." empty state
  when `modelBreakdown` is empty, matching the OpenRouter empty state.
- A short footer note clarifying these are recorded platform runs (via the Claude
  CLI usage output), not authoritative provider-account figures — so the UI does
  not overstate what the number means.

No routing/nav change (the page already exists at `/budgets`).

### 4. Tests

- **Control handler test** (new, `budgets-routes` currently has none): inject a
  fake `statsStore` returning a mix of Claude, OpenRouter, and other-backend
  rows; assert the `claude` block sums tokens/calls correctly, excludes
  non-Claude rows, orders the breakdown by tokens desc, carries no USD field, and
  degrades to the `'no data yet'` empty state when the store is absent/throws.
- **Contract test:** assert `BudgetsResponseSchema` accepts a payload including
  the new `claude` block and rejects a Claude model-breakdown row that carries an
  `estimatedUsd`-style extra numeric where a count is expected (basic shape
  guard), if an existing contracts test file makes this cheap; otherwise fold the
  shape assertion into the handler test.

### Error handling

All reads stay best-effort, identical to the current handler: a missing
`statsStore` or a throwing `all()` yields empty Claude aggregates and the
`'no data yet'` period, never a 500. The UI's existing `loadError` path is
unchanged.

## Self-review

- No placeholders or TBDs.
- No contradictions: USD is intentionally OpenRouter-only and the "usage not
  cost" decision is stated consistently in Assumptions, the contract, and the UI
  footer.
- **Scope:** one coherent change — a single additive `claude` block threaded
  through contract → handler → page, reusing the existing data source. No worker,
  RunStats-schema, rate-limiter, or provider-API changes.

## Brainstorm Summary
**Approaches considered:** (A) aggregate recorded Claude usage from the existing `agent_run_stats` data, symmetric to the current OpenRouter section; (B) call Anthropic's usage/admin API for authoritative account figures; (C) surface live rate-window utilization from the worker's limiter.
**Chosen approach:** (A) — a new `claude` usage block (tokens + call counts, per-model breakdown) threaded through the budgets contract, `handleGetBudgets`, and `BudgetsPage`.
**Why (decisive reasons):** Smallest change that truly adds Claude usage; reuses the existing stats data path with no new secrets, egress, or deps; B and C were both explicitly deferred as non-goals in the prior budget-dashboard slice and carry far more surface area.
**Key risks/assumptions:** Shows recorded platform usage (Claude CLI `usage` output), not authoritative provider-account usage; no USD for Claude since it's a flat subscription; Claude rows identified by `backend === 'claude'` (with a `model` startsWith fallback); covers all recorded runs, no time window.
