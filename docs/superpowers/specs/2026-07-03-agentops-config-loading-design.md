# `agentops.json` Config Loading — Design

Status: draft · 2026-07-03 · Owner: Artem
Milestone: M1, sub-project 4 of 4 (see [claude-backend design](2026-07-03-claude-backend-design.md) for the full decomposition)

## Context

Today `TaskInput.config: ProductConfig` is hand-built inline by `cli/src/main.ts`'s `defaultConfig()` — every task gets the same hardcoded verify commands, empty routing, and fixed brake numbers, regardless of which repo it targets. Real products need their own verify commands (the engine cannot guess how to build/test an arbitrary repo) and may want their own routing/brake overrides. This is the smallest of M1's four sub-projects, but it has one real correctness trap worth designing carefully: **which fields are safe to default, and which absolutely are not.**

Depends on [GitHub ports](2026-07-03-github-ports-design.md)' `ScmPort.readFile` — config is fetched via the Contents API, no clone required, so this doesn't depend on [worktree activities](2026-07-03-worktree-activities-design.md) at all.

## Goal

Load and validate a real `ProductConfig` from `agentops.json` at the target repo's root, merging optional fields over engine-wide defaults, before `devCycle` starts.

## Non-goals

- Prompt-pack overrides (`agentops/prompts/` in the product repo, ARCHITECTURE.md §5.9 point 5) — deferred, same as the [claude-backend design](2026-07-03-claude-backend-design.md)'s open question; no real product repo exists yet to override from.
- `triggers`/`jobs` sections (ARCHITECTURE.md §6.1) — that's `ConfigSync`, M7.
- Live reload / watching for config changes mid-task — a task's config is fixed at start, per `TaskInput` being a one-shot workflow argument.

## The correctness trap: not everything gets a default

It's tempting to make `ProductConfig` fully defaultable so a minimal `agentops.json` "just works." That's correct for `routing`, `stages`, `escalation`, and `brakes` — the engine has reasonable opinions about all four. It is **wrong** for `fastVerifyCommands`/`fullVerifyCommands`: there is no universally-safe default. An empty-array default would make `full_verify` trivially pass every time (nothing was actually run) — silently defeating the entire repair-loop/verdict system this codebase is built around. A generic guess like `['pnpm test']` would silently run the *wrong* thing for a non-pnpm product and either false-fail or false-pass depending on what happens to exist at that path.

**Decision: `fastVerifyCommands`/`fullVerifyCommands` stay required, with no default.** A product repo's `agentops.json` must specify both explicitly, or config loading fails fast with an actionable error — before any workflow starts, before any token is spent. Everything else in `ProductConfig` gets a documented default.

## Design

### `packages/contracts/src/product-config.ts` gains:

