# Plan — Task issue-agentic-ops-engine-109

**Goal:** Add Claude usage info to the Budgets panel.

Design authority: `docs/superpowers/specs/issue-agentic-ops-engine-109-design.md`
(Approach A — aggregate recorded Claude usage from `agent_run_stats`, symmetric
to the existing OpenRouter section). This plan turns that design into an ordered,
verifiable set of edits.

## Data path (unchanged shape)

`agent_run_stats` rows → `handleGetBudgets` aggregation → `BudgetsResponseSchema`
→ `getBudgets()` in `api.ts` → `BudgetsPage`. Every edit is additive: a new
`claude` block alongside the existing `rateWindows` and `openRouter` fields.

## Ordered steps

### Step 1 — Contract: add `ClaudeUsageSchema` and extend `BudgetsResponseSchema`
File: `packages/contracts/src/control-api.ts`

- Add `ClaudeUsageSchema = z.object({ totalTokens, tokensIn, tokensOut, calls,
  period: z.string(), modelBreakdown: z.array(z.object({ model, tokens, calls })) })`.
  All numeric fields are `z.number().int().nonnegative()` except `period`.
  Deliberately **no** `estimatedUsd` anywhere in this schema (subscription lane).
- Add `export type ClaudeUsage = z.infer<typeof ClaudeUsageSchema>;`.
- Add `claude: ClaudeUsageSchema` to `BudgetsResponseSchema` (after `openRouter`).

