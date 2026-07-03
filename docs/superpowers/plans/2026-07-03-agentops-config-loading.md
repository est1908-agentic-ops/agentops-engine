# `agentops.json` Config Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load a real `ProductConfig` from `agentops.json` at the target repo's root (via `ScmPort.readFile`), replacing the CLI's hand-rolled `defaultConfig()`, with a clear, safety-conscious split between fields the engine can default and the one field (verify commands) it can't guess.

**Architecture:** A pure `parseProductConfig(raw)` in `packages/contracts` (deep-merges `stages`/`routing`/`brakes` over `DEFAULT_PRODUCT_CONFIG`, validates, throws a readable `InvalidProductConfigError`) plus a thin I/O wrapper `loadProductConfig(scm, repo)` in `packages/cli` that reads the file and delegates. A missing `agentops.json` resolves to full defaults, not an error — every field is now either optional or defaulted.

**Tech Stack:** TypeScript strict, zod, vitest.

**Prerequisite:** [claude-backend plan](2026-07-03-claude-backend.md) must be merged first — `DEFAULT_PRODUCT_CONFIG`'s routing entries use `ModelRef.effort`, which that plan adds to `ModelRefSchema`.

**Design doc:** [docs/superpowers/specs/2026-07-03-agentops-config-loading-design.md](../specs/2026-07-03-agentops-config-loading-design.md)

---

### Task 1: `fastVerifyCommands`/`fullVerifyCommands` become optional

**Files:**
- Modify: `packages/contracts/src/product-config.ts`
- Modify: `packages/contracts/src/product-config.test.ts`

- [ ] **Step 1: Update the failing test first**

Check `packages/contracts/src/product-config.test.ts` for an existing case asserting these fields are required (a `.parse({...without fastVerifyCommands...})` that currently expects a throw) — if one exists, invert it; otherwise add:

```ts
it('accepts a config with no verify commands configured at all', () => {
  expect(() =>
    ProductConfigSchema.parse({
      stages: {},
      routing: {},
      brakes: { maxIterations: 1, maxTokens: 1, maxBabysitRounds: 1 },
    }),
  ).not.toThrow();
});

it('still validates fastVerifyCommands/fullVerifyCommands as string arrays when present', () => {
  expect(() =>
    ProductConfigSchema.parse({
      fastVerifyCommands: ['pnpm lint'],
      fullVerifyCommands: 'not-an-array',
      stages: {},
      routing: {},
      brakes: { maxIterations: 1, maxTokens: 1, maxBabysitRounds: 1 },
    }),
  ).toThrow();
});
```

- [ ] **Step 2: Run the tests to verify the first one fails**

Run: `pnpm exec vitest run packages/contracts/src/product-config.test.ts`
Expected: FAIL on the first new test (`fastVerifyCommands`/`fullVerifyCommands` are still required).

- [ ] **Step 3: Implement**

```ts
// packages/contracts/src/product-config.ts
import { z } from 'zod';
import { ModelRefSchema, BrakesSchema, RoutingSchema, StageToggleSchema } from './model';

export const ProductConfigSchema = z.object({
  fastVerifyCommands: z.array(z.string()).optional(),
  fullVerifyCommands: z.array(z.string()).optional(),
  stages: StageToggleSchema,
  routing: RoutingSchema,
  escalation: ModelRefSchema.optional(),
  brakes: BrakesSchema,
});
export type ProductConfig = z.infer<typeof ProductConfigSchema>;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/contracts/src/product-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Fix the fallout in `dev-cycle.ts` — `verifyCommands` must handle both fields being absent**

`packages/workflows/src/dev-cycle.ts`'s `full_verify` step (added by the claude-backend plan) currently does `[...input.config.fastVerifyCommands, ...input.config.fullVerifyCommands].join('\n')`, which no longer typechecks once both fields are optional. Change it to:

```ts
    const verifyCommands =
      [...(input.config.fastVerifyCommands ?? []), ...(input.config.fullVerifyCommands ?? [])].join('\n') ||
      '(none configured — use your own judgment on the diff)';
