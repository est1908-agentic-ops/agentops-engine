# `agentops.json` Config Loading — Design

Status: draft · 2026-07-03 · Owner: Artem
Milestone: M1, sub-project 5 of 5 (see [claude-backend design](2026-07-03-claude-backend-design.md) for the full decomposition)

## Context

Today `TaskInput.config: ProductConfig` is hand-built inline by `cli/src/main.ts`'s `defaultConfig()` — every task gets the same hardcoded verify commands, empty routing, and fixed brake numbers, regardless of which repo it targets. Real products need their own verify commands (the engine cannot guess how to build/test an arbitrary repo) and may want their own routing/brake overrides. This is the smallest of M1's four sub-projects, but it has one real correctness trap worth designing carefully: **which fields are safe to default, and which absolutely are not.**

Depends on [GitHub ports](2026-07-03-github-ports-design.md)' `ScmPort.readFile` — config is fetched via the Contents API, no clone required, so this doesn't depend on [worktree activities](2026-07-03-worktree-activities-design.md) at all.

## Goal

Load and validate a real `ProductConfig` from `agentops.json` at the target repo's root, merging optional fields over engine-wide defaults, before `devCycle` starts.

## Non-goals

- Prompt-pack overrides (`agentops/prompts/` in the product repo, ARCHITECTURE.md §5.9 point 5) — deferred, same as the [claude-backend design](2026-07-03-claude-backend-design.md)'s open question; no real product repo exists yet to override from.
- `triggers`/`jobs` sections (ARCHITECTURE.md §6.1) — that's `ConfigSync`, M7.
- Live reload / watching for config changes mid-task — a task's config is fixed at start, per `TaskInput` being a one-shot workflow argument.

## Verify commands: optional, but `undefined` ≠ `[]`

Earlier drafts of this doc made `fastVerifyCommands`/`fullVerifyCommands` required, reasoning that a defaulted empty array would make `full_verify` trivially pass — nothing run, nothing checked. Revised per direction: **both fields are optional**, with a specific, deliberate semantic for omission that avoids that trap.

The key distinction: `undefined` (field not present in `agentops.json`) and `[]` (field explicitly set to an empty array) mean different things, and the schema must not conflate them:

- **`undefined`** — "this product hasn't configured automated verification for this gate." The `full_verify`/`review` prompts (see [claude-backend design](2026-07-03-claude-backend-design.md)) tell the agent explicitly that no command checklist was configured and it must rely on its own review of the diff before emitting `FULL:`/`VERDICT:`. This is a real, supported mode — not silent degradation, because the prompt says so out loud and the agent still has to commit to an explicit verdict.
- **`[]`** — an explicit, deliberate "there is nothing to run here" (e.g., a docs-only repo). Schema-legal, behaves the same as `undefined` in the prompt today, but is a distinct value a product author chose on purpose rather than one that fell out by omission — worth keeping distinct in the type even though M1's prompt logic doesn't yet treat them differently.

What this design still refuses to do: silently substitute a guessed command (`['pnpm test']` for an unspecified field) — that risk (running the *wrong* thing for a non-pnpm product) is unrelated to the required/optional question and stays rejected regardless.

**Decision: `fastVerifyCommands`/`fullVerifyCommands` are optional with no default value** (absence is preserved, not coerced to `[]`). Everything else in `ProductConfig` gets a documented default as before.

## Design

### `packages/contracts/src/product-config.ts` gains:

```ts
export const DEFAULT_PRODUCT_CONFIG: Omit<ProductConfig, 'fastVerifyCommands' | 'fullVerifyCommands'> = {
  stages: {},
  routing: {
    context: { backend: 'claude', model: 'claude-sonnet-5', effort: 'medium' },
    assess: { backend: 'claude', model: 'claude-sonnet-5', effort: 'medium' },
    design: { backend: 'claude', model: 'claude-sonnet-5', effort: 'medium' },
    plan: { backend: 'claude', model: 'claude-sonnet-5', effort: 'medium' },
    implement: { backend: 'claude', model: 'claude-sonnet-5', effort: 'high' },
    full_verify: { backend: 'claude', model: 'claude-sonnet-5', effort: 'high' },
    review: { backend: 'claude', model: 'claude-sonnet-5', effort: 'high' },
    // `pr` and `pr_babysit` are deliberately absent: dev-cycle.ts never calls runStageAgent
    // for either stage today (pr is a direct openPr activity call; pr_babysit's repair
    // rounds re-route through 'implement'). Add defaults for them only if that changes.
  },
  // no `escalation` default — opting into escalation is a deliberate, cost-relevant choice
  brakes: { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 },
};

export class InvalidProductConfigError extends Error {
  constructor(message: string, public readonly issues?: unknown) { super(message); }
}

export function parseProductConfig(raw: unknown): ProductConfig {
  // JSON.parse'd object in, merged + validated ProductConfig out (or throws)
}
```

