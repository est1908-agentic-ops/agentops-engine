# Routing Defaults Rebalance — `implement` to OpenRouter, `platform` to Claude — Design

Status: draft · 2026-07-09 · Owner: Artem

**Correction (2026-07-09, later same day, PR #16):** the Non-goal below ("removing
the now-unused `platform` backend entry ... is dead code, left as-is") caused a
real regression — the `platform` role lost its ServiceAccount/RBAC/NetworkPolicy
access because that entry was the only place carrying it, and nothing routed to
it anymore. Fixed by repointing the `platform` backend entry itself at
`claudeSpec`/`CLAUDE_AUTH_SECRET_NAME` (preserving this design's z.ai-avoidance
goal — same Anthropic account, same shared rate window — via a shared
`RateWindowLimiter`) while keeping its ServiceAccount/secret/podLabel options,
and routing `platform.ts` back through `backend: 'platform'` instead of
`'claude'`. The design intent below (move `platform`'s model/credential off
z.ai) still holds; only the "which map entry" mechanics changed.

## Context

Artem is repeatedly hitting z.ai's concurrency-limit rejections (z.ai's plans cap how many sessions can be in flight at once) when running multiple sessions in parallel across the `pi` backend (which routes `implement` today) and the `platform` role (hardcoded to z.ai's GLM). This is distinct from the already-fixed `issue-acme-94` incident ([2026-07-08-provider-rate-limit-fallback-design.md](2026-07-08-provider-rate-limit-fallback-design.md)), which handled z.ai's Fair Usage Policy 429 with a one-shot same-backend fallback for `pi`.

A true bidirectional claude↔z.ai fallback (retry the other provider automatically in either direction on a rate-limit error) was considered and explicitly set aside: z.ai-via-claude and real-Anthropic-via-claude are reached by swapping `ANTHROPIC_BASE_URL`/token for the whole `claude` CLI process, not by changing a model string the way `pi`'s native multi-provider routing does — so building it means generalizing `RateLimitFallbackBackend` to retry against a whole alternate `AgentBackend` instance (not just a different model string on the same instance) plus standing up a second `claude`-CLI backend instance pointed at z.ai. Artem judged this not worth the design/code surface right now ("I don't see any good solution, so let's do smth simple").

The simple alternative: stop routing the two heaviest/most session-heavy consumers through z.ai/`pi` at all.

- `implement` is the highest-volume `devCycle` stage and currently defaults to `claude`/`claude-sonnet-5` in `DEFAULT_PROJECT_CONFIG` — not actually on z.ai today, but Artem wants it moved to OpenRouter's DeepSeek V4 Flash regardless, to keep the subscription-lane `claude` backend's usage window free for `plan`/`design`/`review`/etc. and avoid per-project z.ai routing entirely for this stage.
- The `platform` role (`packages/workflows/src/platform.ts`) is hardcoded to `{ backend: 'platform', model: 'zai/glm-5.2' }` — a dedicated `pi`-CLI instance with its own ServiceAccount/secret, per the code's own comment. Every platform-question run adds to z.ai's concurrent-session count. Moving it to the shared `claude` backend removes that entirely.

No `agentops.json` exists anywhere in this repo yet (confirmed by search), so the only in-repo home for per-stage routing is `DEFAULT_PROJECT_CONFIG` — the fallback every project gets absent its own override. Per Artem's choice, this change targets that engine-wide default, not a project-specific config.

## Goal

- `DEFAULT_PROJECT_CONFIG.routing.implement` routes through OpenRouter's DeepSeek V4 Flash instead of `claude`/`claude-sonnet-5`.
- The `platform` role's hardcoded model routes through the shared `claude` backend at `claude-sonnet-5` instead of the dedicated `platform` (z.ai/GLM) backend.
- `plan`/`design`/every other stage's routing is untouched.

## Non-goals

- **Bidirectional (or any) claude↔z.ai rate-limit fallback.** Explicitly evaluated and deferred — see Context. Carried forward as an open question below, not solved here.
- **Removing the now-unused `'platform'` backend entry** in `buildBackends()` (`packages/worker/src/main.ts`) or its chart/secret wiring. Once `platform.ts` no longer references it, it's dead code, but ripping out worker wiring and chart values is out of scope for this pass — left as-is.
- **A LiteLLM-fronted budget cap for the new OpenRouter route.** `pi`'s native provider routing (used here, same mechanism as the existing z.ai/OpenRouter fallback) has no budget enforcement in front of it, unlike the `litellm` backend. Not addressed here — noted as a risk below.
- **Re-verifying the already-merged `openrouter/deepseek-v4-pro` fallback string.** This design's live check (below) gives strong indirect confidence it's fine (same 2-segment convention, same pattern-matching mechanism, confirmed live against the real `pi` CLI), but no direct test of the `-pro` string itself was run.

## Design

### `DEFAULT_PROJECT_CONFIG.routing.implement` (`packages/contracts/src/project-config.ts`)

Changes from:
```ts
implement: { backend: 'claude', model: 'claude-sonnet-5', effort: 'high' },
```
to:
```ts
implement: { backend: 'pi', model: 'openrouter/deepseek-v4-flash', effort: 'high' },
```

No backend code changes needed: `pi-backend.ts`'s `buildArgs` already passes `req.model`/`req.effort` straight through to the CLI (`--model <req.model>`, `--thinking <effort>`) with no per-provider special-casing — the same mechanism already proven for the merged `zai/glm-5.2` → `openrouter/deepseek-v4-pro` fallback. Reuses the `OPENROUTER_API_KEY` already live in the `pi-credentials` secret (confirmed present in that fallback's design) — no new secret/infra.