```ts
export const DEFAULT_PRODUCT_CONFIG: Omit<ProductConfig, 'fastVerifyCommands' | 'fullVerifyCommands'> = {
  stages: {},
  routing: {
    context: { backend: 'claude', model: 'claude-sonnet-5' },
    assess: { backend: 'claude', model: 'claude-sonnet-5' },
    design: { backend: 'claude', model: 'claude-sonnet-5' },
    plan: { backend: 'claude', model: 'claude-sonnet-5' },
    implement: { backend: 'claude', model: 'claude-sonnet-5' },
    full_verify: { backend: 'claude', model: 'claude-sonnet-5' },
    review: { backend: 'claude', model: 'claude-sonnet-5' },
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

`DEFAULT_PRODUCT_CONFIG`'s `brakes` numbers are lifted verbatim from `cli/main.ts`'s current `defaultConfig()` — that function's hand-rolled copy is deleted once this lands, removing the duplication rather than leaving two sources of truth for the same numbers. `routing`'s default of `claude`/`claude-sonnet-5` for every stage is deliberate: M1's entire point is running for real, so defaulting to `stub` (which would silently no-op every stage a product forgot to route) would repeat the exact silent-degradation mistake called out above, just for routing instead of verify commands. A product that actually wants `stub` for some stage must say so explicitly.

**`parseProductConfig(raw)`:**

1. If `raw` isn't a plain object → throw `InvalidProductConfigError('agentops.json must be a JSON object')`.
2. Merge: shallow-spread `raw` over `DEFAULT_PRODUCT_CONFIG` at the top level, but merge `stages`, `routing`, and `brakes` **one level deeper** (`{ ...DEFAULT_PRODUCT_CONFIG.routing, ...raw.routing }`) — so a product can override e.g. just `routing.implement` without having to restate the other eight stages, or just `brakes.maxTokens` without restating the other three brake numbers. `fastVerifyCommands`/`fullVerifyCommands`/`escalation` are never deep-merged (arrays and an optional single object respectively — "specify the whole thing or take the default/absence" is the only sensible semantic for those).
3. `ProductConfigSchema.parse(merged)` — this is what actually enforces the "verify commands are mandatory" rule, for free: `DEFAULT_PRODUCT_CONFIG` doesn't supply them, so if `raw` doesn't either, the schema's existing `z.array(z.string())` (non-optional) fails validation.
4. On `ZodError`, catch and rethrow as `InvalidProductConfigError` with a formatted, human-readable message (field path + expected/received) rather than a raw zod issue tree — this is read by a human running the CLI, not parsed by anything downstream.

### `packages/cli/src/load-product-config.ts` (new — the I/O half)

```ts
export async function loadProductConfig(scm: ScmPort, repo: string): Promise<ProductConfig> {
  const raw = await scm.readFile(repo, 'agentops.json');
  if (raw === null) {
    throw new InvalidProductConfigError(
      `${repo} has no agentops.json — at minimum, fastVerifyCommands and fullVerifyCommands are required`,
    );
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

This can't live in `packages/contracts` (contracts has no business depending on `ports`, and doing file I/O at all is a stretch for what's meant to be the schema layer) — it lives in `packages/cli`, the only M1 caller, since config loading happens once, CLI-side, before `client.workflow.start(devCycle, ...)`. `parseProductConfig` (the pure validation/merge half) is the part worth unit-testing exhaustively; `loadProductConfig` (the I/O half) just wires a `ScmPort` to it and translates `readFile`'s `null`/JSON errors into the same `InvalidProductConfigError` type, so `cli/main.ts` has one error type to catch and report.

### `cli/main.ts` change

`cmdStart` replaces its call to the deleted `defaultConfig()` with `await loadProductConfig(scm, repo)`. **Which `ScmPort` instance `scm` is here is a wiring decision, not this sub-project's**: a real run needs a `GithubScmPort` (token + Octokit, from the [GitHub ports design](2026-07-03-github-ports-design.md)); the existing local-demo path (documented in the current README, no `GITHUB_TOKEN` needed) should keep working against `MemoryScmPort` with a seeded `agentops.json` fixture file. Deciding exactly how `cmdStart` picks between the two belongs to M1's final integration/wiring step, once all four sub-projects exist — noted here so it isn't lost, not designed prematurely against three docs that might still shift.

## Testing strategy

- `parseProductConfig`: pure function, exhaustively unit-tested without any I/O — this is where the correctness trap above gets regression-guarded. Cases: minimal valid input (only verify commands) → fully-defaulted `ProductConfig`; partial `routing`/`brakes` override → only the specified keys change, siblings keep defaults; missing verify commands → throws `InvalidProductConfigError`; non-object input → throws; malformed field type (e.g. `brakes.maxTokens` as a string) → throws with a message naming the field.
- `loadProductConfig`: inject a fake `ScmPort` (same DI pattern as everywhere else in this set of designs) — cases: file present and valid → returns config; file absent (`readFile` resolves `null`) → throws; invalid JSON text → throws with a JSON-syntax-specific message.
- No network, no real GitHub calls — consistent with every other doc in this set.

## Named risks

- **Defaulting `routing` to `claude`/`claude-sonnet-5` means a product that never touches `agentops.json`'s routing section spends real tokens on every stage the moment M1's wiring goes live** — there's no "dry run" default. Acceptable given M1's explicit goal is a real PR, but worth a loud callout in whatever README section documents `engine start` for M1 (don't point it at a repo you don't intend to spend on).
- **No schema versioning.** If `ProductConfigSchema` gains required fields later (M5's budget config, M8's role manifests), every existing `agentops.json` in every product repo needs updating in lockstep, with no migration path. Not a problem yet (there's exactly one and it doesn't exist), but worth a one-line note in ARCHITECTURE.md when a second product repo shows up.

## Package/file summary

- **Changed:** `packages/contracts/src/product-config.ts` (`DEFAULT_PRODUCT_CONFIG`, `parseProductConfig`, `InvalidProductConfigError`), `.test.ts`.
- **New:** `packages/cli/src/load-product-config.ts`, `.test.ts`.
- **Changed:** `packages/cli/src/main.ts` (`cmdStart` uses `loadProductConfig`; delete `defaultConfig()`).

## Open questions carried forward

- `cmdStart`'s real-vs-demo `ScmPort` selection — explicit M1 wiring-step item, not resolved here.
- Prompt-pack overrides, `triggers`/`jobs` sections — out of scope, noted above.