`DEFAULT_PRODUCT_CONFIG`'s `brakes` numbers are lifted verbatim from `cli/main.ts`'s current `defaultConfig()` — that function's hand-rolled copy is deleted once this lands, removing the duplication rather than leaving two sources of truth for the same numbers. `routing`'s default of `claude`/`claude-sonnet-5` for every stage is deliberate: M1's entire point is running for real, so defaulting to `stub` (which would silently no-op every stage a product forgot to route) would repeat the exact silent-degradation mistake called out for verify commands, just for routing instead. A product that actually wants `stub` for some stage must say so explicitly. `effort` is tiered per ARCHITECTURE.md §5.5's stated policy ("cheap model for context, strong for implement") — same idea applied to reasoning effort instead of model choice: `medium` for the cheaper upfront stages, `high` where correctness matters most (`implement`, the two verdict stages). See [`effort` field](#new-field-effort-next-to-model) below for the contract change this depends on.

**`parseProductConfig(raw)`:**

1. If `raw` isn't a plain object → throw `InvalidProductConfigError('agentops.json must be a JSON object')`.
2. Merge: shallow-spread `raw` over `DEFAULT_PRODUCT_CONFIG` at the top level, but merge `stages`, `routing`, and `brakes` **one level deeper** (`{ ...DEFAULT_PRODUCT_CONFIG.routing, ...raw.routing }`) — so a product can override e.g. just `routing.implement` without having to restate the other eight stages, or just `brakes.maxTokens` without restating the other three brake numbers. `fastVerifyCommands`/`fullVerifyCommands`/`escalation` are never deep-merged or defaulted (arrays and an optional single object respectively — if `raw` doesn't set them, the merged config simply doesn't have them; that absence is meaningful, see above).
3. `ProductConfigSchema.parse(merged)` — now that `fastVerifyCommands`/`fullVerifyCommands` are `.optional()` on the schema, this step's job is catching genuine type errors (a string where an array was expected, a malformed `ModelRef`), not enforcing presence of any particular field.
4. On `ZodError`, catch and rethrow as `InvalidProductConfigError` with a formatted, human-readable message (field path + expected/received) rather than a raw zod issue tree — this is read by a human running the CLI, not parsed by anything downstream.

### `packages/cli/src/load-product-config.ts` (new — the I/O half)

```ts
export async function loadProductConfig(scm: ScmPort, repo: string): Promise<ProductConfig> {
  const raw = await scm.readFile(repo, 'agentops.json');
  if (raw === null) {
    // No file at all is now a legitimate state, not an error: every field of ProductConfig
    // is either optional or defaulted (see above), so "no agentops.json" resolves to the
    // engine's defaults wholesale — same as an agentops.json containing `{}`.
    return parseProductConfig({});
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new InvalidProductConfigError(`${repo}/agentops.json is not valid JSON: ${(err as Error).message}`);
  }
  return parseProductConfig(parsed);
}
```

This can't live in `packages/contracts` (contracts has no business depending on `ports`, and doing file I/O at all is a stretch for what's meant to be the schema layer) — it lives in `packages/cli`, the only M1 caller, since config loading happens once, CLI-side, before `client.workflow.start(devCycle, ...)`. `parseProductConfig` (the pure validation/merge half) is the part worth unit-testing exhaustively; `loadProductConfig` (the I/O half) just wires a `ScmPort` to it and translates `readFile`'s `null` into `{}` and JSON-syntax errors into `InvalidProductConfigError`, so `cli/main.ts` has one error type to catch and report (a malformed file is still a hard failure — only a *missing* file is now treated as "use defaults").

Worth surfacing to the operator either way: `cmdStart` should log whether it loaded a real `agentops.json` or fell back to full defaults, so "why did this task run with no verify commands at all" is answerable from the CLI output rather than requiring a repo-side check.

### `cli/main.ts` change

`cmdStart` replaces its call to the deleted `defaultConfig()` with `await loadProductConfig(scm, repo)`. **Which `ScmPort` instance `scm` is here is a wiring decision, not this sub-project's**: a real run needs a `GithubScmPort` (token + Octokit, from the [GitHub ports design](2026-07-03-github-ports-design.md)); the existing local-demo path (documented in the current README, no `GITHUB_TOKEN` needed) should keep working against `MemoryScmPort` with a seeded `agentops.json` fixture file. Deciding exactly how `cmdStart` picks between the two belongs to M1's final integration/wiring step, once all four sub-projects exist — noted here so it isn't lost, not designed prematurely against three docs that might still shift.