```

- [ ] **Step 6: Run the workflows typecheck and the full e2e suite**

Run: `pnpm --filter @agentops/workflows run typecheck && pnpm e2e`
Expected: PASS — the e2e fixtures already pass `fastVerifyCommands: []`/`fullVerifyCommands: []` explicitly (empty arrays, not absent), so this change doesn't alter their behavior; it only widens what's *accepted*.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/product-config.ts packages/contracts/src/product-config.test.ts packages/workflows/src/dev-cycle.ts
git commit -m "feat(contracts): make ProductConfig verify commands optional"
```

---

### Task 2: `DEFAULT_PRODUCT_CONFIG`, `parseProductConfig`, `InvalidProductConfigError`

**Files:**
- Modify: `packages/contracts/src/product-config.ts`
- Modify: `packages/contracts/src/product-config.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// add to packages/contracts/src/product-config.test.ts
describe('parseProductConfig', () => {
  it('fully defaults an empty config', () => {
    const config = parseProductConfig({});
    expect(config.fastVerifyCommands).toBeUndefined();
    expect(config.fullVerifyCommands).toBeUndefined();
    expect(config.routing.implement).toEqual({ backend: 'claude', model: 'claude-sonnet-5', effort: 'high' });
    expect(config.brakes).toEqual({ maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 });
    expect(config.escalation).toBeUndefined();
  });

  it('passes verify commands through untouched when supplied', () => {
    const config = parseProductConfig({ fastVerifyCommands: ['pnpm lint'], fullVerifyCommands: ['pnpm test'] });
    expect(config.fastVerifyCommands).toEqual(['pnpm lint']);
    expect(config.fullVerifyCommands).toEqual(['pnpm test']);
  });

  it('deep-merges a partial routing override, keeping other stages at default', () => {
    const config = parseProductConfig({ routing: { implement: { backend: 'pi', model: 'pi-default' } } });
    expect(config.routing.implement).toEqual({ backend: 'pi', model: 'pi-default' });
    expect(config.routing.context).toEqual({ backend: 'claude', model: 'claude-sonnet-5', effort: 'medium' });
  });

  it('deep-merges a partial brakes override, keeping other brake numbers at default', () => {
    const config = parseProductConfig({ brakes: { maxTokens: 50_000 } });
    expect(config.brakes.maxTokens).toBe(50_000);
    expect(config.brakes.maxIterations).toBe(6);
  });

  it('throws InvalidProductConfigError when a field has the wrong type', () => {
    expect(() => parseProductConfig({ brakes: { maxTokens: 'not-a-number' } })).toThrow(InvalidProductConfigError);
  });

  it('throws InvalidProductConfigError when raw is not an object', () => {
    expect(() => parseProductConfig('not-an-object')).toThrow(InvalidProductConfigError);
    expect(() => parseProductConfig(null)).toThrow(InvalidProductConfigError);
    expect(() => parseProductConfig([])).toThrow(InvalidProductConfigError);
  });

  it('never deep-merges fastVerifyCommands/fullVerifyCommands — they replace wholesale or stay absent', () => {
    const config = parseProductConfig({ fastVerifyCommands: ['only-fast'] });
    expect(config.fastVerifyCommands).toEqual(['only-fast']);
    expect(config.fullVerifyCommands).toBeUndefined();
  });
});
```

