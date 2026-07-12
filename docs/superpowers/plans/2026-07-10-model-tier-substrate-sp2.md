# Model Tier Substrate & Cross-Backend Fallback (SP2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-stage concrete `ModelRef` routing with a **tier abstraction** — named, ordered model lists that own primary selection and session-limit fallback — and wire the generalized `TierFallbackBackend` so a `SessionLimitError` on any stage automatically retries against the next tier entry (possibly a different backend), while a `RateLimitError` waits it out.

**Architecture:** System-default tiers are hardcoded constants (DB promotion is SP3). A pure `resolveTier` function maps `(projectTiers?, tierName, effortOverride?)` → ordered `ModelRef[]`. Project config (`agentops.json`) references a tier per stage, never a concrete model in routing. The activity layer (`create-activities.ts`) resolves the tier and dispatches to the primary entry wrapped in `TierFallbackBackend`, which holds the backend registry and walks the remaining entries on `SessionLimitError`. Workflows send tier refs (strings — determinism-safe), never touching the fallback loop.

**Tech Stack:** TypeScript (strict), zod, vitest, pnpm workspaces, Temporal SDK.

**Spec:** `docs/superpowers/specs/2026-07-10-model-tiering-fallback-design.md` (Sections 1–3). This is sub-plan **SP2 of 3**:
- SP1 (merged, #47) — detection broadening (`RateLimitError` + `SessionLimitError`).
- SP2 (this plan) — model tier substrate + cross-backend fallback.
- SP3 (next) — DB-backed tiers + control API + Mission Control editor.

**Branch:** create `feat/model-tier-substrate` off `main`.

**Builds on:** SP1's `RateLimitError` / `SessionLimitError` / `isRateLimitMessage` / `isSessionLimitMessage` (all merged in #47, commit `28cd316`).

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `packages/policies/src/resolve-tier.ts` | `DEFAULT_TIERS` constant + `resolveTier` pure fn | Create |
| `packages/policies/src/resolve-tier.test.ts` | exhaustive unit tests | Create |
| `packages/policies/src/index.ts` | re-export | Modify |
| `packages/contracts/src/model.ts` | `StageRouteSchema`; `RoutingSchema` → tier refs | Modify |
| `packages/contracts/src/project-config.ts` | `escalation` → tier ref; `tiers` field; `DEFAULT_PROJECT_CONFIG` | Modify |
| `packages/contracts/src/agent-run.ts` | `AgentRunRequest` gains optional `tier` | Modify |
| `packages/backends/src/tier-fallback/tier-fallback-backend.ts` | generalized cross-backend fallback decorator | Create |
| `packages/backends/src/tier-fallback/tier-fallback-backend.test.ts` | decorator tests | Create |
| `packages/backends/src/provider-rate-limit.ts` | add `SessionLimitExhaustedError` | Modify |
| `packages/backends/src/index.ts` | exports | Modify |
| `packages/activities/src/create-activities.ts` | tier resolution + dispatch + error mapping | Modify |
| `packages/activities/src/create-activities.test.ts` | tier resolution + fallback tests | Modify |
| `packages/workflows/src/dev-cycle.ts` | send tier refs, not concrete ModelRef | Modify |
| `packages/workflows/src/whitebox-bughunt.ts` | send tier ref | Modify |
| `packages/workflows/src/platform.ts` | send tier ref (adopts tier abstraction) | Modify |
| `packages/worker/src/main.ts` | remove `wrapWithRateLimitFallback`, pass tier data | Modify |

**Removed:**
- `packages/backends/src/rate-limit-fallback/` — subsumed by `tier-fallback/`. (Its tests are rewritten for `TierFallbackBackend`.)

---

## Task 1: `resolveTier` pure function + system default tiers

**Files:**
- Create: `packages/policies/src/resolve-tier.ts`
- Test: `packages/policies/src/resolve-tier.test.ts`
- Modify: `packages/policies/src/index.ts`

`policies` stays pure (AGENTS hard rule #2) — no Temporal, no I/O, no async. This function is a pure lookup over two maps. Putting it here gives it the package's exhaustive-test discipline.

- [ ] **Step 1: Write the failing tests**

Create `packages/policies/src/resolve-tier.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_TIERS, resolveTier } from './resolve-tier';
import type { ModelRef } from '@agentops/contracts';

describe('resolveTier', () => {
  it('returns the global default tier entries when no project-local tier is defined', () => {
    const result = resolveTier(undefined, 'smart');
    expect(result).toEqual(DEFAULT_TIERS.smart);
  });

  it('project-local tier wins over a same-named global tier', () => {
    const projectLocal: Record<string, ModelRef[]> = {
      smart: [{ backend: 'pi', model: 'zai/glm-5.2' }],
    };
    const result = resolveTier(projectLocal, 'smart');
    expect(result).toEqual([{ backend: 'pi', model: 'zai/glm-5.2' }]);
    expect(result).not.toEqual(DEFAULT_TIERS.smart);
  });

  it('global fills in when project-local does not define the requested tier', () => {
    const projectLocal: Record<string, ModelRef[]> = {
      review: [{ backend: 'claude', model: 'opus' }],
    };
    const result = resolveTier(projectLocal, 'implementation');
    expect(result).toEqual(DEFAULT_TIERS.implementation);
  });

  it('applies effort override to every entry when provided', () => {
    const result = resolveTier(undefined, 'smart', 'low');
    expect(result.every((entry) => entry.effort === 'low')).toBe(true);
  });

  it('preserves entry effort when no override is provided', () => {
    const result = resolveTier(undefined, 'implementation');
    // The third default entry (zai/glm-5.2) ships with effort 'low'; the
    // others have their own or none. Just assert the override isn't applied.
    expect(result[0]?.effort).not.toBe('low');
  });

  it('throws a clear error when the tier is found in neither project-local nor global', () => {
    expect(() => resolveTier(undefined, 'nonexistent')).toThrow(/nonexistent/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run --config vitest.config.ts packages/policies/src/resolve-tier.test.ts`
Expected: FAIL — `Cannot find module './resolve-tier'`.

- [ ] **Step 3: Write `resolveTier` + `DEFAULT_TIERS`**

Create `packages/policies/src/resolve-tier.ts`:

```ts
import type { ModelRef } from '@agentops/contracts';

// System-default tiers. These are the hardcoded seed values SP3 will promote
// into a Postgres table editable from Mission Control. The order is BOTH the
// primary preference (entries[0] is the primary) AND the session-limit
// fallback chain (SessionLimitError advances to entries[1], [2], ...).
// See docs/superpowers/specs/2026-07-10-model-tiering-fallback-design.md.
export const DEFAULT_TIERS: Record<string, ModelRef[]> = {
  smart: [
    { backend: 'claude', model: 'opus', effort: 'high' },
    { backend: 'pi', model: 'zai/glm-5.2' },
    { backend: 'pi', model: 'openrouter/deepseek-v4-pro' },
  ],
  implementation: [
    { backend: 'claude', model: 'haiku', effort: 'high' },
    { backend: 'pi', model: 'openrouter/deepseek-v4-flash', effort: 'high' },
    { backend: 'pi', model: 'zai/glm-5.2', effort: 'low' },
  ],
  review: [
    { backend: 'claude', model: 'opus', effort: 'high' },
    { backend: 'pi', model: 'zai/glm-5.2' },
  ],
  escalation: [
    { backend: 'claude', model: 'opus', effort: 'max' },
  ],
  platform: [
    { backend: 'claude', model: 'claude-sonnet-5', effort: 'high' },
    { backend: 'pi', model: 'openrouter/deepseek-v4-pro' },
  ],
  bughunt: [
    { backend: 'claude', model: 'claude-sonnet-5', effort: 'high' },
    { backend: 'pi', model: 'openrouter/deepseek-v4-pro' },
  ],
};

// Resolve a tier name to its ordered ModelRef[], applying an optional effort
// override. Project-local tiers win over global defaults on name collision.
// Pure: no I/O, no async. Throws if the tier exists in neither source — the
// caller (the activity) maps that to a non-retryable ApplicationFailure.
export function resolveTier(
  projectTiers: Record<string, ModelRef[]> | undefined,
  tierName: string,
  effortOverride?: 'low' | 'medium' | 'high' | 'xhigh' | 'max',
): ModelRef[] {
  const entries = projectTiers?.[tierName] ?? DEFAULT_TIERS[tierName];
  if (!entries || entries.length === 0) {
    throw new Error(
      `resolveTier: tier "${tierName}" not found in project-local or global defaults`,
    );
  }
  if (!effortOverride) {
    return entries;
  }
  return entries.map((entry) => ({ ...entry, effort: effortOverride }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run --config vitest.config.ts packages/policies/src/resolve-tier.test.ts`
Expected: PASS — all 6 cases.

- [ ] **Step 5: Re-export from the package index**

In `packages/policies/src/index.ts`, add:

```ts
export * from './resolve-tier';
```

- [ ] **Step 6: Commit**

```bash
git add packages/policies/src/resolve-tier.ts packages/policies/src/resolve-tier.test.ts packages/policies/src/index.ts
git commit -m "feat(policies): add resolveTier pure function + system default tiers"
```

---

## Task 2: Contracts migration — routing → tier refs

**Files:**
- Modify: `packages/contracts/src/model.ts`
- Modify: `packages/contracts/src/project-config.ts`
- Modify: `packages/contracts/src/agent-run.ts`

This is the foundational change. `ModelRef` stays (it's the tier-entry shape), but disappears from `routing[stage]` and `escalation`.

- [ ] **Step 1: Add `StageRouteSchema` and migrate `RoutingSchema`**

In `packages/contracts/src/model.ts`, add a new schema above `RoutingSchema`:

```ts
// A stage routes to a named tier (not a concrete model), with an optional
// per-project effort override on top of the global tier. The tier resolves
// to an ordered ModelRef[] (primary + session-limit fallback chain).
export const StageRouteSchema = z.object({
  tier: z.string().min(1),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
});
export type StageRoute = z.infer<typeof StageRouteSchema>;
```

Change `RoutingSchema` from `ModelRefSchema.optional()` per stage to `StageRouteSchema.optional()` per stage. The full replacement:

```ts
export const RoutingSchema = z.object({
  context: StageRouteSchema.optional(),
  assess: StageRouteSchema.optional(),
  design: StageRouteSchema.optional(),
  plan: StageRouteSchema.optional(),
  implement: StageRouteSchema.optional(),
  full_verify: StageRouteSchema.optional(),
  review: StageRouteSchema.optional(),
  pr: StageRouteSchema.optional(),
  pr_babysit: StageRouteSchema.optional(),
  bughunt: StageRouteSchema.optional(),
  agent: StageRouteSchema.optional(),
});
```

- [ ] **Step 2: Migrate `escalation` and add `tiers` in `project-config.ts`**

In `packages/contracts/src/project-config.ts`:

Change the `escalation` field from:
```ts
  escalation: ModelRefSchema.optional(),
```
to:
```ts
  escalation: z.object({ tier: z.string().min(1) }).optional(),
```

Add a `tiers` field (project-local tier definitions) after `escalation`:
```ts
  tiers: z.record(z.string(), z.array(ModelRefSchema)).optional(),
```

Update `DEFAULT_PROJECT_CONFIG`. The routing entries change from concrete `ModelRef` to `StageRoute`:

```ts
export const DEFAULT_PROJECT_CONFIG: Omit<
  ProjectConfig,
  'fastVerifyCommands' | 'fullVerifyCommands' | 'image' | 'services' | 'initCommands'
> = {
  stages: {},
  routing: {
    context: { tier: 'smart' },
    assess: { tier: 'smart' },
    design: { tier: 'smart', effort: 'medium' },
    plan: { tier: 'smart' },
    implement: { tier: 'implementation', effort: 'high' },
    full_verify: { tier: 'smart', effort: 'high' },
    review: { tier: 'review' },
  },
  escalation: { tier: 'escalation' },
  brakes: { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 },
};
```

Remove the now-unused `ModelRefSchema` import if it's no longer referenced elsewhere in the file (it's still used by the new `tiers` field, so keep the import).

- [ ] **Step 3: Add `tier` to `AgentRunRequest`**

In `packages/contracts/src/agent-run.ts`, the `AgentRunRequestSchema` currently has required `backend` and `model` fields. Make them optional and add `tier`:

```ts
export const AgentRunRequestSchema = z.object({
  taskId: z.string().min(1),
  stage: StageSchema,
  attempt: z.number().int().positive(),
  callIndex: z.number().int().positive().default(1),
  // When tier is set, the activity resolves it to a concrete ModelRef[]
  // (primary + fallback chain). When unset, backend+model must be provided
  // directly (the platform.ts fixed-model path).
  tier: z.string().min(1).optional(),
  backend: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effort: EffortSchema.optional(),
  image: z.string().min(1).optional(),
  services: z.array(VerifyServiceSchema).optional(),
  promptRef: z.string().min(1),
  promptContext: z.record(z.string(), z.unknown()).default({}),
  promptSource: z.object({ repo: z.string().min(1), commit: z.string().min(1), path: z.string().min(1) }).optional(),
  workspaceRef: z.string().min(1),
  limits: AgentRunLimitsSchema,
});
```

Add a refine to enforce mutual exclusivity — either `tier` is set, or both `backend`+`model` are set:

```ts
.refine(
  (req) => Boolean(req.tier) || (Boolean(req.backend) && Boolean(req.model)),
  { message: 'either tier or (backend + model) must be provided' },
);
```

- [ ] **Step 4: Run the contracts tests + typecheck**

Run:
```bash
pnpm exec vitest run --config vitest.config.ts packages/contracts
pnpm --filter @agentops/contracts run typecheck
```
Expected: contracts tests pass (they test `parseProjectConfig` — verify the default-config path still works with the new tier-ref shape). The existing `agent-run.test.ts` tests that construct `AgentRunRequest` may need `backend`/`model` updates — check and fix any failures.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(contracts): migrate routing to tier refs, add project-local tiers"
```

---

## Task 3: `TierFallbackBackend` — the generalized cross-backend decorator

**Files:**
- Modify: `packages/backends/src/provider-rate-limit.ts` (add `SessionLimitExhaustedError`)
- Create: `packages/backends/src/tier-fallback/tier-fallback-backend.ts`
- Test: `packages/backends/src/tier-fallback/tier-fallback-backend.test.ts`
- Modify: `packages/backends/src/index.ts`

- [ ] **Step 1: Add `SessionLimitExhaustedError`**

In `packages/backends/src/provider-rate-limit.ts`, append after `SessionLimitError`:

```ts
// Thrown by TierFallbackBackend when every entry in the resolved tier chain
// has been exhausted (all hit SessionLimitError). The activity maps this to a
// non-retryable ApplicationFailure — no point burning Temporal's 5x retry
// budget on an account-wide cap that lasts hours.
export class SessionLimitExhaustedError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'SessionLimitExhaustedError';
  }
}
```

- [ ] **Step 2: Write the failing tests**

Create `packages/backends/src/tier-fallback/tier-fallback-backend.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { AgentRunResult, BackendRunRequest, ModelRef } from '@agentops/contracts';
import type { AgentBackend } from '../agent-backend';
import { RateLimitError, SessionLimitError, SessionLimitExhaustedError } from '../provider-rate-limit';
import { TierFallbackBackend } from './tier-fallback-backend';