## New field: `effort` next to `model`

`ModelRefSchema` (`packages/contracts/src/model.ts`) currently carries only `{ backend, model }`. Per-stage reasoning effort is a real, independent routing knob — a cheap/fast pass for `context` and a deep pass for `implement`/verdict stages is exactly the kind of tuning ARCHITECTURE.md §5.5 already calls out for model choice; effort is the same idea, one dial over.

```ts
export const ModelRefSchema = z.object({
  backend: z.enum(['claude', 'cursor', 'pi', 'codex', 'stub']),
  model: z.string().min(1),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(), // NEW
});
```

Levels match the vocabulary already used elsewhere in this stack rather than inventing a new scale. `effort` is optional — a `ModelRef` without it means "let the backend/CLI use its own default," not "use the lowest tier." `DEFAULT_PRODUCT_CONFIG.routing` above sets an explicit tier per stage so M1's out-of-the-box behavior is intentional rather than whatever each CLI happens to default to.

Propagation: `effort` needs to ride along on `AgentRunRequest`/`BackendRunRequest` (`packages/contracts/src/agent-run.ts`) alongside `model`, and `dev-cycle.ts`'s `runStageAgent` needs to read `model?.effort` off the routed `ModelRef` the same way it already reads `model?.model`. **How each backend actually consumes it is that backend's concern** — see the [claude-backend design](2026-07-03-claude-backend-design.md#effort--reasoning-level) and [pi-backend design](2026-07-03-pi-backend-design.md) for the CLI-level wiring (and an open verification question on the claude side, since the exact flag isn't confirmed yet).

## Testing strategy

- `parseProductConfig`: pure function, exhaustively unit-tested without any I/O. Cases: empty input `{}` → fully-defaulted `ProductConfig` with `fastVerifyCommands`/`fullVerifyCommands` absent; only verify commands supplied → those pass through untouched, everything else defaulted; partial `routing`/`brakes` override → only the specified keys change, siblings keep defaults; a `ModelRef` override with `effort` set → effort passes through validation; non-object input → throws; malformed field type (e.g. `brakes.maxTokens` as a string) → throws with a message naming the field.
- `loadProductConfig`: inject a fake `ScmPort` (same DI pattern as everywhere else in this set of designs) — cases: file present and valid → returns config; file absent (`readFile` resolves `null`) → returns `DEFAULT_PRODUCT_CONFIG`-equivalent, does **not** throw; invalid JSON text → throws with a JSON-syntax-specific message.
- No network, no real GitHub calls — consistent with every other doc in this set.

## Named risks

- **Defaulting `routing` to `claude`/`claude-sonnet-5` means a product that never touches `agentops.json`'s routing section spends real tokens on every stage the moment M1's wiring goes live** — there's no "dry run" default. Acceptable given M1's explicit goal is a real PR, but worth a loud callout in whatever README section documents `engine start` for M1 (don't point it at a repo you don't intend to spend on).
- **Verify commands being optional means `full_verify` can become a pure agent self-assessment with no automated gate at all** — a rubber-stamping agent could report `FULL: PASS` having verified nothing, and nothing in this design catches that. Mitigated only socially for M1 (recommend setting real verify commands in the README/onboarding docs for any repo that matters). A stronger mitigation worth considering later, not required now: record whether verify commands were configured on `StageResult`/`RunStats` so "this task shipped with zero automated verification" is at least *visible* downstream rather than silent.
- **No schema versioning.** If `ProductConfigSchema` gains required fields later (M5's budget config, M8's role manifests), every existing `agentops.json` in every product repo needs updating in lockstep, with no migration path. Not a problem yet (there's exactly one and it doesn't exist), but worth a one-line note in ARCHITECTURE.md when a second product repo shows up.

## Package/file summary

- **Changed:** `packages/contracts/src/product-config.ts` (`DEFAULT_PRODUCT_CONFIG`, `parseProductConfig`, `InvalidProductConfigError`; `fastVerifyCommands`/`fullVerifyCommands` become `.optional()`), `.test.ts`.
- **Changed:** `packages/contracts/src/model.ts` (`effort` on `ModelRefSchema`), `.test.ts`.
- **New:** `packages/cli/src/load-product-config.ts`, `.test.ts`.
- **Changed:** `packages/cli/src/main.ts` (`cmdStart` uses `loadProductConfig`; delete `defaultConfig()`).

## Open questions carried forward

- `cmdStart`'s real-vs-demo `ScmPort` selection — explicit M1 wiring-step item, not resolved here.
- Prompt-pack overrides, `triggers`/`jobs` sections — out of scope, noted above.
- Whether to record "verify commands configured?" on `RunStats`/`StageResult` for visibility — named as a risk above, not a requirement.