(Add `parseProductConfig`, `InvalidProductConfigError` to the file's existing `product-config` imports.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/contracts/src/product-config.test.ts`
Expected: FAIL — `parseProductConfig`/`InvalidProductConfigError`/`DEFAULT_PRODUCT_CONFIG` don't exist yet.

- [ ] **Step 3: Implement**

```ts
// packages/contracts/src/product-config.ts
import { z, ZodError } from 'zod';
import { ModelRefSchema, BrakesSchema, RoutingSchema, StageToggleSchema } from './model';

export const ProductConfigSchema = z.object({
  fastVerifyCommands: z.array(z.string()).optional(),
  fullVerifyCommands: z.array(z.string()).optional(),
  stages: StageToggleSchema,
  routing: RoutingSchema,
  escalation: ModelRefSchema.optional(),
  brakes: BrakesSchema,
});
export type ProductConfig = z.infer<typeof ProductConfigSchema>;

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
  },
  brakes: { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 },
};

export class InvalidProductConfigError extends Error {
  constructor(
    message: string,
    public readonly issues?: unknown,
  ) {
    super(message);
  }
}

function formatZodError(err: ZodError): string {
  return err.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

export function parseProductConfig(raw: unknown): ProductConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidProductConfigError('agentops.json must be a JSON object');
  }
  const rawConfig = raw as Partial<ProductConfig>;
  const merged = {
    ...DEFAULT_PRODUCT_CONFIG,
    ...rawConfig,
    stages: { ...DEFAULT_PRODUCT_CONFIG.stages, ...rawConfig.stages },
    routing: { ...DEFAULT_PRODUCT_CONFIG.routing, ...rawConfig.routing },
    brakes: { ...DEFAULT_PRODUCT_CONFIG.brakes, ...rawConfig.brakes },
  };
  try {
    return ProductConfigSchema.parse(merged);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new InvalidProductConfigError(formatZodError(err), err.issues);
    }
    throw err;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/contracts/src/product-config.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/product-config.ts packages/contracts/src/product-config.test.ts
git commit -m "feat(contracts): add DEFAULT_PRODUCT_CONFIG and parseProductConfig"
```

---

### Task 3: `loadProductConfig` — the I/O half

**Files:**
- Create: `packages/cli/src/load-product-config.ts`
- Test: `packages/cli/src/load-product-config.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/src/load-product-config.test.ts
import { describe, expect, it } from 'vitest';
import { MemoryScmPort } from '@agentops/ports';
import { InvalidProductConfigError } from '@agentops/contracts';
import { loadProductConfig } from './load-product-config';

describe('loadProductConfig', () => {
  it('parses and validates a real agentops.json', async () => {
    const scm = new MemoryScmPort();
    scm.seedFile('octocat/demo', 'agentops.json', JSON.stringify({ fastVerifyCommands: ['pnpm lint'] }));

    const config = await loadProductConfig(scm, 'octocat/demo');

    expect(config.fastVerifyCommands).toEqual(['pnpm lint']);
    expect(config.routing.implement).toEqual({ backend: 'claude', model: 'claude-sonnet-5', effort: 'high' });
  });

  it('falls back to full defaults when agentops.json is missing', async () => {
    const scm = new MemoryScmPort();

    const config = await loadProductConfig(scm, 'octocat/demo');

    expect(config.fastVerifyCommands).toBeUndefined();
    expect(config.brakes.maxTokens).toBe(200_000);
  });

  it('throws InvalidProductConfigError on malformed JSON', async () => {
    const scm = new MemoryScmPort();
    scm.seedFile('octocat/demo', 'agentops.json', '{ not valid json');

    await expect(loadProductConfig(scm, 'octocat/demo')).rejects.toThrow(InvalidProductConfigError);
    await expect(loadProductConfig(scm, 'octocat/demo')).rejects.toThrow(/not valid JSON/);
  });

  it('throws InvalidProductConfigError (not a generic error) when the parsed content fails schema validation', async () => {
    const scm = new MemoryScmPort();
    scm.seedFile('octocat/demo', 'agentops.json', JSON.stringify({ brakes: { maxTokens: 'nope' } }));

    await expect(loadProductConfig(scm, 'octocat/demo')).rejects.toThrow(InvalidProductConfigError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/cli/src/load-product-config.test.ts`
Expected: FAIL — `Cannot find module './load-product-config'`.

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/load-product-config.ts
import type { ScmPort } from '@agentops/ports';
import { InvalidProductConfigError, parseProductConfig, type ProductConfig } from '@agentops/contracts';

export async function loadProductConfig(scm: ScmPort, repo: string): Promise<ProductConfig> {
  const raw = await scm.readFile(repo, 'agentops.json');
  if (raw === null) {
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/cli/src/load-product-config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add `@agentops/ports` to `packages/cli`'s dependencies**

`packages/cli/package.json` currently depends on `@agentops/contracts`/`@agentops/workflows`/`@temporalio/client` only — add `@agentops/ports`:

```json
{
  "name": "@agentops/cli",
  "version": "0.0.0",
  "private": true,
  "main": "src/main.ts",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "tsc -p tsconfig.json",
    "cli": "tsx src/main.ts"
  },
  "dependencies": {
    "@agentops/contracts": "workspace:*",
    "@agentops/ports": "workspace:*",
    "@agentops/workflows": "workspace:*",
    "@temporalio/client": "^1.11.0"
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/load-product-config.ts packages/cli/src/load-product-config.test.ts packages/cli/package.json
git commit -m "feat(cli): add loadProductConfig (agentops.json -> validated ProductConfig)"
```

---

### Task 4: Wire `cmdStart` to `loadProductConfig`, remove `defaultConfig()`

**Files:**
- Modify: `packages/cli/src/main.ts`

`cmdStart` today builds `TaskInput.config` from a hand-rolled `defaultConfig()` with no repo awareness at all. Replace it with `loadProductConfig`, keeping the existing zero-token local-demo path working by seeding a `MemoryScmPort` with the same verify commands `defaultConfig()` used to hardcode — routing/brakes now come from `DEFAULT_PRODUCT_CONFIG` instead of being duplicated here. **A real `GithubScmPort` selection (e.g. when `GITHUB_TOKEN` is set) is explicitly out of scope** — that's the shared M1 wiring step every other sub-project plan also defers; this task only removes the now-redundant hardcoded config and proves `loadProductConfig` works end-to-end via the CLI's existing demo flow.

- [ ] **Step 1: Replace `defaultConfig()` and update `cmdStart`**

Delete this function from `packages/cli/src/main.ts`:

```ts
function defaultConfig(): TaskInput['config'] {
  return {
    fastVerifyCommands: ['pnpm lint'],
    fullVerifyCommands: ['pnpm test'],
    stages: {},
    routing: {},
    brakes: { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 },
  };
}
```

Replace it with:

```ts
function seedDemoAgentopsConfig(scm: MemoryScmPort, repo: string): void {
  // Preserves today's zero-token local-demo behavior: explicit stub routing (matching
  // what an empty `routing: {}` used to fall back to via dev-cycle.ts's `?? 'stub'`) plus
  // the same verify commands the old hardcoded defaultConfig() used. A real product's
  // agentops.json would omit the routing override entirely to get DEFAULT_PRODUCT_CONFIG's
  // real claude/pi routing — this demo fixture opts out on purpose, loudly, in one place.
  const stubRoute = { backend: 'stub', model: 'stub-v1' };
  scm.seedFile(
    repo,
    'agentops.json',
    JSON.stringify({
      fastVerifyCommands: ['pnpm lint'],
      fullVerifyCommands: ['pnpm test'],
      routing: {
        context: stubRoute,
        assess: stubRoute,
        design: stubRoute,
        plan: stubRoute,
        implement: stubRoute,
        full_verify: stubRoute,
        review: stubRoute,
      },
    }),
  );
}
```

Update the imports at the top of the file:

```ts
import { Client, Connection } from '@temporalio/client';
import type { TaskInput } from '@agentops/contracts';
import { MemoryScmPort } from '@agentops/ports';
import { cancelSignal, clarifySignal, devCycle, resumeSignal, stateQuery, stopSignal } from '@agentops/workflows';
import { loadProductConfig } from './load-product-config';
```

Update `cmdStart`:

```ts
async function cmdStart(taskId: string, goal: string, product: string, repo: string, issueRef?: string): Promise<void> {
  const client = await getClient();
  const scm = new MemoryScmPort();
  seedDemoAgentopsConfig(scm, repo);
  const config = await loadProductConfig(scm, repo);
  const input: TaskInput = { taskId, product, repo, issueRef, goal, config };
  const handle = await client.workflow.start(devCycle, { taskQueue: TASK_QUEUE, workflowId: taskId, args: [input] });
  console.log(`started ${handle.workflowId}`);
}
```

(`TaskInput`'s import is still needed for the type annotation; everything else in `main.ts` — `getClient`, `cmdSignal`, `cmdState`, `main`'s command dispatch — is unchanged.)

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @agentops/cli run typecheck`
Expected: no errors.

- [ ] **Step 3: Manual smoke test against a local Temporal dev server**

This exercises the real CLI end-to-end, which no automated test in this plan covers (that's what Task 5 formalizes). Requires `temporal server start-dev` running in another terminal and the worker running (`pnpm --filter @agentops/worker run start` in a third terminal):

```bash
pnpm --filter @agentops/cli run cli start demo-task-1 "Add a widget" demo demo/repo
pnpm --filter @agentops/cli run cli state demo-task-1
```

Expected: the task starts and its `state` query returns a valid `DevCycleState` — confirms `loadProductConfig` didn't break the documented manual-run flow from the README.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/main.ts
git commit -m "feat(cli): load agentops.json via loadProductConfig, remove hardcoded defaultConfig"
```

---

### Task 5: Unit test for `cmdStart`'s config-loading wiring

**Files:**
- Create: `packages/cli/src/main.test.ts`

`packages/cli/src/main.ts` has no test file today — Task 4's manual smoke test proves it works once, but nothing regression-guards `seedDemoAgentopsConfig`'s exact shape. Extract just enough to unit test without spinning up a real Temporal client.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/main.test.ts
import { describe, expect, it } from 'vitest';
import { MemoryScmPort } from '@agentops/ports';
import { loadProductConfig } from './load-product-config';
import { seedDemoAgentopsConfig } from './main';

describe('seedDemoAgentopsConfig', () => {
  it('produces a config that keeps every stage on the stub backend', async () => {
    const scm = new MemoryScmPort();
    seedDemoAgentopsConfig(scm, 'demo/repo');

    const config = await loadProductConfig(scm, 'demo/repo');

    expect(config.fastVerifyCommands).toEqual(['pnpm lint']);
    expect(config.fullVerifyCommands).toEqual(['pnpm test']);
    for (const stage of ['context', 'assess', 'design', 'plan', 'implement', 'full_verify', 'review'] as const) {
      expect(config.routing[stage]).toEqual({ backend: 'stub', model: 'stub-v1' });
    }
  });
});
```

This requires `seedDemoAgentopsConfig` to be exported from `main.ts` (it's currently a private helper function) — add `export` to its declaration in Task 4's implementation:

```ts
export function seedDemoAgentopsConfig(scm: MemoryScmPort, repo: string): void {
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/cli/src/main.test.ts`
Expected: FAIL — `seedDemoAgentopsConfig` isn't exported yet (or the test file doesn't exist yet, depending on which half of Step 1 you did first; either way, make the export change now if you haven't).

- [ ] **Step 3: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/cli/src/main.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/main.ts packages/cli/src/main.test.ts
git commit -m "test(cli): cover seedDemoAgentopsConfig's stub-routing shape"
```

---

### Task 6: Full local verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full gate**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e
```

Expected: all green.

- [ ] **Step 2: Commit if the gate required any fixes**

```bash
git add -A
git commit -m "chore: fix lint/typecheck fallout from agentops.json config loading"
```

(Skip if Step 1 was already green.)

---

### Task 7: Open the PR, pass CI, and resolve the Bugbot review

**Files:** none (integration / review).

> Sequential and partly asynchronous — CI and Bugbot run on the remote PR.
> **HARD GATE: Do not mark this task complete until ALL Bugbot comments are
> resolved (fixed or replied to) AND CI is green. Check with
> `gh pr view --json reviews,comments` before claiming done.**

- [ ] **Step 1: Sync the latest `main`**

```bash
git fetch origin
git merge origin/main
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e   # resolve conflicts + commit first if any; fix fallout
```

- [ ] **Step 2: Push and open the PR**

```bash
git status --short && git rev-parse --abbrev-ref HEAD   # clean tree, on feature branch (not main)
git push -u origin HEAD
gh pr create --base main --fill --title "feat: load ProductConfig from agentops.json"
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

- [ ] **Step 6: Address each Bugbot comment**

REQUIRED SUB-SKILL: `receiving-code-review`. Verify before acting — reply to false positives; TDD-fix real findings, commit each referencing the finding, push once.

**Then mark each addressed thread resolved** (completion is gated on the unresolved-thread count, not just on having replied/fixed):

```bash
gh api graphql -f query='query($o:String!,$r:String!,$p:Int!){repository(owner:$o,name:$r){pullRequest(number:$p){reviewThreads(first:100){nodes{id isResolved path comments(first:1){nodes{body}}}}}}}' -F o=<owner> -F r=<repo> -F p=<number>
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=<thread-id>
```

**After pushing:** return to Step 4 (re-watch CI), then Step 5 (wait for re-review). Loop until Bugbot reports no unresolved comments.

- [ ] **Step 7: Final verification**

```bash
gh pr checks                          # all green
gh pr view --json reviews,comments    # no comment left unaddressed
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e   # suite green locally
```
Confirm no unresolved review threads remain, then mark this task complete.
