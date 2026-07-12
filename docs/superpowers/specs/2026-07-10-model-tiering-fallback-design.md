# Model Tiering & Cross-Backend Fallback — Design

Status: draft · 2026-07-10 · Owner: Artem

Resolves: #27 (Generic cross-backend, stage-aware fallback for agent runs).

## Context

`issue-broccoli-94` (`devCycle`, `dev-agents` namespace) died when the Claude subscription session cap hit:

```
claude reported is_error: You've hit your session limit · resets 9:30am (UTC)
  at parseOutput (packages/backends/src/claude/claude-backend.ts:86)
```

This is the Claude Code CLI **subscription session cap** (account-wide on `claude-credentials`), surfaced as `is_error: true` in the CLI JSON. Three independent gaps meant today's fallback never fired for it:

1. **Not detected.** `claude-backend.ts` throws `is_error` results as a generic `ProcessCliProcessError`. `provider-rate-limit.ts::isProviderRateLimitMessage` only matches `\b429\b` **and** `fair usage policy|rate limit|request frequency` — "session limit" matches neither.
2. **Not wired for `claude`.** `worker/main.ts::buildBackends` applies `wrapWithRateLimitFallback` to `pi` only; `claude` and `platform` have no fallback.
3. **A same-backend swap wouldn't help anyway.** `RateLimitFallbackBackend` retries `this.inner.run({ ...req, model })` — same backend, different model string. A Claude session limit is account-wide, so `claude-sonnet-5 → claude-opus` under the same `claude-credentials` is still throttled. Escaping it requires switching **backend** (`claude → `pi`), which the current decorator cannot do (it only holds `this.inner`).

The incident re-hit the cap 5× via Temporal's `maximumAttempts: 5` and died.

### Why this design supersedes the precursor

The precursor ([2026-07-08-provider-rate-limit-fallback-design.md](2026-07-08-provider-rate-limit-fallback-design.md)) deliberately scoped to *one* fallback attempt, same backend, `pi`-only, and explicitly rejected a chain ("avoids speculative generality"). Cross-backend changes that calculus: each hop now escapes a genuinely *different* failure domain (claude-credentials → pi's z.ai account → litellm's API lane), which is exactly when an ordered chain earns its complexity. Generalizing also exposes that the same "which spare model" question is asked by *primary selection* and *policy escalation* — folding all three into a single **model tiering** abstraction removes three ad-hoc config surfaces and replaces them with one.

## Goal

A single **model tiering** substrate that owns primary model selection, policy escalation, and both classes of provider-throttle fallback. Specifically:

- **Tiers** (`smart`, `implementation`, `review`, `escalation`, …) are named, ordered lists of concrete `ModelRef`s. The order is *both* the primary preference and the session-limit fallback chain — one object.
- **Global tiers** live in Postgres and are editable live from Mission Control.
- **Project-local tiers** (`agentops.json`) override same-named globals; project-local wins on collision.
- **Project config** (`agentops.json`) references a tier per stage, never a concrete `ModelRef` in routing. A per-project `effort` override sits on top of the global tier.
- **Two failure classes**, distinct by physical timescale:
  - `SessionLimitError` (hours, account-wide) → **sticky advance** down the tier list; exhausted → fail fast.
  - `RateLimitError` (minutes, transient) → **wait** (retryable, `nextRetryDelay`, no model change).