**Model string verified live** against the real `pi` CLI (v0.80.2, installed locally) before writing this default, since nothing in this repo's test suite exercises the real CLI (everything mocks `spawn`):
- `pi --list-models deepseek` confirmed `openrouter  deepseek/deepseek-v4-flash` is a real cataloged OpenRouter model (alongside `deepseek/deepseek-v4-pro`, the string already used by the merged fallback).
- `pi --print --model "openrouter/deepseek-v4-flash" --no-session "..."` returned a real completion end-to-end through OpenRouter, confirming `pi`'s model-pattern resolution accepts the repo's existing 2-segment convention (`openrouter/<model-slug>`, dropping the upstream provider's own `deepseek/` prefix) rather than requiring the fully-qualified 3-segment form (`openrouter/deepseek/deepseek-v4-flash`) that the model's own catalog entry suggested — both forms resolved correctly, but the shorter one matches the repo's existing `openrouter/deepseek-v4-pro` convention and is used for consistency.

### `PLATFORM_MODEL` (`packages/workflows/src/platform.ts`)

Changes from:
```ts
// This role isn't scoped to one project, so there's no ProjectConfig to route
// through -- fixed here at the same reasoning-heavy tier devCycle uses for
// design/review. 'platform' (not 'pi') as the backend key: it's the pi CLI,
// but a distinct worker backend entry with this role's own ServiceAccount/secrets
// (see packages/worker/src/main.ts buildBackends).
const PLATFORM_MODEL = { backend: 'platform', model: 'zai/glm-5.2', effort: 'high' as const };
```
to:
```ts
// This role isn't scoped to one project, so there's no ProjectConfig to route
// through -- fixed here at the same reasoning-heavy tier devCycle uses for
// design/review. Shares the 'claude' backend devCycle stages use (no
// dedicated ServiceAccount/secret for this role) -- see
// docs/superpowers/specs/2026-07-09-routing-defaults-rebalance-design.md.
const PLATFORM_MODEL = { backend: 'claude', model: 'claude-sonnet-5', effort: 'high' as const };
```

## Testing strategy

- `project-config.test.ts`: update the assertion(s) covering `DEFAULT_PROJECT_CONFIG.routing.implement` to the new `ModelRef`.
- `platform.test.ts` (and `e2e/platform-agent.e2e.test.ts` if it asserts on backend/model fields): update any expectation referencing `backend: 'platform'` or `zai/glm-5.2` for the platform role to `backend: 'claude'` / `claude-sonnet-5`.
- No new test files — this changes existing default values, not logic; existing coverage just needs its expected values updated.

## Named risks

- **DeepSeek V4 Flash's code-generation quality for `implement` is unvalidated.** This work confirms the model string *resolves and returns a completion* — not that its output quality matches `claude-sonnet-5` for this pipeline's `implement` stage. Same caveat the original fallback design carried for `-pro`. Worth an `EvalRun`-style comparison later (M9 territory); not blocking this change.
- **`implement` now costs direct per-token API spend, uncapped.** OpenRouter is pay-as-you-go, not a subscription window, and `pi`'s native provider routing has no budget enforcement in front of it (unlike the `litellm` backend's hard virtual-key caps). Every `implement` call now has a real, currently-unbounded $ cost. Worth watching spend until a cap exists.
- **`platform` and `claude` now share one credential/usage window.** Per Artem's explicit choice to skip isolation. Platform-question runs now contend with `devCycle`'s `plan`/`design`/`implement`/etc. for the same Claude subscription window, whereas before they were fully isolated on a separate `pi`+z.ai lane. If platform-question volume grows, this narrows the effective 5h/weekly budget `devCycle` stages see.
- **z.ai concurrency limits are reduced, not eliminated.** This change removes two consumers (`implement`, `platform`) from z.ai/`pi` entirely, but doesn't fix the underlying concurrency cap for whatever a project still explicitly routes to `pi`+z.ai. If concurrency errors persist elsewhere, the deferred bidirectional-fallback work (below) becomes the next real fix.

## Package/file summary

- **Changed:** `packages/contracts/src/project-config.ts` (+ `project-config.test.ts`), `packages/workflows/src/platform.ts` (+ `platform.test.ts` / `e2e/platform-agent.e2e.test.ts` as needed).

## Open questions carried forward

- Whether `implement`'s new OpenRouter route needs an eventual LiteLLM-fronted budget cap once real spend data comes in (currently none).
- Whether the deferred bidirectional claude↔z.ai fallback is worth building later if z.ai concurrency errors persist elsewhere — would need `RateLimitFallbackBackend` generalized to retry against a full alternate `AgentBackend` (not just a fallback model string on the same instance), plus a second `claude`-CLI backend instance configured against z.ai's `ANTHROPIC_BASE_URL`.