**Why first:** Contracts-first is a hard rule (AGENTS.md #3). Widening the schema
first means the handler and UI edits compile against the real type, and
`BudgetsResponseSchema.parse(body)` in the handler will immediately enforce the
new block. Because the field is *required*, the handler (Step 2) must be updated
before the handler test / any server test can pass — hence Step 2 follows
immediately.

**Verify:** `pnpm --filter @agentops/contracts typecheck` compiles. Deferred
runtime check happens in Step 5's contract test.

### Step 2 — Control BFF: aggregate Claude rows in `handleGetBudgets`
File: `packages/control/src/budgets-routes.ts`

- Reuse the already-loaded `rows` (from the single existing `statsStore.all()`
  best-effort read) — do **not** call `all()` a second time.
- Filter: `const claudeRows = rows.filter((r) => r.backend === 'claude' ||
  r.model.toLowerCase().startsWith('claude'));`
- Accumulate `tokensIn`, `tokensOut`, `totalTokens` (in+out), `calls` (row
  count), and a `byModel` map of `{ tokens, calls }` per `r.model`.
- Build `modelBreakdown` from `byModel`, sorted by `tokens` descending (same
  convention as OpenRouter).
- `period`: `'from agent_run_stats (all recorded runs)'` when `rows.length > 0`,
  else `'no data yet'` — mirror the OpenRouter string exactly.
- Add the `claude` block to `body`; the existing
  `BudgetsResponseSchema.parse(body)` now validates it too.
- No change to `BudgetsRouteDeps` — same injected `statsStore`.

**Why here:** The schema field is required, so the handler must produce it before
any code that parses a `BudgetsResponse` can run green. This step also carries the
best-effort error posture unchanged (missing/throwing store → empty aggregates +
`'no data yet'`, never a 500).

**Verify:** `pnpm --filter @agentops/control typecheck`; full behavior asserted by
the handler test in Step 5.

### Step 3 — UI: render the Claude usage section
File: `packages/ui/src/pages/BudgetsPage.tsx`

- Add `const cl = data?.claude;` next to `rw`/`or`.
- Add a "Claude usage (recorded runs)" section styled like the OpenRouter card,
  placed **above** the OpenRouter spend section and after the rate-window grid
  (usage sits logically next to the Claude limit). Contents:
  - Headline: total tokens + call count (e.g. `{cl.totalTokens} tokens` and
    `{cl.calls} calls`) — **no USD figure**.
  - Muted `period` line.
  - Breakdown `Table` with columns Model | Tokens | Calls, reusing the existing
    shadcn `Card`/`Table` components, rendered when `modelBreakdown.length > 0`.
  - Empty state "No Claude runs recorded yet." when `modelBreakdown` is empty
    (mirror the OpenRouter empty state).
  - Footer `<p>` note: these are recorded platform runs (Claude CLI usage
    output), not authoritative provider-account figures.
- Optionally refine the page intro sentence to mention Claude usage; keep it
  minimal.
- `getBudgets`/`api.ts` need no change — the widened contract flows through the
  existing `BudgetsResponse` return type automatically. No routing/nav change.

**Verify:** `pnpm --filter @agentops/ui typecheck`; `pnpm --filter @agentops/ui
build` (ui has no component test harness for this page — build + typecheck is the
mechanical guard). Manual sanity: the section reads correctly for both populated
and empty `modelBreakdown`.

### Step 4 — Contract test: accept the `claude` block
File: `packages/contracts/src/control-api.test.ts`

- Add a `describe('BudgetsResponseSchema')` block:
  - Accepts a full payload including `rateWindows`, `openRouter`, and a populated
    `claude` block (with a `modelBreakdown` row of `{ model, tokens, calls }`).
  - Rejects a payload whose `claude` block is missing (required field).
  - Rejects a `claude.modelBreakdown` row that carries a negative/float count or
    omits `calls` (basic shape guard).
- Import `BudgetsResponseSchema` into the existing test file.

**Verify:** `pnpm --filter @agentops/contracts test`.

### Step 5 — Handler test: aggregate correctly (new file)
File: `packages/control/src/budgets-routes.test.ts` (new)

- Import `handleGetBudgets` directly (it is exported) — no server needed.
- Cases:
  1. Inject a fake `statsStore.all()` returning a mix of `backend: 'claude'`,
     `model: 'claude-*'` (fallback path), OpenRouter, and other-backend rows.
     Assert the `claude` block sums `tokensIn`/`tokensOut`/`totalTokens`/`calls`,
     **excludes** non-Claude rows, orders `modelBreakdown` by tokens desc, and
     that no `estimatedUsd` key exists anywhere in the `claude` block.
  2. No `statsStore` (deps `{}`) → `claude` aggregates all zero, `period ===
     'no data yet'`, `modelBreakdown === []`, status 200.
  3. `statsStore.all()` throws → same empty/`'no data yet'` degraded result,
     status 200 (best-effort, never 500).
- Use the `stub`/memory posture required by AGENTS.md #5 — the fake store is a
  plain in-test object, no secrets.

**Why Steps 4–5 last:** Tests lock in the behavior produced by Steps 1–3. Writing
them after the source exists lets them import the real symbols; running them is
the definition-of-done gate.

**Verify:** `pnpm --filter @agentops/control test`.

### Step 6 — Full green gate + design reconciliation
- Run `pnpm lint && pnpm typecheck && pnpm test` (AGENTS.md #6).
- `pnpm e2e` is **not** required: this change touches contracts + control BFF + UI
  only — no workflows, policies, activities, or backends. (Noted per AGENTS.md #6
  which scopes e2e to those packages.)
- If any implementation detail deviated from the spec, update the spec in the same
  PR with the reason (AGENTS.md convention). No deviation is anticipated.

**Verify:** all three commands green; command output pasted into the PR/commit.

## Reordering notes

- **Contract → handler → UI → tests** is the safe order: the required `claude`
  field means downstream code cannot compile/parse until the producer exists, so
  Step 1 unblocks 2, and 2 unblocks 3. Could Steps 4 and 5 come earlier (TDD)?
  They could, but writing them before the exported symbols exist would leave the
  workspace red mid-plan for longer with no de-risking benefit here — the design
  is fully specified, so tests-after is cheaper and still gates done-ness.
- Step 1 is genuinely the de-risker: it is the one edit every other step depends
  on, and it is the smallest, so a mistake surfaces immediately at typecheck.

## Assumptions (resolved myself — unattended run)

- **Usage means tokens + calls, not USD.** Claude runs on a flat CLI subscription;
  a dollar estimate would mislead. No `estimatedUsd` in the Claude block. (Per
  design Assumptions.)
- **Claude rows = `backend === 'claude'` OR `model` startsWith `claude`.** The
  backend field is authoritative (`RunStats.backend`, written as
  `result.resolvedBackend`); the `model` startsWith is a defensive fallback for
  rows missing/odd backend. Chosen over OpenRouter's substring match because
  Claude model strings are less uniform.
- **All recorded runs, no time window** — matches the OpenRouter section's period
  string; time-range filtering stays follow-up work.
- **Placement:** Claude usage section renders above the OpenRouter spend section,
  after the rate-window grid.
- **No auth gate** — matches the read-only operator posture of the existing
  `/api/budgets` handler.
- **`calls` = row count** in `agent_run_stats` (each row is one recorded stage
  run), consistent with treating the table as the record of platform activity.
- **e2e not run** — no workflow/policy/activity/backend code changes; scoped out
  by AGENTS.md #6.