const baseRequest: BackendRunRequest = {
  taskId: 't1',
  stage: 'design',
  attempt: 1,
  callIndex: 1,
  backend: 'claude',
  model: 'opus',
  workspaceRef: '/tmp/ws',
  limits: { maxTokens: 1000, timeoutMs: 5000 },
  prompt: 'do the thing',
};

const successResult: AgentRunResult = { output: 'ok', tokensIn: 1, tokensOut: 1, wallMs: 10 };

function makeBackend(resultOrError: AgentRunResult | Error): AgentBackend {
  const run = vi.fn();
  if (resultOrError instanceof Error) {
    run.mockRejectedValue(resultOrError);
  } else {
    run.mockResolvedValue(resultOrError);
  }
  return { run };
}

describe('TierFallbackBackend', () => {
  it('delegates straight through on primary success, without walking the chain', async () => {
    const inner = makeBackend(successResult);
    const registry = { claude: inner };
    const heartbeat = vi.fn();
    const backend = new TierFallbackBackend(inner, registry, [], 'design', heartbeat);

    const result = await backend.run(baseRequest);

    expect(result).toBe(successResult);
    expect(inner.run).toHaveBeenCalledTimes(1);
    expect(heartbeat).not.toHaveBeenCalled();
  });

  it('walks the chain on SessionLimitError, dispatching cross-backend via the registry', async () => {
    const primary = makeBackend(new SessionLimitError('session limit'));
    const fallbackResult: AgentRunResult = { output: 'fallback ok', tokensIn: 2, tokensOut: 2, wallMs: 20 };
    const fallback = makeBackend(fallbackResult);
    const registry = { claude: primary, pi: fallback };
    const heartbeat = vi.fn();
    const chain: ModelRef[] = [{ backend: 'pi', model: 'zai/glm-5.2' }];
    const backend = new TierFallbackBackend(primary, registry, chain, 'design', heartbeat);

    const result = await backend.run(baseRequest);

    expect(result).toBe(fallbackResult);
    expect(primary.run).toHaveBeenCalledTimes(1);
    expect(fallback.run).toHaveBeenCalledTimes(1);
    expect(fallback.run).toHaveBeenCalledWith(
      expect.objectContaining({ backend: 'pi', model: 'zai/glm-5.2' }),
    );
    expect(heartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'session-limit-fallback' }),
    );
  });

  it('propagates RateLimitError without walking the chain', async () => {
    const primary = makeBackend(new RateLimitError('429 rate limit'));
    const fallback = makeBackend(successResult);
    const registry = { claude: primary, pi: fallback };
    const backend = new TierFallbackBackend(primary, registry, [{ backend: 'pi', model: 'zai/glm-5.2' }], 'design', vi.fn());

    await expect(backend.run(baseRequest)).rejects.toThrow(RateLimitError);
    expect(fallback.run).not.toHaveBeenCalled();
  });

  it('throws SessionLimitExhaustedError when the entire chain is exhausted', async () => {
    const primary = makeBackend(new SessionLimitError('session limit'));
    const fallback = makeBackend(new SessionLimitError('also session limited'));
    const registry = { claude: primary, pi: fallback };
    const chain: ModelRef[] = [{ backend: 'pi', model: 'zai/glm-5.2' }];
    const backend = new TierFallbackBackend(primary, registry, chain, 'design', () => {});

    await expect(backend.run(baseRequest)).rejects.toThrow(SessionLimitExhaustedError);
  });

  it('propagates a non-session error during a fallback attempt immediately (does not swallow)', async () => {
    const primary = makeBackend(new SessionLimitError('session limit'));
    const fallback = makeBackend(new Error('fallback auth blew up'));
    const registry = { claude: primary, pi: fallback };
    const chain: ModelRef[] = [{ backend: 'pi', model: 'zai/glm-5.2' }];
    const backend = new TierFallbackBackend(primary, registry, chain, 'design', () => {});

    await expect(backend.run(baseRequest)).rejects.toThrow('fallback auth blew up');
  });

  it('propagates any non-throttle error from the primary without touching the chain', async () => {
    const boom = new Error('genuine outage');
    const primary = makeBackend(boom);
    const fallback = makeBackend(successResult);
    const registry = { claude: primary, pi: fallback };
    const backend = new TierFallbackBackend(primary, registry, [{ backend: 'pi', model: 'zai/glm-5.2' }], 'design', vi.fn());

    await expect(backend.run(baseRequest)).rejects.toThrow(boom);
    expect(fallback.run).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec vitest run --config vitest.config.ts packages/backends/src/tier-fallback/tier-fallback-backend.test.ts`
Expected: FAIL — `Cannot find module './tier-fallback-backend'`.

- [ ] **Step 4: Implement `TierFallbackBackend`**

Create `packages/backends/src/tier-fallback/tier-fallback-backend.ts`:

```ts
import type { AgentRunResult, BackendRunRequest, ModelRef } from '@agentops/contracts';
import type { AgentBackend } from '../agent-backend';
import { RateLimitError, SessionLimitError, SessionLimitExhaustedError } from '../provider-rate-limit';

// Per-call cross-backend fallback decorator. Holds the full backend registry
// (so a fallback can dispatch to a DIFFERENT backend instance, escaping the
// credential domain that hit the session limit) and the resolved tier chain
// (the primary's sibling entries, minus the primary itself). On
// SessionLimitError it walks the chain; on RateLimitError it lets the error
// propagate (the activity maps it to a retryable wait); on exhaustion it
// throws SessionLimitExhaustedError (non-retryable). See
// docs/superpowers/specs/2026-07-10-model-tiering-fallback-design.md (Section 3).
export class TierFallbackBackend implements AgentBackend {
  constructor(
    private readonly inner: AgentBackend,
    private readonly registry: Record<string, AgentBackend>,
    private readonly chain: ModelRef[],
    private readonly stage: string,
    private readonly heartbeat: (details: unknown) => void,
  ) {}

  async run(req: BackendRunRequest): Promise<AgentRunResult> {
    try {
      return await this.inner.run(req);
    } catch (err) {
      // RateLimit: propagate. The activity catch maps this to a retryable
      // ApplicationFailure with nextRetryDelay (wait it out, no model change).
      if (err instanceof RateLimitError) throw err;

      if (!(err instanceof SessionLimitError)) throw err;

      for (const fallback of this.chain) {
        const details = {
          event: 'session-limit-fallback',
          stage: this.stage,
          taskId: req.taskId,
          from: { backend: req.backend, model: req.model },
          to: { backend: fallback.backend, model: fallback.model, effort: fallback.effort },
        };
        this.heartbeat(details);
        console.warn(JSON.stringify(details));
        try {
          return await this.registry[fallback.backend].run({
            ...req,
            backend: fallback.backend,
            model: fallback.model,
            effort: fallback.effort ?? req.effort,
          });
        } catch (e) {
          if (e instanceof SessionLimitError) continue;
          throw e;
        }
      }
      throw new SessionLimitExhaustedError(
        `all fallback tiers exhausted for stage "${this.stage}" (session limit)`,
      );
    }
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run --config vitest.config.ts packages/backends/src/tier-fallback/tier-fallback-backend.test.ts`
Expected: PASS — all 6 cases.

- [ ] **Step 6: Export from index + remove old rate-limit-fallback**

In `packages/backends/src/index.ts`:
- Change line `export * from './rate-limit-fallback/rate-limit-fallback-backend';` to `export * from './tier-fallback/tier-fallback-backend';`
- Delete: `packages/backends/src/rate-limit-fallback/` directory (both files — the backend + its test, now subsumed).

- [ ] **Step 7: Verify nothing imports the old `RateLimitFallbackBackend`**

Run: `grep -rn "RateLimitFallbackBackend\|rate-limit-fallback" packages/ --include="*.ts"`
Expected: no results (the old module is gone; Task 7 removes the worker reference).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(backends): add TierFallbackBackend (cross-backend session-limit fallback)"
```

---

## Task 4: Activity wiring — tier resolution + dispatch + error mapping

**Files:**
- Modify: `packages/activities/src/create-activities.ts`
- Test: `packages/activities/src/create-activities.test.ts`

The activity becomes the tier-resolution point. It receives `AgentRunRequest` (with `tier` or `backend`+`model`), resolves the tier to a `ModelRef[]`, dispatches to the primary entry wrapped in `TierFallbackBackend`, and maps the new error classes.

- [ ] **Step 1: Read the current `create-activities.ts` runAgent implementation**

Run: `cat packages/activities/src/create-activities.ts`
Study the `runAgent` activity (the `try/catch` block that maps `LiteLlmBudgetExceededError`, `ProcessCliAuthError`, `RateWindowExceededError`). The new error mappings are added alongside these.

- [ ] **Step 2: Write the failing test for tier resolution + fallback**

In `packages/activities/src/create-activities.test.ts`, add a test that verifies the activity resolves a tier and dispatches with fallback. The test injects mock backends into the registry; the primary throws `SessionLimitError`, the fallback succeeds:

```ts
import { SessionLimitError } from '@agentops/backends';
import { resolveTier } from '@agentops/policies';

it('resolves a tier ref and falls back cross-backend on SessionLimitError', async () => {
  const fallbackResult = { output: 'fallback', tokensIn: 1, tokensOut: 1, wallMs: 1, promptHash: 'h', promptSource: 's' };
  const primaryRun = vi.fn().mockRejectedValue(new SessionLimitError('session limit'));
  const fallbackRun = vi.fn().mockResolvedValue(fallbackResult);
  const backends = {
    claude: { run: primaryRun },
    pi: { run: fallbackRun },
  };
  const activities = createActivities({
    backends,
    tracker: memoryTracker,
    scm: memoryScm,
    stats: memoryStats,
    stageResults,
    workspaces,
    prompts,
    registry: [],
    heartbeat: () => {},
  });

  const result = await activities.runAgent({
    taskId: 't1',
    stage: 'design',
    attempt: 1,
    callIndex: 1,
    tier: 'smart',
    promptRef: 'design.md',
    promptContext: {},
    workspaceRef: '/tmp/ws',
    limits: { maxTokens: 1000, timeoutMs: 5000 },
  });

  expect(result.output).toBe('fallback');
  expect(primaryRun).toHaveBeenCalledTimes(1);
  expect(fallbackRun).toHaveBeenCalledWith(
    expect.objectContaining({ backend: 'pi', model: 'zai/glm-5.2' }),
  );
});
```

(Adapt the mock setup to match the existing test file's helper patterns — check how other tests in the file construct `createActivities` deps and mirror that.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm exec vitest run --config vitest.config.ts packages/activities/src/create-activities.test.ts`
Expected: FAIL — the activity doesn't resolve tiers yet; it tries `deps.backends[undefined]` and throws "unknown backend."

- [ ] **Step 4: Implement tier resolution in `runAgent`**

In `packages/activities/src/create-activities.ts`, update the imports:

```ts
import {
  LiteLlmBudgetExceededError,
  ProcessCliAuthError,
  RateLimitError,
  RateWindowExceededError,
  SessionLimitExhaustedError,
  TierFallbackBackend,
  type AgentBackend,
} from '@agentops/backends';
import { resolveTier } from '@agentops/policies';
```

Update the `ActivityDependencies` interface to carry the backend registry and project tiers. Add to `ActivityDependencies`:

```ts
  projectTiers?: Record<string, ModelRef[]>;
```

(The `backends` field is already `Record<string, AgentBackend>` — that's the registry `TierFallbackBackend` needs.)

Rewrite the `runAgent` activity body. Replace the current `const backend = deps.backends[req.backend];` block with tier-aware resolution:

```ts
    async runAgent(req: AgentRunRequest): Promise<AgentRunResult & { promptHash: string; promptSource: string }> {
      // Resolve the tier (or use the concrete backend+model) to a primary
      // ModelRef + fallback chain.
      let primaryBackend: AgentBackend;
      let primaryModelRef: { backend: string; model: string; effort?: string };
      let chain: ModelRef[];

      if (req.tier) {
        const entries = resolveTier(deps.projectTiers, req.tier, req.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined);
        primaryModelRef = entries[0];
        chain = entries.slice(1);
        primaryBackend = deps.backends[primaryModelRef.backend];
        if (!primaryBackend) {
          throw new Error(`createActivities.runAgent: unknown backend "${primaryModelRef.backend}" for tier "${req.tier}"`);
        }
      } else {
        // Concrete backend+model path (no tier resolution, no fallback chain).
        primaryBackend = deps.backends[req.backend!];
        if (!primaryBackend) {
          throw new Error(`createActivities.runAgent: unknown backend "${req.backend}"`);
        }
        primaryModelRef = { backend: req.backend!, model: req.model!, effort: req.effort };
        chain = [];
      }

      const prompt = deps.prompts.render(req.promptRef, req.promptContext);
      const stage = req.stage;
      const heartbeat = deps.heartbeat ?? ((details: unknown) => Context.current().heartbeat(details));
      heartbeat({
        phase: 'started',
        taskId: req.taskId,
        stage,
        attempt: req.attempt,
        callIndex: req.callIndex,
        backend: primaryModelRef.backend,
        model: primaryModelRef.model,
      });

      // Wrap with TierFallbackBackend if there's a chain to walk; otherwise
      // dispatch directly (the concrete-model path or a single-entry tier).
      const dispatchBackend = chain.length > 0
        ? new TierFallbackBackend(primaryBackend, deps.backends, chain, stage, heartbeat)
        : primaryBackend;

      try {
        const result = await dispatchBackend.run({
          taskId: req.taskId,
          stage,
          attempt: req.attempt,
          callIndex: req.callIndex,
          backend: primaryModelRef.backend,
          model: primaryModelRef.model,
          effort: primaryModelRef.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined,
          image: req.image,
          services: req.services,
          workspaceRef: req.workspaceRef,
          limits: req.limits,
          prompt,
        });
        trace.getActiveSpan()?.setAttributes({
          'gen_ai.system': primaryModelRef.backend,
          'gen_ai.request.model': primaryModelRef.model,
          'gen_ai.usage.input_tokens': result.tokensIn,
          'gen_ai.usage.output_tokens': result.tokensOut,
          'agentops.stage': stage,
          'agentops.attempt': req.attempt,
        });
        return { ...result, promptHash: 'computed-hash', promptSource: 'pack' };
      } catch (err) {
        if (err instanceof LiteLlmBudgetExceededError) {
          throw ApplicationFailure.nonRetryable(err.message, 'LiteLlmBudgetExceededError');
        }
        if (err instanceof ProcessCliAuthError) {
          throw ApplicationFailure.nonRetryable(err.message, 'AuthError');
        }
        if (err instanceof RateWindowExceededError) {
          throw ApplicationFailure.create({
            message: err.message,
            type: 'RateWindowExceededError',
            nonRetryable: false,
            nextRetryDelay: err.retryAfterMs,
          });
        }
        // Session-limit chain exhausted: fail fast, don't burn the retry budget.
        if (err instanceof SessionLimitExhaustedError) {
          throw ApplicationFailure.nonRetryable(err.message, 'SessionLimitExhaustedError');
        }
        // Self-clearing rate limit (minutes): wait it out with a backoff.
        if (err instanceof RateLimitError) {
          throw ApplicationFailure.create({
            message: err.message,
            type: 'RateLimitError',
            nonRetryable: false,
            nextRetryDelay: 60_000,
          });
        }
        throw err;
      }
    },
```

**IMPORTANT:** The `promptHash` and `promptSource` fields in the return are placeholders for whatever the current code computes (read the current `runAgent` return to see how these are derived — they come from the `PromptPack.render` result). Do NOT use the literal `'computed-hash'`/`'pack'` — copy the real computation from the existing code. Check how the current implementation produces these values and preserve that logic.

- [ ] **Step 5: Run the activity tests to verify they pass**

Run: `pnpm exec vitest run --config vitest.config.ts packages/activities`
Expected: PASS — the new tier-resolution test plus all existing activity tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(activities): resolve tiers + wire TierFallbackBackend in runAgent"
```

---

## Task 5: Migrate `dev-cycle.ts` to send tier refs

**Files:**
- Modify: `packages/workflows/src/dev-cycle.ts`

The workflow sends `tier` instead of concrete `backend`/`model`. The activity resolves it.

- [ ] **Step 1: Update `runStageAgent` to send tier refs**

In `packages/workflows/src/dev-cycle.ts`, the `runStageAgent` function (~line 169) currently extracts `backend`/`model` from `config.routing[stage]`. Replace the routing-resolution logic:

The current code:
```ts
    const routed = config.routing[stage];
    const model = modelOverride ?? routed;
    const backend = model?.backend ?? 'stub';
    const modelName = model?.model ?? 'stub';
```

becomes:
```ts
    const routed = config.routing[stage];
    const tier = routed?.tier ?? 'smart';
    const effort = routed?.effort;
```

And the `runAgent` call's `backend`/`model`/`effort` fields change to `tier`/`effort`:

```ts
        result = await agentActivities.runAgent({
          taskId: input.taskId,
          stage,
          attempt,
          callIndex,
          tier,
          effort,
          image: config.image,
          services: config.services,
          promptRef: `${stage}.md`,
          promptContext: { taskId: input.taskId, goal: input.goal, ...extraContext },
          workspaceRef: state.workspaceRef,
          limits: { maxTokens: config.brakes.maxTokens, ...resolveStageLimits(config, stage) },
        });
```

- [ ] **Step 2: Handle the escalation override**

The escalation path (~line 293) currently passes `config.escalation` as a `ModelRef` override:
```ts
      const implementModel = useEscalation ? config.escalation : undefined;
      const implementOutput = await runStageAgent('implement', implementAttempt, 1, implementModel, {
```

`config.escalation` is now `{ tier: 'escalation' }` (a tier ref, not a `ModelRef`). The `runStageAgent` signature changes — `modelOverride` was a `ModelRef`, now it should be a tier-name override:

Change the `runStageAgent` signature from `modelOverride?: ModelRef` to `tierOverride?: string`:

```ts
  const runStageAgent = async (
    stage: RoutableStage,
    attempt: number,
    callIndex = 1,
    tierOverride?: string,
    extraContext: Record<string, unknown> = {},
  ): Promise<string> => {
    const routed = config.routing[stage];
    const tier = tierOverride ?? routed?.tier ?? 'smart';
    const effort = routed?.effort;
```

And the escalation call site:
```ts
      const escalationTier = useEscalation ? config.escalation?.tier : undefined;
      const implementOutput = await runStageAgent('implement', implementAttempt, 1, escalationTier, {
```

- [ ] **Step 3: Update `recordRunStats` calls**

`recordRunStats` currently receives `backend`/`model` from the resolved routing. After migration the workflow doesn't have concrete values. The `AgentRunResult` needs to carry the resolved backend/model back. Check the current `AgentRunResult` — if it doesn't include `backend`/`model`, add them as optional fields in the contracts, and have the activity populate them from the resolved primary (or the fallback that actually succeeded).

In `packages/contracts/src/agent-run.ts`, extend `AgentRunResultSchema`:

```ts
export const AgentRunResultSchema = z.object({
  output: z.string(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  wallMs: z.number().int().nonnegative(),
  resolvedBackend: z.string().optional(),
  resolvedModel: z.string().optional(),
});
```

In the activity (Task 4's `runAgent`), populate `resolvedBackend`/`resolvedModel` from whatever the `TierFallbackBackend` (or direct dispatch) actually ran. The simplest approach: have `TierFallbackBackend.run` return these alongside the result, or have the activity track which entry succeeded. Since `TierFallbackBackend` dispatches internally, the activity can set these to the primary values initially — but if a fallback succeeded, the real model differs. Acceptable approximation for SP2: the heartbeat already records the fallback event (with `from`/`to` model detail); `recordRunStats` records the primary for now, with a note that SP3 can surface the actually-ran model via the result. Update the `recordRunStats` calls to use `primaryModelRef.backend`/`primaryModelRef.model`.

In `dev-cycle.ts`, change the `recordRunStats` calls from:
```ts
      backend,
      model: modelName,
```
to use the result's resolved fields:
```ts
      backend: result.resolvedBackend ?? primaryBackendName,
      model: result.resolvedModel ?? primaryModelName,
```

(The `runStageAgent` helper should capture `tier` and pass it through; `recordRunStats` uses the result's resolved values.)

- [ ] **Step 4: Run the dev-cycle tests**

Run: `pnpm exec vitest run --config vitest.config.ts packages/workflows`
Expected: PASS. The e2e tests use stub backends — verify the stub backend is in the registry under a key the tier entries reference. The default `smart` tier references `claude`/`pi` backends; the tests' `buildBackends` must provide those. Check `packages/workflows/src/dev-cycle.test.ts` to see how it injects backends and adapt if needed (it may use `stub` — if so, add a test-specific tier override or a `stub` tier entry).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(workflows): migrate dev-cycle routing to tier refs"
```

---

## Task 6: Migrate `bughunt.ts` and `platform.ts`

**Files:**
- Modify: `packages/workflows/src/whitebox-bughunt.ts`
- Modify: `packages/workflows/src/platform.ts`

- [ ] **Step 1: Migrate `whitebox-bughunt.ts`**

In `packages/workflows/src/whitebox-bughunt.ts`, the current routing is:
```ts
const FALLBACK_MODEL: ModelRef = { backend: 'claude', model: 'claude-sonnet-5', effort: 'high' };
...
    const model = config.routing.bughunt ?? FALLBACK_MODEL;
    const result = await agentActivities.runAgent({
      taskId, stage: 'bughunt', attempt: 1, callIndex: 1,
      backend: model.backend, model: model.model, effort: model.effort,
```

Replace with tier-ref routing:
```ts
// Remove FALLBACK_MODEL — the default 'bughunt' tier (from DEFAULT_TIERS)
// replaces it.
...
    const tier = config.routing.bughunt?.tier ?? 'bughunt';
    const effort = config.routing.bughunt?.effort;
    const result = await agentActivities.runAgent({
      taskId, stage: 'bughunt', attempt: 1, callIndex: 1,
      tier, effort,
```

Update the `recordRunStats` call to use `result.resolvedBackend`/`result.resolvedModel` instead of `model.backend`/`model.model`. Remove the `import type { ModelRef }` if no longer used.

- [ ] **Step 2: Migrate `platform.ts`**

In `packages/workflows/src/platform.ts`, the current code uses a hardcoded `PLATFORM_MODEL`:
```ts
const PLATFORM_MODEL = { backend: 'platform', model: 'claude-sonnet-5', effort: 'high' as const };
```

Replace with a tier ref. The default `platform` tier exists in `DEFAULT_TIERS`. The runAgent call changes from concrete `backend`/`model` to `tier`:

```ts
const PLATFORM_TIER = 'platform';
```

And in the `runAgent` call:
```ts
      const result = await agentActivities.runAgent({
        taskId,
        stage: 'platform',
        attempt: 1,
        callIndex: call,
        tier: PLATFORM_TIER,
        promptRef: 'platform.md',
        ...
```

Update `recordRunStats` to use `result.resolvedBackend`/`result.resolvedModel`.

**Note:** the `platform` tier's first entry uses `backend: 'claude'` (from `DEFAULT_TIERS`), but `platform.ts` originally used `backend: 'platform'` (a distinct worker backend entry with its own ServiceAccount/secrets). For SP2, update the `DEFAULT_TIERS.platform` first entry to use `backend: 'platform'` instead of `backend: 'claude'` — BUT `ModelRefSchema.backend` enum doesn't include `'platform'`. Since `DEFAULT_TIERS` is a plain TS constant (not zod-validated in SP2), this works at runtime as long as the worker's `buildBackends` registry has a `'platform'` key (it does). Add a code comment noting that SP3's DB promotion will need to add `'platform'` to the `ModelRefSchema` backend enum. Update `DEFAULT_TIERS.platform` in `resolve-tier.ts`:

```ts
  platform: [
    { backend: 'platform' as ModelRef['backend'], model: 'claude-sonnet-5', effort: 'high' },
    { backend: 'pi', model: 'openrouter/deepseek-v4-pro' },
  ],
```

(The `as ModelRef['backend']` cast bypasses the TS enum narrowing — acceptable for the hardcoded constant until SP3 widens the enum.)

- [ ] **Step 3: Run the workflow tests**

Run: `pnpm exec vitest run --config vitest.config.ts packages/workflows`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(workflows): migrate bughunt + platform to tier refs"
```

---

## Task 7: Worker wiring — remove old fallback, pass tier data

**Files:**
- Modify: `packages/worker/src/main.ts`

- [ ] **Step 1: Remove `wrapWithRateLimitFallback` and the old `RateLimitFallbackBackend` import**

In `packages/worker/src/main.ts`:
- Remove the `RateLimitFallbackBackend` import from `@agentops/backends`.
- Remove the `wrapWithRateLimitFallback` function (~line 199).
- In `buildBackends`, unwrap `pi`: change `wrapWithRateLimitFallback(wrapWithRateWindow(...), 'PI', 'pi')` to just `wrapWithRateWindow(...)` for both the local and in-cluster branches.

The `pi` entry in both branches becomes:
```ts
      pi: wrapWithRateWindow(
        new K8sJobRunner(piSpec, buildJobRunnerOptions(batchApi, { authSecretName: process.env.PI_AUTH_SECRET_NAME })),
        buildRateWindowLimiter('PI'),
        'pi',
      ),
```
(local branch uses `ProcessCliRunner` instead of `K8sJobRunner`.)

- [ ] **Step 2: Pass `projectTiers` to the activity deps**

The activity now needs `projectTiers` from the resolved `ProjectConfig`. This is per-task config, loaded by the `resolveRepoConfig` activity — not available at worker startup. So `projectTiers` must be threaded per-call, not in the activity deps. Since the workflow has the `ProjectConfig` (from `resolveRepoConfig`), it should pass `config.tiers` alongside the `tier` ref in `AgentRunRequest`.

Add `projectTiers` to `AgentRunRequestSchema` in `packages/contracts/src/agent-run.ts`:

```ts
  projectTiers: z.record(z.string(), z.array(ModelRefSchema)).optional(),
```

In each workflow's `runAgent` call, pass `projectTiers: config.tiers`:

In `dev-cycle.ts` `runStageAgent`:
```ts
        result = await agentActivities.runAgent({
          ...
          tier,
          effort,
          projectTiers: config.tiers,
          ...
        });
```

Same for `bughunt.ts` and `platform.ts` (platform.ts has no config — omit, the activity falls back to global defaults).

In `create-activities.ts`, change `resolveTier(deps.projectTiers, ...)` to `resolveTier(req.projectTiers, ...)`.

- [ ] **Step 3: Run typecheck + full suite**

Run:
```bash
pnpm typecheck
pnpm test
pnpm lint
```
Expected: all green. Fix any remaining type errors from the migration.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(worker): remove old fallback wrapper, thread projectTiers through runAgent"
```

---

## Task 8: Open the PR, pass CI, and resolve the Bugbot review

**Files:** none (integration / review).

> Sequential and partly asynchronous — CI and Bugbot run on the remote PR.
> **HARD GATE: Do not mark this task complete until ALL Bugbot comments are
> resolved (fixed or replied to) AND CI is green. Check with
> `gh pr view --json reviews,comments` before claiming done.**

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
gh pr create --base main --fill --title "feat: model tier substrate + cross-backend fallback (SP2 of #27)"
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

(Note: as of SP1, Bugbot is not installed on this repo — if that's still the case, this step is vacuously satisfied. Confirm by checking whether any review bot is present.)

- [ ] **Step 6: Address each Bugbot comment**

REQUIRED SUB-SKILL: `receiving-code-review`. Verify before acting — reply to false positives; TDD-fix real findings, commit each referencing the finding, push once.

**Then mark each addressed thread resolved** (completion is gated on the unresolved-thread count):

```bash
gh api graphql -f query='query($o:String!,$r:String!,$p:Int!){repository(owner:$o,name:$r){pullRequest(number:$p){reviewThreads(first:100){nodes{id isResolved path comments(first:1){nodes{body}}}}}}}' -F o=est1908-agentic-ops -F r=agentops-engine -F p=<number>
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=<thread-id>
```

- [ ] **Step 7: Final verification**

```bash
gh pr checks                          # all green
gh pr view --json reviews,comments    # no comment left unaddressed
pnpm lint && pnpm typecheck && pnpm test   # suite green locally
```
Confirm no unresolved review threads remain, then mark this task complete.