- **Works uniformly** for `devCycle`, `platform`, `bughunt`, and custom-agent workflows — lives in the backend/activity layer, not in any workflow file (mirrors the precursor's "no workflow change" principle, *except* the unavoidable routing-shape migration).

## Non-goals

- **Per-stage concrete `ModelRef` in `agentops.json`.** This design deliberately removes it from routing. `ModelRef` survives only as the tier-entry shape (inside tier lists), never in `routing[stage]`.
- **A human-in-the-loop `blockReason` for throttle errors.** Consistent with the precursor: visibility via logs/heartbeat, not workflow state.
- **`RateWindowedBackend`'s dormant quota config.** Separate concern, still untouched.
- **Review gate / approval for tier edits.** Console edits apply on next worker refresh by design (operational config, like the project registry). Blast-radius is mitigated by write-time validation, not a human gate.
- **Turning the fallback into a recovery loop beyond the tier list.** One walk down the resolved tier list on `SessionLimitError`; no retry-from-start, no "retry the primary after the list."

## Section 1 — The tier abstraction

A **tier** is a named, ordered list of concrete `ModelRef`s:

```
smart:          [ claude/opus,         pi/zai/glm-5.2,            pi/openrouter/deepseek-v4-pro ]
implementation: [ claude/haiku,        pi/openrouter/deepseek-v4-flash,  pi/zai/glm-5.2 (low) ]
review:         [ claude/opus,         pi/zai/glm-5.2 ]
escalation:     [ claude/opus (max) ]
```

The order serves two uses — no separate fallback config anywhere:
1. **Primary selection.** The first entry is the stage's primary model.
2. **Session-limit fallback chain.** `SessionLimitError` advances to the next entry; the list *is* the chain.

**Two homes, one resolution rule:**
- **Global tiers** → Postgres, editable live from Mission Control (Section 5).
- **Project-local tiers** → `agentops.json` `tiers` field. **Project-local wins** on name collision; else the global DB entry fills in.

**`effort` ≡ "thinking level."** The existing `ModelRef.effort` field (`low|medium|high|xhigh|max`) is labeled "thinking level" in the console. It appears in two places:
- **Per tier entry** — each `ModelRef` carries its own effort (e.g. `pi/zai-glm-5.2` at `low` in the `implementation` tier).
- **Per-project override** in `routing[stage].effort` — overrides the entry's effort at resolution time, so a project can force "use the `implementation` tier but `effort: low`" without editing the tier.

**Tier vocabulary is open.** `routing[stage].tier` is a free string; operators create/rename tiers from the console. Only the **stage→default-tier map** is fixed in code (stage names are fixed vocabulary per M0-SPEC §Contracts). A project can still override `routing[stage].tier` to any tier name.

**Escalation is now a tier ref.** The vibeteam-proven "model escalation tier on the final attempt" policy (ARCHITECTURE §2) is preserved but absorbed: `escalation: { tier: "escalation" }` references a tier, and `policies/next-repair-action.ts`'s `{ kind: 'fix', useEscalationModel: true }` triggers resolution of that tier instead of a concrete `ModelRef`. Key distinction preserved: escalation is **policy-triggered** (final attempt), not failure-triggered — a third thing, distinct from both throttle-fallback classes.

## Section 2 — Contracts changes

The foundational change: strip concrete `ModelRef` out of `routing`/`escalation`, replace with tier references.

### New schema — tier reference in routing

```ts
// StageRoute: tier ref + optional per-project effort override
export const StageRouteSchema = z.object({
  tier: z.string().min(1),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
});
export type StageRoute = z.infer<typeof StageRouteSchema>;
```

### `ProjectConfig` changes

```ts
ProjectConfigSchema = z.object({
  // ... (image, services, initCommands, verify commands, stages, brakes, timeouts unchanged)
  routing: z.object({
    context?: StageRouteSchema,
    assess?: StageRouteSchema,
    design?: StageRouteSchema,
    plan?: StageRouteSchema,
    implement?: StageRouteSchema,
    full_verify?: StageRouteSchema,
    review?: StageRouteSchema,
    pr?: StageRouteSchema,
    pr_babysit?: StageRouteSchema,
    bughunt?: StageRouteSchema,     // new stage from the whitebox-bughunt workflow
    agent?: StageRouteSchema,       // new stage from custom-agent workflows
  }),
  escalation: z.object({ tier: z.string().min(1) }).optional(),  // was: ModelRefSchema
  tiers: z.record(z.string(), z.array(ModelRefSchema)).optional(), // NEW: project-local tiers
})
```

- `ModelRefSchema` **stays** (concrete `{backend, model, effort}`) — it's still the tier-entry shape. Its `backend` enum (`claude|cursor|pi|codex|stub|litellm`) is unchanged.
- `ModelRef` is gone from `routing` and `escalation` entirely.

### `DEFAULT_PROJECT_CONFIG` changes

```ts
routing: {
  context:     { tier: 'smart' },
  assess:      { tier: 'smart' },
  design:      { tier: 'smart', effort: 'medium' },
  plan:        { tier: 'smart' },
  implement:   { tier: 'implementation', effort: 'high' },
  full_verify: { tier: 'smart', effort: 'high' },
  review:      { tier: 'review' },
},
escalation: { tier: 'escalation' },
// tiers: undefined — default entries come from the GLOBAL DB tier table, not code
```

System-default tier *entries* (the `smart: [claude/opus, …]` lists) live in the DB, seeded by a migration (Section 5), **not** in `DEFAULT_PROJECT_CONFIG`. Code only ships the tier *names* used by default routing + the fixed stage→default-tier map.

### Fixed stage→default-tier map (in code)

```ts
export const DEFAULT_STAGE_TIER: Record<Stage, string> = {
  context: 'smart',
  assess: 'smart',
  design: 'smart',
  plan: 'smart',
  implement: 'implementation',
  full_verify: 'smart',
  review: 'review',
  pr: 'smart',
  pr_babysit: 'smart',
  bughunt: 'smart',
  agent: 'smart',     // default; custom agents typically override routing[stage].tier per role
  done: 'smart',      // not used (terminal), present for exhaustiveness
  failed: 'smart',    // ditto
};
```

### Ripples (traced on `main` as of `f2feb7d`)

- `dev-cycle.ts:285` `useEscalation ? config.escalation : undefined` → becomes tier-aware: when `useEscalation`, resolve `config.escalation.tier` to its first entry. The `implementModel` plumbing becomes an optional tier-ref override passed to the activity.
- `dev-cycle.ts` `runStageAgent('implement', …, implementModel)` — the activity now receives a tier ref (string) + optional effort, not a concrete `ModelRef`.
- `policies/next-repair-action.ts` — `hasEscalationModel: config.escalation != null` is unchanged (still "is an escalation configured?"). Downstream consumers of `useEscalationModel` resolve the tier, not a `ModelRef`.
- `runAgent` return type grew on `main`: `AgentRunResult & { promptHash, promptSource }`. Unaffected by tier resolution: those two fields are computed in the *activity* (from prompt rendering) and attached to the return above the backend/decorator layer, so backends and `TierFallbackBackend` still return plain `AgentRunResult`.
- All test fixtures across `workflows`, `policies`, `activities`, `backends` that build a `ProjectConfig` with concrete `routing: { implement: { backend, model, effort } }` → flip to `{ implement: { tier: 'implementation' } }` and inject a stub tier table into test deps.

## Section 3 — Tier resolution & the fallback mechanism

Load-bearing decision: **resolve in the activity layer.** Workflows send tier refs (strings — determinism-safe); the activity does the lookup and dispatches. This keeps workflows pure of I/O (AGENTS hard rule #1 — no DB read in workflow code) and puts the I/O (tier lookup) in the activity layer where I/O belongs. The fallback loop never touches `dev-cycle.ts` / `platform.ts` / `bughunt` — consistent with #27's "lives in the backend/activity layer" principle.

### Resolution

`resolveTier(projectTiers, globalTiers, tierName, effortOverride?)`:
1. `entries = projectTiers?.[tierName] ?? globalTiers.get(tierName)`
2. If `effortOverride`, apply it to every entry's `effort`.
3. Return the ordered `ModelRef[]`.

Pure function over loaded maps — testable, no async. Lives in `policies` (pure) or a new `activities`-side resolver.

### The generalized decorator — `TierFallbackBackend` (replaces `RateLimitFallbackBackend`)

```ts
class TierFallbackBackend implements AgentBackend {
  constructor(
    private readonly inner: AgentBackend,        // primary entry's backend instance
    private readonly registry: Record<string, AgentBackend>,  // cross-backend dispatch
    private readonly chain: ModelRef[],          // resolved tier list MINUS primary: [entries[1], entries[2], ...]
    private readonly heartbeat: (details: unknown) => void,
  ) {}

  async run(req: BackendRunRequest): Promise<AgentRunResult> {
    try {
      return await this.inner.run(req);
    } catch (err) {
      // RateLimit: the decorator does NOT map it. It re-throws, and the activity's catch
      // (create-activities.ts) converts to a retryable ApplicationFailure with nextRetryDelay.
      // No model change — "wait it out" is the fallback for a minutes-long blip (Option A).
      if (err instanceof RateLimitError) throw err;

      if (!(err instanceof SessionLimitError)) throw err;

      // SessionLimit: sticky advance down the chain.
      for (const fallback of this.chain) {
        const details = {
          event: 'session-limit-fallback',
          stage: req.stage,
          taskId: req.taskId,
          from: { backend: req.backend, model: req.model },
          to: { backend: fallback.backend, model: fallback.model, effort: fallback.effort },
        };
        this.heartbeat(details);
        console.warn(JSON.stringify(details));   // survives in Loki after the workflow closes
        try {
          return await this.registry[fallback.backend].run({
            ...req,
            backend: fallback.backend,
            model: fallback.model,
            effort: fallback.effort ?? req.effort,
          });
        } catch (e) {
          if (e instanceof SessionLimitError) continue;   // keep walking
          throw e;                                         // RateLimit/generic/auth propagates
        }
      }
      throw new SessionLimitExhaustedError(
        `all fallback tiers exhausted for stage "${req.stage}" (session limit)`,
      );
    }
  }
}
```

**Key properties:**
1. **Per-call wrapper, not per-backend.** The activity builds a per-call instance with the resolved `chain` + the registry, so each `runAgent` invocation gets its own resolved tier. This is the "holds the registry" generalization #27 asks for.
2. **`SessionLimitError` walks the list; `RateLimitError` does not.** Time-scale distinction maps directly onto the tier list: hours → advance (sticky), minutes → wait (no advance).
3. **Cross-backend dispatch** via `registry[fallback.backend]`. The chain can hop `claude → pi → litellm`.
4. **Non-`SessionLimit` errors during a fallback attempt propagate immediately** — an auth failure or generic error on the fallback backend isn't swallowed into another hop.

### Activity boundary (`create-activities.ts`)

`runAgent` gains tier-resolution before dispatch. The error-class → `ApplicationFailure` map (today handles `LiteLlmBudgetExceededError`, `ProcessCliAuthError`, `RateWindowExceededError`) adds:
- `SessionLimitExhaustedError` → `ApplicationFailure.nonRetryable(..., 'SessionLimitExhausted')`. This is the "fail fast, don't burn the 5× budget on an hours-long cap" behavior.
- `RateLimitError` → `ApplicationFailure.create({ ..., nonRetryable: false, nextRetryDelay })`. The "wait it out" path (Option A for RateLimit). `nextRetryDelay` from parsed `Retry-After` or a fixed backoff.

### Worker wiring (`worker/main.ts::buildBackends`)

`buildBackends` still assembles the `claude`/`pi`/`litellm` backend instances into a registry — unchanged in *shape*. What changes:
- The existing `wrapWithRateLimitFallback` (pi-only) is **removed** — its job is subsumed by the per-call `TierFallbackBackend` the activity constructs.
- The activity deps gain a `tierStore` / loaded `globalTiers` map (Section 5b).

## Section 4 — Detection (classifying the two errors from real CLI output)

The boundary between "raw CLI error string" and our two typed errors. Must run *before* the generic throw, in each backend's output parser.

### Two matchers, two error classes (generalize the existing module)

`provider-rate-limit.ts` (renamed/extended to a detection module):

```ts
export class RateLimitError extends Error {}        // self-clearing, minutes (was ProviderRateLimitedError)
export class SessionLimitError extends Error {}     // account-wide, hours (NEW)
// ProviderRateLimitedError kept as a deprecated alias / re-export during migration? — see Open questions.

export function isRateLimitMessage(message: string): boolean {
  // existing logic, unchanged: 429 AND a fair-usage/rate-limit phrase.
  return /\b429\b/.test(message) && /(fair usage policy|rate limit|request frequency)/i.test(message);
}
export function isSessionLimitMessage(message: string): boolean {
  // NEW: Claude subscription session cap. Narrow — "session limit" + "resets …".
  return /session limit/i.test(message) && /reset/i.test(message);
}
```

Both deliberately narrow. Only the two known throttle classes become fallback-eligible; everything else (bad model name, real outage, auth) propagates as a generic `ProcessCliProcessError` untouched.

### Wiring — each backend checks in order

**`claude-backend.ts::parseOutput`** (the `is_error` path — currently only checks auth):
```
if AUTH_ERROR_PATTERN.test(result)            → ProcessCliAuthError       (existing)
else if isSessionLimitMessage(result)         → SessionLimitError         (NEW — the incident fix)
else if isRateLimitMessage(result)            → RateLimitError            (NEW for claude)
else                                          → ProcessCliProcessError    (existing)
```

**`pi-backend.ts::parseOutput`** (the `stopReason: error` path — currently only checks rate-limit):
```
if isSessionLimitMessage(message)             → SessionLimitError         (NEW — checked first: more severe)
else if isRateLimitMessage(message)           → RateLimitError            (was ProviderRateLimitedError)
else                                          → ProcessCliProcessError    (existing)
```

**Both backends detect both classes.** The matchers are cheap, vendor wording shifts over time, and wiring it asymmetrically guarantees the next new phrasing becomes an incident. Session-limit is checked before rate-limit defensively — the account-wide cap is more severe and should win any ambiguity. (In practice a message can't match both, but the ordering is explicit.)

## Section 5 — Tier table: DB schema, worker loading, console editor

### 5a — DB schema + migration

One table, ordered entries (precedent: the managed-project registry's Postgres pattern, `PostgresManagedProjectStore`):

```sql
-- tiers: one row per (tier_name, position). Position defines priority/fallback order.
CREATE TABLE tiers (
  id           SERIAL PRIMARY KEY,
  tier_name    TEXT NOT NULL,              -- "smart", "implementation", "review", "escalation"
  position     INT NOT NULL,               -- 0 = primary, 1.. = session-limit fallback order
  backend      TEXT NOT NULL,              -- claude | cursor | pi | codex | stub | litellm
  model        TEXT NOT NULL,              -- "opus", "zai/glm-5.2", "openrouter/deepseek-v4-pro"
  effort       TEXT,                       -- low|medium|high|xhigh|max (nullable)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tier_name, position)
);
CREATE INDEX tiers_name_idx ON tiers (tier_name);
```

- `position` is the ordered-list index. Resolved tier = `SELECT ... WHERE tier_name=$1 ORDER BY position ASC`.
- **Seed migration** populates system defaults (the matrix): `smart: [claude/opus, pi/zai/glm-5.2, pi/openrouter/deepseek-v4-pro]`, `implementation: [claude/haiku, pi/openrouter/deepseek-v4-flash, pi/zai/glm-5.2 low]`, `review: [claude/opus, pi/zai/glm-5.2]`, `escalation: [claude/opus max]`. This is what `DEFAULT_PROJECT_CONFIG.routing` references but does not define.
- Editing is **delete-then-insert per tier** (positions renumbered) — simplest, avoids in-place reorder bugs. A `TierStore` activity-side dep mirrors `PostgresManagedProjectStore` / `PostgresStatsStore`.

### 5b — Worker loading

Workers resolve tiers to dispatch. Loading sits in activity deps:

- **At startup:** worker reads the whole table → in-memory `Map<tierName, ModelRef[]>`. One query, no per-call DB hit (backends must not do I/O per agent call beyond the run itself).
- **Periodic refresh (60s):** worker re-reads the table on a 60s interval. New tiers apply to *new* activity calls within the interval. The whole point of console-editable is not rolling pods to change a model.
- **Resolution:** `resolveTier(projectTiers?, tierName, effortOverride?)` → project-local `tiers[tierName]` if present, else the in-memory global map. Pure function over the loaded map — testable, no async.

### 5c — Console editor (Mission Control)

A new page (precedent: the `Agents.tsx` page) at the model-tiering surface:

- **Matrix view:** rows = tier names, columns = position slots, each cell = `{backend, model, effort}`. Drag-to-reorder within a row rewrites `position`.
- **CRUD:** add/rename tier (free string), add/remove/reorder entries, set effort per entry.
- **API:** `control`'s REST surface gains `GET/PUT /api/tiers` (list all + replace-all), mirroring the existing `/api/projects` pattern. `PUT` is replace-all (delete-then-insert per tier) — simpler than per-row PATCH with reorder semantics.

### 5d — Write-time validation (prevents fleet breakage)

Validation runs in `control` before any DB write (Zod on the API boundary, same as every contract):

1. **Enum checks** — `backend` ∈ `{claude,cursor,pi,codex,stub,litellm}`, `effort` ∈ `{low,medium,high,xhigh,max}` or null.
2. **Non-empty model** — `model` is a non-empty string.
3. **No empty tiers** — a tier with zero entries is rejected (any stage routed to it would have no primary). Highest-value check.
4. **Positions contiguous** starting at 0 (no gaps) — enforced by delete-then-insert replacement, validated on ingest too.
5. **No duplicate `(tier_name, backend, model)`** within a tier — same model twice in a list is almost always a paste error.

**Not** validated (YAGNI): referential integrity that every `DEFAULT_PROJECT_CONFIG.routing[stage].tier` exists in the table — that's a *seed-migration* guarantee, not a per-edit check. Deleting a referenced tier is allowed; the resolver falls back to the project-local tier, or errors at resolve time with a clear message. A non-blocking warning could be added later.

## Testing strategy

- **Detection** (`provider-rate-limit.test.ts`): `isRateLimitMessage` (existing z.ai 429, bare unrelated "429" negative, non-429 "rate limit" negative) + `isSessionLimitMessage` (the real Claude "session limit · resets …" phrasing, a bare "session limit" without "resets" negative, an unrelated `is_error` negative).
- **Backend parsing** (`claude-backend.test.ts`, `pi-backend.test.ts`): each emits the right typed error for session-limit and rate-limit inputs, falling through to `ProcessCliProcessError` / `ProcessCliAuthError` for the rest.
- **`TierFallbackBackend`** (new test, replaces `rate-limit-fallback-backend.test.ts`): delegates straight through on success; on `SessionLimitError` walks the chain across backends via the registry, heartbeats each hop, returns the first success; on `RateLimitError` propagates without walking; on chain exhaustion throws `SessionLimitExhaustedError`; a non-session error during a fallback attempt propagates immediately (not swallowed).
- **`resolveTier`** (pure-fn test): project-local wins over global; global fills in when project-local absent; `effortOverride` applied to all entries; missing tier → clear error.
- **Contracts migration**: `parseProjectConfig` accepts the new tier-ref routing shape and rejects concrete `ModelRef` in `routing[stage]`; project-local `tiers` validates as `Record<string, ModelRef[]>`.
- **Worker loading**: `buildBackends` no longer wraps pi with the old `RateLimitFallbackBackend`; activity deps receive the loaded `globalTiers` map + a stub `TierStore` in tests.
- **K8s job-cache key** (`k8s-job-runner.test.ts`): the existing `modelKey(req.model)` already disambiguates same-backend model swaps; add a case asserting the key changes across a cross-backend fallback (`req.backend` differs) — the key currently does *not* include `backend`, so this may need the key extended (see Open questions).
- **Write-time validation** (`control` test): each of the 5 rules rejects with a clear message; a well-formed replace-all writes.
- **No new e2e scenario required**, but the existing fallback path needs a regression case asserting a non-throttle error still propagates without touching the chain.

## Named risks

- **Tier edit re-routes the fleet on next refresh (≤60s).** No review gate by design. Mitigated by write-time validation (§5d), not approval. A bad edit still lands instantly — the validation prevents *malformed* tiers, not *unwise* ones.
- **Cross-backend fallback quality/cost are unvalidated.** `claude → pi/zai-glm-5.2` (or whatever the `smart` tier's fallback is) hasn't been evaluated for equivalent quality across this pipeline's stages. This design makes the *mechanism* correct, not a claim that the fallback model produces equivalent results. An `EvalRun`-style comparison is M9 territory.
- **`nextRetryDelay` parsing for RateLimit.** z.ai's 429 doesn't reliably include `Retry-After`. Falls back to a fixed backoff; the exact backoff constant is a chart/operator decision, not encoded here.
- **Worker periodic refresh (60s) adds a background query per worker.** Negligible at single-replica; worth noting if the fleet scales.
- **`ProviderRateLimitedError` rename is a breaking type change.** Any code importing it (today: `pi-backend.ts`, `rate-limit-fallback-backend.ts`) must move to `RateLimitError`. A temporary re-export alias during the migration window avoids a flag-day; decided in implementation (Open questions).

## Package/file summary

- **New:**
  - `packages/backends/src/tier-fallback/tier-fallback-backend.ts` (+ test) — the generalized decorator.
  - `packages/contracts/src/model.ts` — `StageRouteSchema`, `TierRefSchema` (escalation), `project-local tiers` field.
  - A `TierStore` + Postgres adapter in `packages/activities` (or a new boundary) + migration.
  - `control` `/api/tiers` handlers + Mission Control tier-editor page.
- **Changed:**
  - `packages/backends/src/provider-rate-limit.ts` — add `SessionLimitError` + `isSessionLimitMessage`, rename `ProviderRateLimitedError` → `RateLimitError`.
  - `packages/backends/src/claude/claude-backend.ts`, `packages/backends/src/pi/pi-backend.ts` — wire both detectors.
  - `packages/contracts/src/project-config.ts` — routing → tier refs, escalation → tier ref, add `tiers`, update `DEFAULT_PROJECT_CONFIG`.
  - `packages/activities/src/create-activities.ts` — tier resolution + the two new error → `ApplicationFailure` mappings.
  - `packages/worker/src/main.ts` — remove `wrapWithRateLimitFallback`, load global tiers, pass to activity deps.
  - `packages/workflows/src/dev-cycle.ts` — send tier refs, not `ModelRef`s.
  - `packages/backends/src/k8s/k8s-job-runner.ts` — job-cache key may need `backend` added (Open questions).
  - All `ProjectConfig` test fixtures across `workflows`/`policies`/`activities`/`backends`.
- **Removed:**
  - `packages/backends/src/rate-limit-fallback/` — subsumed by `tier-fallback/`. (`RateLimitFallbackBackend` tests rewritten for `TierFallbackBackend`.)

## Open questions carried forward

- **K8s job-cache key & `backend`.** Today `k8sJobName(req)` includes `modelKey(req.model)` but **not** `req.backend`. A cross-backend fallback that happens to use the same model string on a different backend would 409-reuse the primary's Job. The issue (#27) calls this out. Likely fix: fold a short backend hash into the key alongside the model hash. Decision + test in implementation.
- **`ProviderRateLimitedError` rename — flag-day vs temporary re-export alias.** Small surface (two files), so a flag-day may be cleanest; decided in implementation.
- **`resolveTier` home — `policies` (pure) vs `activities`.** It's a pure function but conceptually activity-side. Putting it in `policies` gives it exhaustive unit-test coverage "for free" (matching the package's contract); putting it in `activities` keeps it next to its only caller. Lean `policies` for the coverage discipline.
- **RateLimit `nextRetryDelay` backoff constant** — chart/operator decision, not encoded in code.
- **Whether a missing-tier at resolve time should be a non-retryable `ApplicationFailure` or fall back to `DEFAULT_STAGE_TIER[stage]`.** Lean non-retryable (loud, surfaces a misconfigured tier edit immediately); decided in implementation.
