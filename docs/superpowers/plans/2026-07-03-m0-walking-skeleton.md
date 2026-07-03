# M0 Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the M0 walking skeleton per `docs/M0-SPEC.md` — the full DevCycle pipeline (context → design → plan → implement ⇄ full_verify → review → pr → pr_babysit → done) running end-to-end against in-memory stubs, with `pnpm e2e` proving all four required scenarios (happy path + repair round, brake + rescue, garbage verdict, exhausted rounds).

**Architecture:** pnpm/TS monorepo per `docs/ARCHITECTURE.md` §5.9. `contracts` (zod schemas) is the spine; `policies` is pure functions encoding the repair-loop/brakes/verdict/babysit semantics from §2, unit-tested to 100% branch coverage; `ports`/`backends` provide in-memory/stub adapters; `activities` wraps them for Temporal; `workflows/devCycle` is the deterministic orchestrator (no I/O — enforced by an ESLint import-boundary rule); `worker` and `cli` wire it together for manual runs. No k8s, no real forge, no real agent CLI, zero token spend — everything is stub/memory.

**Tech Stack:** Node 22, pnpm workspaces, TypeScript strict (CommonJS output), `@temporalio/{client,worker,workflow,activity,testing}`, zod, vitest + `@vitest/coverage-v8`, eslint 9 (flat config) + `typescript-eslint` + `eslint-plugin-import`, `tsx` for running worker/cli without a build step.

---

## File Structure

```
package.json                        # root scripts, devDependencies
pnpm-workspace.yaml
tsconfig.base.json
eslint.config.js
.prettierrc.json
vitest.config.ts                    # unit tests, path aliases to package src
vitest.coverage.config.ts           # policies-only 100% branch coverage gate
vitest.e2e.config.ts                # e2e suite config
e2e/
  helpers.ts                        # buildTestEnv(), waitForStatus()
  happy-path.e2e.test.ts
  brake-and-rescue.e2e.test.ts
  garbage-verdict.e2e.test.ts
  exhausted-rounds.e2e.test.ts
packages/
  contracts/
    src/{stage,model,product-config,task-input,stage-result,verdict,agent-run,run-stats,pr-feedback,index}.ts
  policies/
    src/{parse-verdict,evaluate-brakes,next-repair-action,babysit-decision,pre-implement-stages,index}.ts
  ports/
    src/{tracker-port,scm-port,index}.ts
    src/memory/{memory-tracker,memory-scm}.ts
  backends/
    src/{agent-backend,index}.ts
    src/stub/stub-backend.ts
  activities/
    src/{stats-store,stage-result-store,create-activities,index}.ts
  workflows/
    src/{activities-api,dev-cycle,index}.ts
  worker/
    src/{create-worker,main}.ts
  cli/
    src/main.ts
  prompts/README.md   # placeholder
  gateway/README.md   # placeholder
  ui/README.md        # placeholder
.github/workflows/ci.yaml
README.md (updated)
```

Each package gets its own `package.json` + `tsconfig.json` (extends `tsconfig.base.json`). Cross-package deps use `workspace:*`.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `package.json` (root)
- Create: `tsconfig.base.json`
- Create: `.prettierrc.json`
- Create: `eslint.config.js` (base rules only; determinism-boundary rules added in Task 19)
- Create: `vitest.config.ts`
- Modify: `.gitignore`
- Create: `packages/prompts/README.md`, `packages/gateway/README.md`, `packages/ui/README.md`

- [ ] **Step 1: Create the workspace and root manifest**

`pnpm-workspace.yaml`:

```yaml
packages:
  - 'packages/*'
```

`package.json`:

```json
{
  "name": "agentops-engine",
  "private": true,
  "version": "0.0.0",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "lint": "eslint .",
    "format": "prettier --check .",
    "typecheck": "pnpm -r run typecheck",
    "test": "vitest run --config vitest.config.ts",
    "test:policies-coverage": "vitest run --config vitest.coverage.config.ts",
    "e2e": "vitest run --config vitest.e2e.config.ts",
    "build": "pnpm -r run build"
  },
  "devDependencies": {}
}
```

Install the shared toolchain (this fills in `devDependencies` and lockfile versions):

```bash
pnpm add -D -w typescript vitest @vitest/coverage-v8 eslint @eslint/js typescript-eslint \
  eslint-plugin-import eslint-import-resolver-typescript prettier tsx
```

- [ ] **Step 2: Base TypeScript config**

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "CommonJS",
    "moduleResolution": "Node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "composite": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 3: Prettier + base ESLint config**

`.prettierrc.json`:

```json
{
  "singleQuote": true,
  "semi": true,
  "trailingComma": "all",
  "printWidth": 100
}
```

`eslint.config.js`:

```js
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const importPlugin = require('eslint-plugin-import');

module.exports = tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { import: importPlugin },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
```

- [ ] **Step 4: Root vitest config with per-package source aliases**

This lets unit tests import `@agentops/*` packages by name without a build step (each alias points straight at `src/index.ts`).

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@agentops/contracts': path.resolve(__dirname, 'packages/contracts/src/index.ts'),
      '@agentops/policies': path.resolve(__dirname, 'packages/policies/src/index.ts'),
      '@agentops/ports': path.resolve(__dirname, 'packages/ports/src/index.ts'),
      '@agentops/backends': path.resolve(__dirname, 'packages/backends/src/index.ts'),
      '@agentops/activities': path.resolve(__dirname, 'packages/activities/src/index.ts'),
      '@agentops/workflows': path.resolve(__dirname, 'packages/workflows/src/index.ts'),
    },
  },
});
```

- [ ] **Step 5: Gitignore + placeholder packages**

`.gitignore` — append:

```
.turbo/
*.tsbuildinfo
coverage/
```

`packages/prompts/README.md`:

```markdown
# prompts

Placeholder for M0. Versioned prompt packs per stage/role land here starting M1
(`docs/M0-SPEC.md` marks this package as "skip, placeholder dir fine" for M0).
```

`packages/gateway/README.md`:

```markdown
# gateway

Placeholder for M0. Webhook receiver → `startWorkflow`/signal; built in M3
(`docs/ARCHITECTURE.md` §5.3). M0 is CLI-triggered only.
```

`packages/ui/README.md`:

```markdown
# ui

Placeholder for M0. Mission Control (React SPA + BFF) is built in M4
(`docs/ARCHITECTURE.md` §5.10).
```

- [ ] **Step 6: Verify the scaffold installs cleanly**

Run: `pnpm install`
Expected: lockfile created, no errors (no packages exist yet so `pnpm -r` commands are no-ops).

- [ ] **Step 7: Commit**

```bash
git add pnpm-workspace.yaml package.json tsconfig.base.json .prettierrc.json eslint.config.js \
  vitest.config.ts .gitignore packages/prompts packages/gateway packages/ui pnpm-lock.yaml
git commit -m "chore: scaffold pnpm workspace, TS/eslint/vitest config"
```

---

### Task 2: `contracts` — stage vocabulary, model routing, product/task config

**Files:**
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/stage.ts`
- Create: `packages/contracts/src/stage.test.ts`
- Create: `packages/contracts/src/model.ts`
- Create: `packages/contracts/src/model.test.ts`
- Create: `packages/contracts/src/product-config.ts`
- Create: `packages/contracts/src/product-config.test.ts`
- Create: `packages/contracts/src/task-input.ts`
- Create: `packages/contracts/src/task-input.test.ts`
- Create: `packages/contracts/src/index.ts`

- [ ] **Step 1: Package manifest**

`packages/contracts/package.json`:

```json
{
  "name": "@agentops/contracts",
  "version": "0.0.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "zod": "^3.23.8"
  }
}
```

`packages/contracts/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

Run: `pnpm install` (links the new workspace package, pulls in zod).

- [ ] **Step 2: Write failing tests for the fixed vocabularies**

`packages/contracts/src/stage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { StageSchema, TaskStatusSchema, BlockReasonSchema } from './stage';

describe('StageSchema', () => {
  it('accepts every fixed-vocabulary stage', () => {
    const stages = [
      'context',
      'assess',
      'design',
      'plan',
      'implement',
      'full_verify',
      'review',
      'pr',
      'pr_babysit',
      'done',
      'failed',
    ];
    for (const stage of stages) {
      expect(StageSchema.parse(stage)).toBe(stage);
    }
  });

  it('rejects an invented stage name', () => {
    expect(() => StageSchema.parse('deploy')).toThrow();
  });
});

describe('TaskStatusSchema', () => {
  it('accepts pending|running|blocked|done|failed', () => {
    for (const status of ['pending', 'running', 'blocked', 'done', 'failed']) {
      expect(TaskStatusSchema.parse(status)).toBe(status);
    }
  });
});

describe('BlockReasonSchema', () => {
  it('accepts every fixed block reason', () => {
    const reasons = [
      'needs-clarification',
      'iteration-brake',
      'token-brake',
      'babysit-brake',
      'max-attempts',
      'hook-required-failed',
    ];
    for (const reason of reasons) {
      expect(BlockReasonSchema.parse(reason)).toBe(reason);
    }
  });
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `pnpm vitest run packages/contracts/src/stage.test.ts`
Expected: FAIL — `Cannot find module './stage'`.

- [ ] **Step 4: Implement the vocabulary schemas**

`packages/contracts/src/stage.ts`:

```ts
import { z } from 'zod';

export const StageSchema = z.enum([
  'context',
  'assess',
  'design',
  'plan',
  'implement',
  'full_verify',
  'review',
  'pr',
  'pr_babysit',
  'done',
  'failed',
]);
export type Stage = z.infer<typeof StageSchema>;

export const TaskStatusSchema = z.enum(['pending', 'running', 'blocked', 'done', 'failed']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const BlockReasonSchema = z.enum([
  'needs-clarification',
  'iteration-brake',
  'token-brake',
  'babysit-brake',
  'max-attempts',
  'hook-required-failed',
]);
export type BlockReason = z.infer<typeof BlockReasonSchema>;
```

- [ ] **Step 5: Run to confirm the vocabulary tests pass**

Run: `pnpm vitest run packages/contracts/src/stage.test.ts`
Expected: PASS (3 test files worth of assertions, all green).

- [ ] **Step 6: Model routing + brakes — failing test**

`packages/contracts/src/model.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ModelRefSchema, BrakesSchema, RoutingSchema } from './model';

describe('ModelRefSchema', () => {
  it('accepts a backend + model pair', () => {
    expect(ModelRefSchema.parse({ backend: 'stub', model: 'stub-v1' })).toEqual({
      backend: 'stub',
      model: 'stub-v1',
    });
  });

  it('rejects a blank model name', () => {
    expect(() => ModelRefSchema.parse({ backend: 'stub', model: '' })).toThrow();
  });
});

describe('BrakesSchema', () => {
  it('applies the default maxImplementAttempts of 3', () => {
    const brakes = BrakesSchema.parse({
      maxIterations: 6,
      maxTokens: 200_000,
      maxBabysitRounds: 5,
    });
    expect(brakes.maxImplementAttempts).toBe(3);
  });
});

describe('RoutingSchema', () => {
  it('allows a partial routing table', () => {
    const routing = RoutingSchema.parse({ implement: { backend: 'stub', model: 'stub-v1' } });
    expect(routing.implement).toEqual({ backend: 'stub', model: 'stub-v1' });
    expect(routing.review).toBeUndefined();
  });
});
```

- [ ] **Step 7: Run to confirm failure**, then **implement**

Run: `pnpm vitest run packages/contracts/src/model.test.ts` → expect FAIL (module not found).

`packages/contracts/src/model.ts`:

```ts
import { z } from 'zod';

export const ModelRefSchema = z.object({
  backend: z.enum(['claude', 'cursor', 'pi', 'codex', 'stub']),
  model: z.string().min(1),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const BrakesSchema = z.object({
  maxImplementAttempts: z.number().int().positive().default(3),
  maxIterations: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  maxBabysitRounds: z.number().int().positive(),
});
export type Brakes = z.infer<typeof BrakesSchema>;

export const RoutingSchema = z.object({
  context: ModelRefSchema.optional(),
  assess: ModelRefSchema.optional(),
  design: ModelRefSchema.optional(),
  plan: ModelRefSchema.optional(),
  implement: ModelRefSchema.optional(),
  full_verify: ModelRefSchema.optional(),
  review: ModelRefSchema.optional(),
  pr: ModelRefSchema.optional(),
  pr_babysit: ModelRefSchema.optional(),
});
export type Routing = z.infer<typeof RoutingSchema>;

export const StageToggleSchema = z.object({
  assess: z.boolean().optional(),
  triage: z.boolean().optional(),
});
export type StageToggle = z.infer<typeof StageToggleSchema>;
```

Run: `pnpm vitest run packages/contracts/src/model.test.ts`
Expected: PASS.

- [ ] **Step 8: ProductConfig — failing test**

`packages/contracts/src/product-config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ProductConfigSchema } from './product-config';

const validConfig = {
  fastVerifyCommands: ['pnpm lint'],
  fullVerifyCommands: ['pnpm test'],
  stages: { assess: false, triage: false },
  routing: { implement: { backend: 'stub', model: 'stub-v1' } },
  brakes: { maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 },
};

describe('ProductConfigSchema', () => {
  it('parses a minimal valid config', () => {
    const parsed = ProductConfigSchema.parse(validConfig);
    expect(parsed.brakes.maxImplementAttempts).toBe(3);
    expect(parsed.escalation).toBeUndefined();
  });

  it('accepts an optional escalation model', () => {
    const parsed = ProductConfigSchema.parse({
      ...validConfig,
      escalation: { backend: 'claude', model: 'opus' },
    });
    expect(parsed.escalation?.model).toBe('opus');
  });

  it('rejects a config missing brakes', () => {
    const { brakes: _brakes, ...withoutBrakes } = validConfig;
    expect(() => ProductConfigSchema.parse(withoutBrakes)).toThrow();
  });
});
```

- [ ] **Step 9: Run to confirm failure**, then **implement**

Run: `pnpm vitest run packages/contracts/src/product-config.test.ts` → expect FAIL.

`packages/contracts/src/product-config.ts`:

```ts
import { z } from 'zod';
import { ModelRefSchema, BrakesSchema, RoutingSchema, StageToggleSchema } from './model';

export const ProductConfigSchema = z.object({
  fastVerifyCommands: z.array(z.string()),
  fullVerifyCommands: z.array(z.string()),
  stages: StageToggleSchema,
  routing: RoutingSchema,
  escalation: ModelRefSchema.optional(),
  brakes: BrakesSchema,
});
export type ProductConfig = z.infer<typeof ProductConfigSchema>;
```

Run: `pnpm vitest run packages/contracts/src/product-config.test.ts`
Expected: PASS.

- [ ] **Step 10: TaskInput — failing test**

`packages/contracts/src/task-input.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TaskInputSchema } from './task-input';

const config = {
  fastVerifyCommands: [],
  fullVerifyCommands: [],
  stages: {},
  routing: {},
  brakes: { maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 },
};

describe('TaskInputSchema', () => {
  it('parses a task with an issueRef', () => {
    const parsed = TaskInputSchema.parse({
      taskId: 'task-1',
      product: 'demo',
      repo: 'demo/repo',
      issueRef: 'issue-42',
      goal: 'Add a widget',
      config,
    });
    expect(parsed.issueRef).toBe('issue-42');
  });

  it('allows issueRef to be omitted for ad-hoc goal-driven tasks', () => {
    const parsed = TaskInputSchema.parse({
      taskId: 'task-2',
      product: 'demo',
      repo: 'demo/repo',
      goal: 'Localize strings',
      config,
    });
    expect(parsed.issueRef).toBeUndefined();
  });
});
```

- [ ] **Step 11: Run to confirm failure**, then **implement**

Run: `pnpm vitest run packages/contracts/src/task-input.test.ts` → expect FAIL.

`packages/contracts/src/task-input.ts`:

```ts
import { z } from 'zod';
import { ProductConfigSchema } from './product-config';

export const TaskInputSchema = z.object({
  taskId: z.string().min(1),
  product: z.string().min(1),
  repo: z.string().min(1),
  issueRef: z.string().optional(),
  goal: z.string().min(1),
  config: ProductConfigSchema,
});
export type TaskInput = z.infer<typeof TaskInputSchema>;
```

Run: `pnpm vitest run packages/contracts/src/task-input.test.ts`
Expected: PASS.

- [ ] **Step 12: Barrel export + typecheck**

`packages/contracts/src/index.ts`:

```ts
export * from './stage';
export * from './model';
export * from './product-config';
export * from './task-input';
```

Run: `pnpm --filter @agentops/contracts run typecheck`
Expected: no errors (this will fail until Task 3 adds the remaining exports referenced later — for now it only re-exports what exists, so it should pass as-is).

- [ ] **Step 13: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): stage vocabulary, model routing, product/task config schemas"
```

---

### Task 3: `contracts` — stage results, verdicts, agent run I/O, run stats

**Files:**
- Create: `packages/contracts/src/stage-result.ts` (+ `.test.ts`)
- Create: `packages/contracts/src/verdict.ts` (+ `.test.ts`)
- Create: `packages/contracts/src/agent-run.ts` (+ `.test.ts`)
- Create: `packages/contracts/src/run-stats.ts` (+ `.test.ts`)
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: Write failing tests**

`packages/contracts/src/verdict.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { VerdictSchema } from './verdict';

describe('VerdictSchema', () => {
  it('parses a pass verdict without findings', () => {
    expect(VerdictSchema.parse({ kind: 'pass' })).toEqual({ kind: 'pass' });
  });

  it('parses a fail verdict with findings', () => {
    const parsed = VerdictSchema.parse({ kind: 'fail', findings: ['lint error on line 3'] });
    expect(parsed.findings).toEqual(['lint error on line 3']);
  });

  it('rejects an invented kind', () => {
    expect(() => VerdictSchema.parse({ kind: 'maybe' })).toThrow();
  });
});
```

`packages/contracts/src/stage-result.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { StageResultSchema } from './stage-result';

describe('StageResultSchema', () => {
  it('parses a human-authored design stage result', () => {
    const parsed = StageResultSchema.parse({
      stage: 'design',
      source: 'human',
      contentHash: 'abc123',
      tokens: 0,
      outcome: 'pass',
    });
    expect(parsed.source).toBe('human');
  });

  it('rejects a negative token count', () => {
    expect(() =>
      StageResultSchema.parse({
        stage: 'implement',
        source: 'agent',
        contentHash: 'abc',
        tokens: -1,
        outcome: 'pass',
      }),
    ).toThrow();
  });
});
```

`packages/contracts/src/agent-run.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AgentRunRequestSchema, AgentRunResultSchema } from './agent-run';

describe('AgentRunRequestSchema', () => {
  it('defaults callIndex to 1', () => {
    const parsed = AgentRunRequestSchema.parse({
      taskId: 'task-1',
      stage: 'implement',
      attempt: 1,
      backend: 'stub',
      model: 'stub-v1',
      promptRef: 'implement.md',
      workspaceRef: 'demo/repo',
      limits: { maxTokens: 1000, timeoutMs: 60_000 },
    });
    expect(parsed.callIndex).toBe(1);
  });
});

describe('AgentRunResultSchema', () => {
  it('parses a result with token/time usage', () => {
    const parsed = AgentRunResultSchema.parse({
      output: 'VERDICT: PASS',
      tokensIn: 100,
      tokensOut: 50,
      wallMs: 1200,
    });
    expect(parsed.tokensIn + parsed.tokensOut).toBe(150);
  });
});
```

`packages/contracts/src/run-stats.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { RunStatsSchema } from './run-stats';

describe('RunStatsSchema', () => {
  it('parses a full run-stats record', () => {
    const parsed = RunStatsSchema.parse({
      taskId: 'task-1',
      stage: 'implement',
      backend: 'stub',
      model: 'stub-v1',
      tokensIn: 100,
      tokensOut: 50,
      wallMs: 1200,
      outcome: 'pass',
    });
    expect(parsed.outcome).toBe('pass');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm vitest run packages/contracts/src/verdict.test.ts packages/contracts/src/stage-result.test.ts packages/contracts/src/agent-run.test.ts packages/contracts/src/run-stats.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/contracts/src/verdict.ts`:

```ts
import { z } from 'zod';

export const VerdictKindSchema = z.enum(['pass', 'fail', 'unparseable']);
export type VerdictKind = z.infer<typeof VerdictKindSchema>;

export const VerdictSchema = z.object({
  kind: VerdictKindSchema,
  findings: z.array(z.string()).optional(),
});
export type Verdict = z.infer<typeof VerdictSchema>;
```

`packages/contracts/src/stage-result.ts`:

```ts
import { z } from 'zod';
import { StageSchema } from './stage';

export const StageSourceSchema = z.enum(['agent', 'human', 'triage']);
export type StageSource = z.infer<typeof StageSourceSchema>;

export const StageOutcomeSchema = z.enum(['pass', 'fail', 'unparseable', 'skipped']);
export type StageOutcome = z.infer<typeof StageOutcomeSchema>;

export const StageResultSchema = z.object({
  stage: StageSchema,
  source: StageSourceSchema,
  contentHash: z.string().min(1),
  tokens: z.number().int().nonnegative(),
  outcome: StageOutcomeSchema,
});
export type StageResult = z.infer<typeof StageResultSchema>;
```

`packages/contracts/src/agent-run.ts`:

```ts
import { z } from 'zod';
import { StageSchema } from './stage';

export const AgentRunLimitsSchema = z.object({
  maxTokens: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
});
export type AgentRunLimits = z.infer<typeof AgentRunLimitsSchema>;

export const AgentRunRequestSchema = z.object({
  taskId: z.string().min(1),
  stage: StageSchema,
  attempt: z.number().int().positive(),
  callIndex: z.number().int().positive().default(1),
  backend: z.string().min(1),
  model: z.string().min(1),
  promptRef: z.string().min(1),
  workspaceRef: z.string().min(1),
  limits: AgentRunLimitsSchema,
});
export type AgentRunRequest = z.infer<typeof AgentRunRequestSchema>;

export const AgentRunResultSchema = z.object({
  output: z.string(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  wallMs: z.number().int().nonnegative(),
});
export type AgentRunResult = z.infer<typeof AgentRunResultSchema>;
```

`packages/contracts/src/run-stats.ts`:

```ts
import { z } from 'zod';
import { StageSchema } from './stage';
import { StageOutcomeSchema } from './stage-result';

export const RunStatsSchema = z.object({
  taskId: z.string().min(1),
  stage: StageSchema,
  backend: z.string().min(1),
  model: z.string().min(1),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  wallMs: z.number().int().nonnegative(),
  outcome: StageOutcomeSchema,
});
export type RunStats = z.infer<typeof RunStatsSchema>;
```

- [ ] **Step 4: Run to confirm passing**

Run: `pnpm vitest run packages/contracts/src/verdict.test.ts packages/contracts/src/stage-result.test.ts packages/contracts/src/agent-run.test.ts packages/contracts/src/run-stats.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the barrel export**

`packages/contracts/src/index.ts`:

```ts
export * from './stage';
export * from './model';
export * from './product-config';
export * from './task-input';
export * from './stage-result';
export * from './verdict';
export * from './agent-run';
export * from './run-stats';
```

Run: `pnpm --filter @agentops/contracts run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): stage-result, verdict, agent-run, and run-stats schemas"
```

---

### Task 4: `contracts` — PR feedback + feedback hashing

**Files:**
- Create: `packages/contracts/src/pr-feedback.ts`
- Create: `packages/contracts/src/pr-feedback.test.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: Write failing tests**

`packages/contracts/src/pr-feedback.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PrFeedbackSchema, feedbackHash } from './pr-feedback';

const feedback = (overrides: Partial<Parameters<typeof PrFeedbackSchema.parse>[0]> = {}) =>
  PrFeedbackSchema.parse({
    ciStatus: 'failed',
    unresolvedThreads: 1,
    comments: [{ id: 'c1', body: 'fix this', resolved: false }],
    ...overrides,
  });

describe('PrFeedbackSchema', () => {
  it('parses a feedback record', () => {
    expect(feedback().ciStatus).toBe('failed');
  });
});

describe('feedbackHash', () => {
  it('is stable for identical feedback', () => {
    expect(feedbackHash(feedback())).toBe(feedbackHash(feedback()));
  });

  it('changes when ciStatus changes', () => {
    expect(feedbackHash(feedback({ ciStatus: 'green', unresolvedThreads: 0, comments: [] }))).not.toBe(
      feedbackHash(feedback()),
    );
  });

  it('is insensitive to comment ordering', () => {
    const a = feedback({
      comments: [
        { id: 'c1', body: 'x', resolved: false },
        { id: 'c2', body: 'y', resolved: false },
      ],
    });
    const b = feedback({
      comments: [
        { id: 'c2', body: 'y', resolved: false },
        { id: 'c1', body: 'x', resolved: false },
      ],
    });
    expect(feedbackHash(a)).toBe(feedbackHash(b));
  });

  it('ignores already-resolved comments', () => {
    const withResolved = feedback({
      comments: [
        { id: 'c1', body: 'x', resolved: false },
        { id: 'c2', body: 'stale', resolved: true },
      ],
    });
    const withoutResolved = feedback({ comments: [{ id: 'c1', body: 'x', resolved: false }] });
    expect(feedbackHash(withResolved)).toBe(feedbackHash(withoutResolved));
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm vitest run packages/contracts/src/pr-feedback.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/contracts/src/pr-feedback.ts`:

```ts
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const CiStatusSchema = z.enum(['pending', 'green', 'failed']);
export type CiStatus = z.infer<typeof CiStatusSchema>;

export const PrCommentSchema = z.object({
  id: z.string().min(1),
  body: z.string(),
  resolved: z.boolean(),
});
export type PrComment = z.infer<typeof PrCommentSchema>;

export const PrFeedbackSchema = z.object({
  ciStatus: CiStatusSchema,
  unresolvedThreads: z.number().int().nonnegative(),
  comments: z.array(PrCommentSchema),
});
export type PrFeedback = z.infer<typeof PrFeedbackSchema>;

export function feedbackHash(feedback: PrFeedback): string {
  const unresolvedIds = feedback.comments
    .filter((comment) => !comment.resolved)
    .map((comment) => comment.id)
    .sort();
  const payload = JSON.stringify({
    ciStatus: feedback.ciStatus,
    unresolvedThreads: feedback.unresolvedThreads,
    unresolvedIds,
  });
  return createHash('sha256').update(payload).digest('hex');
}
```

Note for a later task: `feedbackHash` uses `node:crypto` but does no I/O, no `Date.now()`/`Math.random()`, and is a pure function of its input — it is safe to call from workflow code and will not trip the determinism-boundary ESLint rule added in Task 19 (that rule bans importing the `activities`/`ports`/`backends` *packages*, not `node:crypto`).

- [ ] **Step 4: Run to confirm passing**

Run: `pnpm vitest run packages/contracts/src/pr-feedback.test.ts`
Expected: PASS (5 tests green).

- [ ] **Step 5: Update the barrel export**

`packages/contracts/src/index.ts` — add:

```ts
export * from './pr-feedback';
```

Run: `pnpm --filter @agentops/contracts run typecheck && pnpm vitest run packages/contracts`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): PR feedback schema and feedbackHash"
```

---

### Task 5: `policies` — `parseVerdict`

**Files:**
- Create: `packages/policies/package.json`
- Create: `packages/policies/tsconfig.json`
- Create: `packages/policies/src/parse-verdict.ts`
- Create: `packages/policies/src/parse-verdict.test.ts`

- [ ] **Step 1: Package manifest**

`packages/policies/package.json`:

```json
{
  "name": "@agentops/policies",
  "version": "0.0.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@agentops/contracts": "workspace:*"
  }
}
```

`packages/policies/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "references": [{ "path": "../contracts" }]
}
```

Run: `pnpm install`.

- [ ] **Step 2: Write failing tests**

`packages/policies/src/parse-verdict.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseVerdict } from './parse-verdict';

describe('parseVerdict', () => {
  it('parses a clean PASS', () => {
    expect(parseVerdict('all good\nVERDICT: PASS', 'VERDICT:')).toEqual({ kind: 'pass' });
  });

  it('parses a FAIL with findings text', () => {
    expect(parseVerdict('VERDICT: FAIL missing null check', 'VERDICT:')).toEqual({
      kind: 'fail',
      findings: ['missing null check'],
    });
  });

  it('returns unparseable when the sentinel is missing entirely', () => {
    expect(parseVerdict('looks fine to me', 'VERDICT:')).toEqual({ kind: 'unparseable' });
  });

  it('returns unparseable when the sentinel value is garbled', () => {
    expect(parseVerdict('VERDICT: MAYBE', 'VERDICT:')).toEqual({ kind: 'unparseable' });
  });

  it('the last sentinel match wins when the agent restates its verdict', () => {
    const text = 'VERDICT: FAIL nope\nactually wait\nVERDICT: PASS';
    expect(parseVerdict(text, 'VERDICT:')).toEqual({ kind: 'pass' });
  });

  it('supports a different sentinel prefix (full_verify uses FULL:)', () => {
    expect(parseVerdict('FULL: FAIL 2 tests failed', 'FULL:')).toEqual({
      kind: 'fail',
      findings: ['2 tests failed'],
    });
  });

  it('never matches a sentinel prefix that only appears mid-line', () => {
    expect(parseVerdict('not a VERDICT: PASS really', 'VERDICT:')).toEqual({ kind: 'unparseable' });
  });
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `pnpm vitest run packages/policies/src/parse-verdict.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`packages/policies/src/parse-verdict.ts`:

```ts
import type { VerdictKind } from '@agentops/contracts';

export interface ParsedVerdict {
  kind: VerdictKind;
  findings?: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseVerdict(text: string, sentinel: string): ParsedVerdict {
  const pattern = new RegExp(`^${escapeRegExp(sentinel)}\\s*(PASS|FAIL)\\b(.*)$`, 'gm');
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    lastMatch = match;
  }

  if (!lastMatch) {
    return { kind: 'unparseable' };
  }

  const [, verdictWord, rest] = lastMatch;
  const kind: VerdictKind = verdictWord === 'PASS' ? 'pass' : 'fail';
  const findingsText = rest.trim();
  return findingsText.length > 0 ? { kind, findings: [findingsText] } : { kind };
}
```

The `^...$` with the `m` flag requires the sentinel to start a line — matching the spec's "sentinel-based" contract and rejecting the "mid-line" case. Because `sentinel` is a fixed literal supplied by the caller (`'VERDICT:'` / `'FULL:'`), not user input, this regex construction is safe (no ReDoS/injection surface).

- [ ] **Step 5: Run to confirm passing**

Run: `pnpm vitest run packages/policies/src/parse-verdict.test.ts`
Expected: PASS (7 tests green).

- [ ] **Step 6: Commit**

```bash
git add packages/policies
git commit -m "feat(policies): parseVerdict with last-match-wins sentinel parsing"
```

---

### Task 6: `policies` — `evaluateBrakes`

**Files:**
- Create: `packages/policies/src/evaluate-brakes.ts`
- Create: `packages/policies/src/evaluate-brakes.test.ts`

- [ ] **Step 1: Write failing tests**

`packages/policies/src/evaluate-brakes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { evaluateBrakes } from './evaluate-brakes';

const brakes = { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 };

describe('evaluateBrakes', () => {
  it('returns null when nothing has tripped', () => {
    expect(
      evaluateBrakes({ implementAttempts: 1, iterations: 1, cumulativeTokens: 10, babysitRounds: 0 }, brakes),
    ).toBeNull();
  });

  it('trips token-brake when cumulative tokens reach the ceiling', () => {
    expect(
      evaluateBrakes(
        { implementAttempts: 1, iterations: 1, cumulativeTokens: 200_000, babysitRounds: 0 },
        brakes,
      ),
    ).toBe('token-brake');
  });

  it('trips iteration-brake when iterations reach the ceiling', () => {
    expect(
      evaluateBrakes({ implementAttempts: 1, iterations: 6, cumulativeTokens: 10, babysitRounds: 0 }, brakes),
    ).toBe('iteration-brake');
  });

  it('trips babysit-brake when babysit rounds reach the cap', () => {
    expect(
      evaluateBrakes({ implementAttempts: 1, iterations: 1, cumulativeTokens: 10, babysitRounds: 5 }, brakes),
    ).toBe('babysit-brake');
  });

  it('is deterministic: token-brake takes precedence when multiple brakes trip at once', () => {
    expect(
      evaluateBrakes(
        { implementAttempts: 1, iterations: 6, cumulativeTokens: 200_000, babysitRounds: 5 },
        brakes,
      ),
    ).toBe('token-brake');
  });

  it('is deterministic: iteration-brake takes precedence over babysit-brake', () => {
    expect(
      evaluateBrakes({ implementAttempts: 1, iterations: 6, cumulativeTokens: 10, babysitRounds: 5 }, brakes),
    ).toBe('iteration-brake');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm vitest run packages/policies/src/evaluate-brakes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/policies/src/evaluate-brakes.ts`:

```ts
import type { BlockReason, Brakes } from '@agentops/contracts';

export interface BrakeCounters {
  implementAttempts: number;
  iterations: number;
  cumulativeTokens: number;
  babysitRounds: number;
}

export function evaluateBrakes(counters: BrakeCounters, brakes: Brakes): BlockReason | null {
  if (counters.cumulativeTokens >= brakes.maxTokens) {
    return 'token-brake';
  }
  if (counters.iterations >= brakes.maxIterations) {
    return 'iteration-brake';
  }
  if (counters.babysitRounds >= brakes.maxBabysitRounds) {
    return 'babysit-brake';
  }
  return null;
}
```

- [ ] **Step 4: Run to confirm passing**

Run: `pnpm vitest run packages/policies/src/evaluate-brakes.test.ts`
Expected: PASS (6 tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/policies
git commit -m "feat(policies): evaluateBrakes with deterministic trip precedence"
```

---

### Task 7: `policies` — `nextRepairAction`

**Files:**
- Create: `packages/policies/src/next-repair-action.ts`
- Create: `packages/policies/src/next-repair-action.test.ts`

- [ ] **Step 1: Write failing tests**

`packages/policies/src/next-repair-action.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { nextRepairAction, type RepairState } from './next-repair-action';

const brakes = { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 };

const baseState: RepairState = {
  implementAttempts: 1,
  iterations: 1,
  cumulativeTokens: 10,
  fullVerify: 'fail',
  review: 'unparseable',
  diffEmpty: false,
  brakes,
  hasEscalationModel: false,
};

describe('nextRepairAction', () => {
  it('continues when both full-verify and review pass', () => {
    const action = nextRepairAction({ ...baseState, fullVerify: 'pass', review: 'pass' });
    expect(action).toEqual({ kind: 'continue' });
  });

  it('requires BOTH verdicts to pass — full-verify pass alone is not enough', () => {
    const action = nextRepairAction({ ...baseState, fullVerify: 'pass', review: 'fail' });
    expect(action.kind).toBe('fix');
  });

  it('fixes (without escalation) on a non-final attempt', () => {
    const action = nextRepairAction(baseState);
    expect(action).toEqual({ kind: 'fix', useEscalationModel: false });
  });

  it('uses the escalation model on the final attempt when one is configured', () => {
    const action = nextRepairAction({ ...baseState, implementAttempts: 2, hasEscalationModel: true });
    expect(action).toEqual({ kind: 'fix', useEscalationModel: true });
  });

  it('does not escalate on the final attempt when no escalation model is configured', () => {
    const action = nextRepairAction({ ...baseState, implementAttempts: 2, hasEscalationModel: false });
    expect(action).toEqual({ kind: 'fix', useEscalationModel: false });
  });

  it('opens the PR anyway once attempts are exhausted with a non-empty diff', () => {
    const action = nextRepairAction({ ...baseState, implementAttempts: 3, diffEmpty: false });
    expect(action).toEqual({ kind: 'open-pr-exhausted' });
  });

  it('blocks on max-attempts when attempts are exhausted AND the diff is empty', () => {
    const action = nextRepairAction({ ...baseState, implementAttempts: 3, diffEmpty: true });
    expect(action).toEqual({ kind: 'block', reason: 'max-attempts' });
  });

  it('blocks on a tripped brake before considering exhaustion or escalation', () => {
    const action = nextRepairAction({
      ...baseState,
      implementAttempts: 3,
      cumulativeTokens: 200_000,
      diffEmpty: true,
    });
    expect(action).toEqual({ kind: 'block', reason: 'token-brake' });
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm vitest run packages/policies/src/next-repair-action.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/policies/src/next-repair-action.ts`:

```ts
import type { BlockReason, Brakes, VerdictKind } from '@agentops/contracts';
import { evaluateBrakes } from './evaluate-brakes';

export type RepairAction =
  | { kind: 'continue' }
  | { kind: 'fix'; useEscalationModel: boolean }
  | { kind: 'open-pr-exhausted' }
  | { kind: 'block'; reason: BlockReason };

export interface RepairState {
  implementAttempts: number;
  iterations: number;
  cumulativeTokens: number;
  fullVerify: VerdictKind;
  review: VerdictKind;
  diffEmpty: boolean;
  brakes: Brakes;
  hasEscalationModel: boolean;
}

export function nextRepairAction(state: RepairState): RepairAction {
  const brakeReason = evaluateBrakes(
    {
      implementAttempts: state.implementAttempts,
      iterations: state.iterations,
      cumulativeTokens: state.cumulativeTokens,
      babysitRounds: 0,
    },
    state.brakes,
  );
  if (brakeReason) {
    return { kind: 'block', reason: brakeReason };
  }

  const cleanPass = state.fullVerify === 'pass' && state.review === 'pass';
  if (cleanPass) {
    return { kind: 'continue' };
  }

  const attemptsExhausted = state.implementAttempts >= state.brakes.maxImplementAttempts;
  if (attemptsExhausted) {
    return state.diffEmpty ? { kind: 'block', reason: 'max-attempts' } : { kind: 'open-pr-exhausted' };
  }

  const isFinalAttempt = state.implementAttempts === state.brakes.maxImplementAttempts - 1;
  return { kind: 'fix', useEscalationModel: isFinalAttempt && state.hasEscalationModel };
}
```

- [ ] **Step 4: Run to confirm passing**

Run: `pnpm vitest run packages/policies/src/next-repair-action.test.ts`
Expected: PASS (8 tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/policies
git commit -m "feat(policies): nextRepairAction encoding the repair-loop semantics"
```

---

### Task 8: `policies` — `babysitDecision`

**Files:**
- Create: `packages/policies/src/babysit-decision.ts`
- Create: `packages/policies/src/babysit-decision.test.ts`

- [ ] **Step 1: Write failing tests**

`packages/policies/src/babysit-decision.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { PrFeedback } from '@agentops/contracts';
import { feedbackHash } from '@agentops/contracts';
import { babysitDecision } from './babysit-decision';

const greenFeedback: PrFeedback = { ciStatus: 'green', unresolvedThreads: 0, comments: [] };
const failedFeedback: PrFeedback = {
  ciStatus: 'failed',
  unresolvedThreads: 0,
  comments: [],
};
const pendingFeedback: PrFeedback = { ciStatus: 'pending', unresolvedThreads: 0, comments: [] };

describe('babysitDecision', () => {
  it('is merge_ready when CI is green and there are zero unresolved threads', () => {
    expect(babysitDecision(greenFeedback, new Set(), 0, 5)).toBe('merge_ready');
  });

  it('is waiting when CI is still pending and nothing is actionable', () => {
    expect(babysitDecision(pendingFeedback, new Set(), 0, 5)).toBe('waiting');
  });

  it('is actionable when CI failed and the feedback hash is new', () => {
    expect(babysitDecision(failedFeedback, new Set(), 0, 5)).toBe('actionable');
  });

  it('is waiting when the exact feedback set was already seen (dedupe)', () => {
    const seen = new Set([feedbackHash(failedFeedback)]);
    expect(babysitDecision(failedFeedback, seen, 0, 5)).toBe('waiting');
  });

  it('is actionable when unresolved review threads exist even if CI is green', () => {
    const feedback: PrFeedback = { ciStatus: 'green', unresolvedThreads: 2, comments: [] };
    expect(babysitDecision(feedback, new Set(), 0, 5)).toBe('actionable');
  });

  it('is braked once the round cap is reached, even with actionable feedback', () => {
    expect(babysitDecision(failedFeedback, new Set(), 5, 5)).toBe('braked');
  });

  it('prefers merge_ready over braked when the cap is reached but feedback is clean', () => {
    expect(babysitDecision(greenFeedback, new Set(), 5, 5)).toBe('merge_ready');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm vitest run packages/policies/src/babysit-decision.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/policies/src/babysit-decision.ts`:

```ts
import type { PrFeedback } from '@agentops/contracts';
import { feedbackHash } from '@agentops/contracts';

export type BabysitDecision = 'merge_ready' | 'actionable' | 'waiting' | 'braked';

export function babysitDecision(
  feedback: PrFeedback,
  seenHashes: ReadonlySet<string>,
  rounds: number,
  cap: number,
): BabysitDecision {
  const isMergeReady = feedback.ciStatus === 'green' && feedback.unresolvedThreads === 0;
  if (isMergeReady) {
    return 'merge_ready';
  }
  if (rounds >= cap) {
    return 'braked';
  }

  const isActionable = feedback.ciStatus === 'failed' || feedback.unresolvedThreads > 0;
  if (!isActionable) {
    return 'waiting';
  }

  return seenHashes.has(feedbackHash(feedback)) ? 'waiting' : 'actionable';
}
```

- [ ] **Step 4: Run to confirm passing**

Run: `pnpm vitest run packages/policies/src/babysit-decision.test.ts`
Expected: PASS (7 tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/policies
git commit -m "feat(policies): babysitDecision with feedback-hash dedupe"
```

---

### Task 9: `policies` — `preImplementStages`

**Files:**
- Create: `packages/policies/src/pre-implement-stages.ts`
- Create: `packages/policies/src/pre-implement-stages.test.ts`
- Create: `packages/policies/src/index.ts`

- [ ] **Step 1: Write failing tests**

`packages/policies/src/pre-implement-stages.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ProductConfig } from '@agentops/contracts';
import { preImplementStages } from './pre-implement-stages';

const baseConfig: ProductConfig = {
  fastVerifyCommands: [],
  fullVerifyCommands: [],
  stages: {},
  routing: {},
  brakes: { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 },
};

describe('preImplementStages', () => {
  it('returns context, design, plan by default (no assess, no triage)', () => {
    expect(
      preImplementStages({ config: baseConfig, hasHumanDesign: false, hasHumanPlan: false }),
    ).toEqual(['context', 'design', 'plan']);
  });

  it('includes assess when config.stages.assess is true', () => {
    const config = { ...baseConfig, stages: { assess: true } };
    expect(preImplementStages({ config, hasHumanDesign: false, hasHumanPlan: false })).toEqual([
      'context',
      'assess',
      'design',
      'plan',
    ]);
  });

  it('skips design+plan when triage is TRIVIAL and no human artifacts exist', () => {
    const config = { ...baseConfig, stages: { triage: true } };
    expect(
      preImplementStages({
        config,
        triageLevel: 'TRIVIAL',
        hasHumanDesign: false,
        hasHumanPlan: false,
      }),
    ).toEqual(['context']);
  });

  it('does NOT skip design+plan when triage is STANDARD', () => {
    const config = { ...baseConfig, stages: { triage: true } };
    expect(
      preImplementStages({
        config,
        triageLevel: 'STANDARD',
        hasHumanDesign: false,
        hasHumanPlan: false,
      }),
    ).toEqual(['context', 'design', 'plan']);
  });

  it('a human-authored design always wins over TRIVIAL triage', () => {
    const config = { ...baseConfig, stages: { triage: true } };
    expect(
      preImplementStages({
        config,
        triageLevel: 'TRIVIAL',
        hasHumanDesign: true,
        hasHumanPlan: false,
      }),
    ).toEqual(['context', 'design']);
  });

  it('a human-authored plan always wins over TRIVIAL triage, independent of design', () => {
    const config = { ...baseConfig, stages: { triage: true } };
    expect(
      preImplementStages({
        config,
        triageLevel: 'TRIVIAL',
        hasHumanDesign: false,
        hasHumanPlan: true,
      }),
    ).toEqual(['context', 'plan']);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm vitest run packages/policies/src/pre-implement-stages.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/policies/src/pre-implement-stages.ts`:

```ts
import type { ProductConfig, Stage } from '@agentops/contracts';

export type TriageLevel = 'TRIVIAL' | 'STANDARD';

export interface PreImplementInput {
  config: ProductConfig;
  triageLevel?: TriageLevel;
  hasHumanDesign: boolean;
  hasHumanPlan: boolean;
}

export function preImplementStages(input: PreImplementInput): Stage[] {
  const stages: Stage[] = ['context'];
  if (input.config.stages.assess) {
    stages.push('assess');
  }

  const triageIsTrivial = input.config.stages.triage === true && input.triageLevel === 'TRIVIAL';

  if (!triageIsTrivial || input.hasHumanDesign) {
    stages.push('design');
  }
  if (!triageIsTrivial || input.hasHumanPlan) {
    stages.push('plan');
  }

  return stages;
}
```

- [ ] **Step 4: Run to confirm passing**

Run: `pnpm vitest run packages/policies/src/pre-implement-stages.test.ts`
Expected: PASS (6 tests green).

- [ ] **Step 5: Barrel export + typecheck**

`packages/policies/src/index.ts`:

```ts
export * from './parse-verdict';
export * from './evaluate-brakes';
export * from './next-repair-action';
export * from './babysit-decision';
export * from './pre-implement-stages';
```

Run: `pnpm --filter @agentops/policies run typecheck && pnpm vitest run packages/policies`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/policies
git commit -m "feat(policies): preImplementStages with triage/human-artifact precedence"
```

---

### Task 10: `policies` — 100% branch coverage gate

**Files:**
- Create: `vitest.coverage.config.ts`
- Modify: `package.json` (already has `test:policies-coverage` script from Task 1 — verify it works now)

- [ ] **Step 1: Coverage config scoped to `policies`**

`vitest.coverage.config.ts`:

```ts
import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from './vitest.config';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ['packages/policies/src/**/*.test.ts'],
      coverage: {
        provider: 'v8',
        include: ['packages/policies/src/**/*.ts'],
        exclude: ['packages/policies/src/**/*.test.ts', 'packages/policies/src/index.ts'],
        thresholds: {
          branches: 100,
          lines: 100,
          functions: 100,
          statements: 100,
        },
      },
    },
  }),
);
```

- [ ] **Step 2: Run the coverage gate**

Run: `pnpm test:policies-coverage`
Expected: PASS with all four metrics at 100%. If any branch is uncovered, the report names the file/line — add the missing test case from the DoD requirement ("policies at 100% branch coverage") before moving on; do not lower the threshold.

- [ ] **Step 3: Commit**

```bash
git add vitest.coverage.config.ts
git commit -m "test(policies): enforce 100% branch coverage via dedicated vitest config"
```

---

### Task 11: `ports` — `TrackerPort` + in-memory adapter

**Files:**
- Create: `packages/ports/package.json`
- Create: `packages/ports/tsconfig.json`
- Create: `packages/ports/src/tracker-port.ts`
- Create: `packages/ports/src/memory/memory-tracker.ts`
- Create: `packages/ports/src/memory/memory-tracker.test.ts`

- [ ] **Step 1: Package manifest**

`packages/ports/package.json`:

```json
{
  "name": "@agentops/ports",
  "version": "0.0.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@agentops/contracts": "workspace:*"
  }
}
```

`packages/ports/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "references": [{ "path": "../contracts" }]
}
```

Add the alias to `vitest.config.ts` (Task 1's file):

```ts
      '@agentops/ports': path.resolve(__dirname, 'packages/ports/src/index.ts'),
```

Run: `pnpm install`.

- [ ] **Step 2: Define the port interface**

`packages/ports/src/tracker-port.ts`:

```ts
export interface Issue {
  ref: string;
  title: string;
  body: string;
  labels: string[];
}

export interface TrackerPort {
  getIssue(ref: string): Promise<Issue>;
  comment(ref: string, body: string): Promise<void>;
  label(ref: string, label: string): Promise<void>;
}
```

- [ ] **Step 3: Write a failing test for the memory adapter**

`packages/ports/src/memory/memory-tracker.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MemoryTrackerPort } from './memory-tracker';

describe('MemoryTrackerPort', () => {
  it('returns a seeded issue by ref', async () => {
    const tracker = new MemoryTrackerPort();
    tracker.seedIssue({ ref: 'issue-1', title: 'Bug', body: 'It breaks', labels: ['bug'] });
    await expect(tracker.getIssue('issue-1')).resolves.toEqual({
      ref: 'issue-1',
      title: 'Bug',
      body: 'It breaks',
      labels: ['bug'],
    });
  });

  it('throws for an unknown issue ref', async () => {
    const tracker = new MemoryTrackerPort();
    await expect(tracker.getIssue('missing')).rejects.toThrow();
  });

  it('records comments in order and exposes them for assertions', async () => {
    const tracker = new MemoryTrackerPort();
    await tracker.comment('issue-1', 'first');
    await tracker.comment('issue-1', 'second');
    expect(tracker.getComments('issue-1')).toEqual(['first', 'second']);
  });

  it('records labels without duplicates', async () => {
    const tracker = new MemoryTrackerPort();
    await tracker.label('issue-1', 'needs-triage');
    await tracker.label('issue-1', 'needs-triage');
    expect(tracker.getLabels('issue-1')).toEqual(['needs-triage']);
  });
});
```

- [ ] **Step 4: Run to confirm failure**

Run: `pnpm vitest run packages/ports/src/memory/memory-tracker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement**

`packages/ports/src/memory/memory-tracker.ts`:

```ts
import type { Issue, TrackerPort } from '../tracker-port';

export class MemoryTrackerPort implements TrackerPort {
  private readonly issues = new Map<string, Issue>();
  private readonly comments = new Map<string, string[]>();
  private readonly labels = new Map<string, Set<string>>();

  seedIssue(issue: Issue): void {
    this.issues.set(issue.ref, issue);
  }

  async getIssue(ref: string): Promise<Issue> {
    const issue = this.issues.get(ref);
    if (!issue) {
      throw new Error(`MemoryTrackerPort: unknown issue "${ref}"`);
    }
    return issue;
  }

  async comment(ref: string, body: string): Promise<void> {
    const existing = this.comments.get(ref) ?? [];
    existing.push(body);
    this.comments.set(ref, existing);
  }

  async label(ref: string, label: string): Promise<void> {
    const existing = this.labels.get(ref) ?? new Set<string>();
    existing.add(label);
    this.labels.set(ref, existing);
  }

  getComments(ref: string): string[] {
    return this.comments.get(ref) ?? [];
  }

  getLabels(ref: string): string[] {
    return Array.from(this.labels.get(ref) ?? []);
  }
}
```

- [ ] **Step 6: Run to confirm passing**

Run: `pnpm vitest run packages/ports/src/memory/memory-tracker.test.ts`
Expected: PASS (4 tests green).

- [ ] **Step 7: Commit**

```bash
git add packages/ports vitest.config.ts
git commit -m "feat(ports): TrackerPort and MemoryTrackerPort adapter"
```

---

### Task 12: `ports` — `ScmPort` + in-memory adapter

**Files:**
- Create: `packages/ports/src/scm-port.ts`
- Create: `packages/ports/src/memory/memory-scm.ts`
- Create: `packages/ports/src/memory/memory-scm.test.ts`
- Create: `packages/ports/src/index.ts`

- [ ] **Step 1: Define the port interface**

`packages/ports/src/scm-port.ts`:

```ts
import type { PrFeedback } from '@agentops/contracts';

export interface OpenPrRequest {
  repo: string;
  branch: string;
  title: string;
  body: string;
}

export interface OpenPrResult {
  prRef: string;
  url: string;
}

export interface ScmPort {
  openPr(req: OpenPrRequest): Promise<OpenPrResult>;
  getPrFeedback(prRef: string): Promise<PrFeedback>;
  push(branch: string, contentHash: string): Promise<void>;
  readFile(repo: string, path: string): Promise<string | null>;
}
```

- [ ] **Step 2: Write a failing test for the memory adapter**

`packages/ports/src/memory/memory-scm.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MemoryScmPort } from './memory-scm';

describe('MemoryScmPort', () => {
  it('opens a PR and returns an incrementing prRef', async () => {
    const scm = new MemoryScmPort();
    const first = await scm.openPr({ repo: 'demo/repo', branch: 'agentops/t1', title: 't1', body: 'b' });
    const second = await scm.openPr({ repo: 'demo/repo', branch: 'agentops/t2', title: 't2', body: 'b' });
    expect(first.prRef).toBe('pr-1');
    expect(second.prRef).toBe('pr-2');
    expect(scm.getOpenedPrs()).toHaveLength(2);
  });

  it('plays back a scripted feedback sequence in order', async () => {
    const scm = new MemoryScmPort();
    scm.scriptFeedback('pr-1', [
      { ciStatus: 'failed', unresolvedThreads: 1, comments: [{ id: 'c1', body: 'fix', resolved: false }] },
      { ciStatus: 'green', unresolvedThreads: 0, comments: [] },
    ]);
    const firstPoll = await scm.getPrFeedback('pr-1');
    const secondPoll = await scm.getPrFeedback('pr-1');
    expect(firstPoll.ciStatus).toBe('failed');
    expect(secondPoll.ciStatus).toBe('green');
  });

  it('repeats the last scripted feedback once the sequence is exhausted', async () => {
    const scm = new MemoryScmPort();
    scm.scriptFeedback('pr-1', [{ ciStatus: 'green', unresolvedThreads: 0, comments: [] }]);
    await scm.getPrFeedback('pr-1');
    const secondPoll = await scm.getPrFeedback('pr-1');
    expect(secondPoll.ciStatus).toBe('green');
  });

  it('throws when polling feedback for a PR with no script', async () => {
    const scm = new MemoryScmPort();
    await expect(scm.getPrFeedback('pr-unknown')).rejects.toThrow();
  });

  it('readFile returns null for a file that was never seeded', async () => {
    const scm = new MemoryScmPort();
    await expect(scm.readFile('demo/repo', 'README.md')).resolves.toBeNull();
  });

  it('readFile returns seeded content', async () => {
    const scm = new MemoryScmPort();
    scm.seedFile('demo/repo', 'README.md', '# demo');
    await expect(scm.readFile('demo/repo', 'README.md')).resolves.toBe('# demo');
  });
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `pnpm vitest run packages/ports/src/memory/memory-scm.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`packages/ports/src/memory/memory-scm.ts`:

```ts
import type { PrFeedback } from '@agentops/contracts';
import type { OpenPrRequest, OpenPrResult, ScmPort } from '../scm-port';

export class MemoryScmPort implements ScmPort {
  private readonly feedbackQueues = new Map<string, PrFeedback[]>();
  private readonly openedPrs: OpenPrRequest[] = [];
  private readonly files = new Map<string, string>();
  private prCounter = 0;

  scriptFeedback(prRef: string, sequence: PrFeedback[]): void {
    this.feedbackQueues.set(prRef, [...sequence]);
  }

  seedFile(repo: string, path: string, content: string): void {
    this.files.set(`${repo}:${path}`, content);
  }

  async openPr(req: OpenPrRequest): Promise<OpenPrResult> {
    this.prCounter += 1;
    const prRef = `pr-${this.prCounter}`;
    this.openedPrs.push(req);
    return { prRef, url: `https://memory.local/${req.repo}/${prRef}` };
  }

  async getPrFeedback(prRef: string): Promise<PrFeedback> {
    const queue = this.feedbackQueues.get(prRef);
    if (!queue || queue.length === 0) {
      throw new Error(`MemoryScmPort: no scripted feedback for "${prRef}"`);
    }
    return queue.length > 1 ? queue.shift()! : queue[0];
  }

  async push(): Promise<void> {}

  async readFile(repo: string, path: string): Promise<string | null> {
    return this.files.get(`${repo}:${path}`) ?? null;
  }

  getOpenedPrs(): OpenPrRequest[] {
    return [...this.openedPrs];
  }
}
```

- [ ] **Step 5: Run to confirm passing**

Run: `pnpm vitest run packages/ports/src/memory/memory-scm.test.ts`
Expected: PASS (6 tests green).

- [ ] **Step 6: Barrel export + typecheck**

`packages/ports/src/index.ts`:

```ts
export * from './tracker-port';
export * from './scm-port';
export * from './memory/memory-tracker';
export * from './memory/memory-scm';
```

Run: `pnpm --filter @agentops/ports run typecheck && pnpm vitest run packages/ports`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add packages/ports
git commit -m "feat(ports): ScmPort and MemoryScmPort adapter"
```

---

### Task 13: `backends` — `AgentBackend` + `StubBackend`

**Files:**
- Create: `packages/backends/package.json`
- Create: `packages/backends/tsconfig.json`
- Create: `packages/backends/src/agent-backend.ts`
- Create: `packages/backends/src/stub/stub-backend.ts`
- Create: `packages/backends/src/stub/stub-backend.test.ts`
- Create: `packages/backends/src/index.ts`

- [ ] **Step 1: Package manifest**

`packages/backends/package.json`:

```json
{
  "name": "@agentops/backends",
  "version": "0.0.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@agentops/contracts": "workspace:*"
  }
}
```

`packages/backends/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "references": [{ "path": "../contracts" }]
}
```

Add the alias to `vitest.config.ts`:

```ts
      '@agentops/backends': path.resolve(__dirname, 'packages/backends/src/index.ts'),
```

Run: `pnpm install`.

- [ ] **Step 2: Define the backend interface**

`packages/backends/src/agent-backend.ts`:

```ts
import type { AgentRunRequest, AgentRunResult } from '@agentops/contracts';

export interface AgentBackend {
  run(req: AgentRunRequest): Promise<AgentRunResult>;
}
```

- [ ] **Step 3: Write a failing test for the stub backend**

`packages/backends/src/stub/stub-backend.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { StubBackend } from './stub-backend';

const baseRequest = {
  taskId: 'task-1',
  backend: 'stub',
  model: 'stub-v1',
  promptRef: 'implement.md',
  workspaceRef: 'demo/repo',
  limits: { maxTokens: 1000, timeoutMs: 60_000 },
} as const;

describe('StubBackend', () => {
  it('returns the response scripted for (stage, attempt, callIndex)', async () => {
    const stub = new StubBackend();
    stub.scriptResponse('implement', 1, { output: 'diff --git a/f b/f' });
    const result = await stub.run({ ...baseRequest, stage: 'implement', attempt: 1, callIndex: 1 });
    expect(result.output).toBe('diff --git a/f b/f');
  });

  it('distinguishes repeated calls within the same (stage, attempt) via callIndex', async () => {
    const stub = new StubBackend();
    stub.scriptResponse('review', 1, { output: 'garbage' }, 1);
    stub.scriptResponse('review', 1, { output: 'VERDICT: PASS' }, 2);
    const call1 = await stub.run({ ...baseRequest, stage: 'review', attempt: 1, callIndex: 1 });
    const call2 = await stub.run({ ...baseRequest, stage: 'review', attempt: 1, callIndex: 2 });
    expect(call1.output).toBe('garbage');
    expect(call2.output).toBe('VERDICT: PASS');
  });

  it('falls back to a deterministic default response when nothing is scripted', async () => {
    const stub = new StubBackend();
    const result = await stub.run({ ...baseRequest, stage: 'context', attempt: 1, callIndex: 1 });
    expect(result).toEqual({ output: '', tokensIn: 10, tokensOut: 10, wallMs: 100 });
  });

  it('lets a scripted response override only some fields, defaulting the rest', async () => {
    const stub = new StubBackend();
    stub.scriptResponse('full_verify', 1, { output: 'FULL: FAIL', tokensIn: 5000 });
    const result = await stub.run({ ...baseRequest, stage: 'full_verify', attempt: 1, callIndex: 1 });
    expect(result).toEqual({ output: 'FULL: FAIL', tokensIn: 5000, tokensOut: 10, wallMs: 100 });
  });
});
```

- [ ] **Step 4: Run to confirm failure**

Run: `pnpm vitest run packages/backends/src/stub/stub-backend.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement**

`packages/backends/src/stub/stub-backend.ts`:

```ts
import type { AgentRunRequest, AgentRunResult, Stage } from '@agentops/contracts';
import type { AgentBackend } from '../agent-backend';

export interface ScriptedResponse {
  output: string;
  tokensIn?: number;
  tokensOut?: number;
  wallMs?: number;
}

const DEFAULT_RESPONSE: Required<ScriptedResponse> = {
  output: '',
  tokensIn: 10,
  tokensOut: 10,
  wallMs: 100,
};

export class StubBackend implements AgentBackend {
  private readonly script = new Map<string, ScriptedResponse>();

  scriptResponse(stage: Stage, attempt: number, response: ScriptedResponse, callIndex = 1): void {
    this.script.set(this.key(stage, attempt, callIndex), response);
  }

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    const scripted = this.script.get(this.key(req.stage, req.attempt, req.callIndex));
    return { ...DEFAULT_RESPONSE, ...scripted };
  }

  private key(stage: Stage, attempt: number, callIndex: number): string {
    return `${stage}#${attempt}.${callIndex}`;
  }
}
```

- [ ] **Step 6: Run to confirm passing**

Run: `pnpm vitest run packages/backends/src/stub/stub-backend.test.ts`
Expected: PASS (4 tests green).

- [ ] **Step 7: Barrel export + typecheck**

`packages/backends/src/index.ts`:

```ts
export * from './agent-backend';
export * from './stub/stub-backend';
```

Run: `pnpm --filter @agentops/backends run typecheck && pnpm vitest run packages/backends`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add packages/backends vitest.config.ts
git commit -m "feat(backends): AgentBackend interface and scriptable StubBackend"
```

---

### Task 14: `activities` — in-memory stats and stage-result stores

**Files:**
- Create: `packages/activities/package.json`
- Create: `packages/activities/tsconfig.json`
- Create: `packages/activities/src/stats-store.ts`
- Create: `packages/activities/src/stats-store.test.ts`
- Create: `packages/activities/src/stage-result-store.ts`
- Create: `packages/activities/src/stage-result-store.test.ts`

- [ ] **Step 1: Package manifest**

`packages/activities/package.json`:

```json
{
  "name": "@agentops/activities",
  "version": "0.0.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@agentops/contracts": "workspace:*",
    "@agentops/ports": "workspace:*",
    "@agentops/backends": "workspace:*"
  }
}
```

`packages/activities/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "references": [
    { "path": "../contracts" },
    { "path": "../ports" },
    { "path": "../backends" }
  ]
}
```

Add the alias to `vitest.config.ts`:

```ts
      '@agentops/activities': path.resolve(__dirname, 'packages/activities/src/index.ts'),
```

Run: `pnpm install`.

- [ ] **Step 2: Write failing tests**

`packages/activities/src/stats-store.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { InMemoryStatsStore } from './stats-store';

describe('InMemoryStatsStore', () => {
  it('records and returns run stats in insertion order', () => {
    const store = new InMemoryStatsStore();
    store.record({
      taskId: 't1',
      stage: 'implement',
      backend: 'stub',
      model: 'stub-v1',
      tokensIn: 10,
      tokensOut: 5,
      wallMs: 100,
      outcome: 'pass',
    });
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0].stage).toBe('implement');
  });
});
```

`packages/activities/src/stage-result-store.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { InMemoryStageResultStore } from './stage-result-store';

describe('InMemoryStageResultStore', () => {
  it('filters recorded results by taskId', () => {
    const store = new InMemoryStageResultStore();
    store.record({ taskId: 't1', stage: 'context', source: 'agent', contentHash: 'a', tokens: 1, outcome: 'pass' });
    store.record({ taskId: 't2', stage: 'context', source: 'agent', contentHash: 'b', tokens: 1, outcome: 'pass' });
    expect(store.forTask('t1')).toHaveLength(1);
    expect(store.forTask('t1')[0].contentHash).toBe('a');
  });
});
```

- [ ] **Step 3: Run to confirm failure**

Run: `pnpm vitest run packages/activities/src/stats-store.test.ts packages/activities/src/stage-result-store.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement**

`packages/activities/src/stats-store.ts`:

```ts
import type { RunStats } from '@agentops/contracts';

export interface StatsStore {
  record(stats: RunStats): void;
  all(): RunStats[];
}

export class InMemoryStatsStore implements StatsStore {
  private readonly entries: RunStats[] = [];

  record(stats: RunStats): void {
    this.entries.push(stats);
  }

  all(): RunStats[] {
    return [...this.entries];
  }
}
```

`packages/activities/src/stage-result-store.ts`:

```ts
import type { StageResult } from '@agentops/contracts';

export interface StageResultRecord extends StageResult {
  taskId: string;
}

export interface StageResultStore {
  record(result: StageResultRecord): void;
  forTask(taskId: string): StageResultRecord[];
}

export class InMemoryStageResultStore implements StageResultStore {
  private readonly entries: StageResultRecord[] = [];

  record(result: StageResultRecord): void {
    this.entries.push(result);
  }

  forTask(taskId: string): StageResultRecord[] {
    return this.entries.filter((entry) => entry.taskId === taskId);
  }
}
```

- [ ] **Step 5: Run to confirm passing**

Run: `pnpm vitest run packages/activities/src/stats-store.test.ts packages/activities/src/stage-result-store.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/activities vitest.config.ts
git commit -m "feat(activities): in-memory stats and stage-result stores"
```

---

### Task 15: `activities` — `createActivities`

**Files:**
- Create: `packages/activities/src/create-activities.ts`
- Create: `packages/activities/src/create-activities.test.ts`
- Create: `packages/activities/src/index.ts`

- [ ] **Step 1: Write failing tests**

`packages/activities/src/create-activities.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { StubBackend } from '@agentops/backends';
import { MemoryTrackerPort, MemoryScmPort } from '@agentops/ports';
import { createActivities } from './create-activities';
import { InMemoryStatsStore } from './stats-store';
import { InMemoryStageResultStore } from './stage-result-store';

function buildDeps() {
  return {
    backends: { stub: new StubBackend() },
    tracker: new MemoryTrackerPort(),
    scm: new MemoryScmPort(),
    stats: new InMemoryStatsStore(),
    stageResults: new InMemoryStageResultStore(),
  };
}

describe('createActivities', () => {
  it('runAgent delegates to the named backend', async () => {
    const deps = buildDeps();
    (deps.backends.stub as StubBackend).scriptResponse('implement', 1, { output: 'diff' });
    const activities = createActivities(deps);
    const result = await activities.runAgent({
      taskId: 't1',
      stage: 'implement',
      attempt: 1,
      callIndex: 1,
      backend: 'stub',
      model: 'stub-v1',
      promptRef: 'implement.md',
      workspaceRef: 'demo/repo',
      limits: { maxTokens: 1000, timeoutMs: 60_000 },
    });
    expect(result.output).toBe('diff');
  });

  it('runAgent throws for an unregistered backend', async () => {
    const activities = createActivities(buildDeps());
    await expect(
      activities.runAgent({
        taskId: 't1',
        stage: 'implement',
        attempt: 1,
        callIndex: 1,
        backend: 'nonexistent',
        model: 'x',
        promptRef: 'implement.md',
        workspaceRef: 'demo/repo',
        limits: { maxTokens: 1000, timeoutMs: 60_000 },
      }),
    ).rejects.toThrow(/unknown backend/);
  });

  it('recordRunStats and recordStageResult write to the injected stores', async () => {
    const deps = buildDeps();
    const activities = createActivities(deps);
    await activities.recordRunStats({
      taskId: 't1',
      stage: 'implement',
      backend: 'stub',
      model: 'stub-v1',
      tokensIn: 1,
      tokensOut: 1,
      wallMs: 1,
      outcome: 'pass',
    });
    await activities.recordStageResult({
      taskId: 't1',
      stage: 'implement',
      source: 'agent',
      contentHash: 'h1',
      tokens: 2,
      outcome: 'pass',
    });
    expect(deps.stats.all()).toHaveLength(1);
    expect(deps.stageResults.forTask('t1')).toHaveLength(1);
  });

  it('getIssue/commentOnIssue/labelIssue delegate to the tracker port', async () => {
    const deps = buildDeps();
    deps.tracker.seedIssue({ ref: 'issue-1', title: 'T', body: 'B', labels: [] });
    const activities = createActivities(deps);
    await expect(activities.getIssue('issue-1')).resolves.toMatchObject({ ref: 'issue-1' });
    await activities.commentOnIssue('issue-1', 'hello');
    await activities.labelIssue('issue-1', 'bug');
    expect(deps.tracker.getComments('issue-1')).toEqual(['hello']);
    expect(deps.tracker.getLabels('issue-1')).toEqual(['bug']);
  });

  it('openPr/getPrFeedback/pushBranch delegate to the scm port', async () => {
    const deps = buildDeps();
    const activities = createActivities(deps);
    const { prRef } = await activities.openPr({ repo: 'demo/repo', branch: 'b', title: 't', body: 'b' });
    deps.scm.scriptFeedback(prRef, [{ ciStatus: 'green', unresolvedThreads: 0, comments: [] }]);
    await expect(activities.getPrFeedback(prRef)).resolves.toMatchObject({ ciStatus: 'green' });
    await expect(activities.pushBranch('branch', 'hash')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm vitest run packages/activities/src/create-activities.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/activities/src/create-activities.ts`:

```ts
import type { AgentBackend } from '@agentops/backends';
import type { Issue, OpenPrRequest, OpenPrResult, ScmPort, TrackerPort } from '@agentops/ports';
import type { AgentRunRequest, AgentRunResult, PrFeedback, RunStats } from '@agentops/contracts';
import type { StageResultRecord, StageResultStore } from './stage-result-store';
import type { StatsStore } from './stats-store';

export interface ActivityDependencies {
  backends: Record<string, AgentBackend>;
  tracker: TrackerPort;
  scm: ScmPort;
  stats: StatsStore;
  stageResults: StageResultStore;
}

export function createActivities(deps: ActivityDependencies) {
  return {
    async runAgent(req: AgentRunRequest): Promise<AgentRunResult> {
      const backend = deps.backends[req.backend];
      if (!backend) {
        throw new Error(`createActivities.runAgent: unknown backend "${req.backend}"`);
      }
      return backend.run(req);
    },
    async getIssue(ref: string): Promise<Issue> {
      return deps.tracker.getIssue(ref);
    },
    async commentOnIssue(ref: string, body: string): Promise<void> {
      await deps.tracker.comment(ref, body);
    },
    async labelIssue(ref: string, label: string): Promise<void> {
      await deps.tracker.label(ref, label);
    },
    async openPr(req: OpenPrRequest): Promise<OpenPrResult> {
      return deps.scm.openPr(req);
    },
    async getPrFeedback(prRef: string): Promise<PrFeedback> {
      return deps.scm.getPrFeedback(prRef);
    },
    async pushBranch(branch: string, contentHash: string): Promise<void> {
      await deps.scm.push(branch, contentHash);
    },
    async recordStageResult(result: StageResultRecord): Promise<void> {
      deps.stageResults.record(result);
    },
    async recordRunStats(stats: RunStats): Promise<void> {
      deps.stats.record(stats);
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
```

- [ ] **Step 4: Run to confirm passing**

Run: `pnpm vitest run packages/activities/src/create-activities.test.ts`
Expected: PASS (5 tests green).

- [ ] **Step 5: Barrel export + typecheck**

`packages/activities/src/index.ts`:

```ts
export * from './stats-store';
export * from './stage-result-store';
export * from './create-activities';
```

Run: `pnpm --filter @agentops/activities run typecheck && pnpm vitest run packages/activities`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/activities
git commit -m "feat(activities): createActivities wiring backends/ports/stores into a Temporal-shaped API"
```

---

### Task 16: `workflows` — activities API surface, state, signals, query

**Files:**
- Create: `packages/workflows/package.json`
- Create: `packages/workflows/tsconfig.json`
- Create: `packages/workflows/src/activities-api.ts`

**Important:** `packages/workflows` may declare a dependency on `@agentops/contracts` and `@agentops/policies` ONLY (plus `@temporalio/workflow`). Do not add `@agentops/activities`, `@agentops/ports`, or `@agentops/backends` as a dependency here — that is the hard determinism-boundary rule from `AGENTS.md` #1, and Task 19 adds an ESLint rule that fails the build if it's violated.

- [ ] **Step 1: Package manifest**

`packages/workflows/package.json`:

```json
{
  "name": "@agentops/workflows",
  "version": "0.0.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@agentops/contracts": "workspace:*",
    "@agentops/policies": "workspace:*",
    "@temporalio/workflow": "^1.11.0"
  }
}
```

`packages/workflows/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "references": [{ "path": "../contracts" }, { "path": "../policies" }]
}
```

Add the alias to `vitest.config.ts`:

```ts
      '@agentops/workflows': path.resolve(__dirname, 'packages/workflows/src/index.ts'),
```

Run: `pnpm install`.

- [ ] **Step 2: Define the activities API the workflow depends on**

This interface is hand-declared here (not imported from `@agentops/activities`) precisely so `workflows` never depends on the I/O package — it only needs to agree on shape. `packages/activities`'s `createActivities` (Task 15) is structurally compatible; Task 20 asserts that at the worker layer.

`packages/workflows/src/activities-api.ts`:

```ts
import type { AgentRunRequest, AgentRunResult, PrFeedback, RunStats, StageResult } from '@agentops/contracts';

export interface Issue {
  ref: string;
  title: string;
  body: string;
  labels: string[];
}

export interface OpenPrRequest {
  repo: string;
  branch: string;
  title: string;
  body: string;
}

export interface OpenPrResult {
  prRef: string;
  url: string;
}

export interface StageResultRecord extends StageResult {
  taskId: string;
}

export interface DevCycleActivities {
  runAgent(req: AgentRunRequest): Promise<AgentRunResult>;
  getIssue(ref: string): Promise<Issue>;
  commentOnIssue(ref: string, body: string): Promise<void>;
  labelIssue(ref: string, label: string): Promise<void>;
  openPr(req: OpenPrRequest): Promise<OpenPrResult>;
  getPrFeedback(prRef: string): Promise<PrFeedback>;
  pushBranch(branch: string, contentHash: string): Promise<void>;
  recordStageResult(result: StageResultRecord): Promise<void>;
  recordRunStats(stats: RunStats): Promise<void>;
}
```

- [ ] **Step 3: Typecheck the interface file on its own**

Run: `pnpm --filter @agentops/workflows run typecheck`
Expected: no errors (nothing consumes it yet).

- [ ] **Step 4: Commit**

```bash
git add packages/workflows vitest.config.ts
git commit -m "feat(workflows): declare the DevCycleActivities API surface"
```

---

### Task 17: `workflows` — DevCycle: pre-implement stages + repair loop

**Files:**
- Create: `packages/workflows/src/dev-cycle.ts`

This task and Task 18 build one workflow function incrementally. Because Temporal workflow code can only be exercised through `TestWorkflowEnvironment` (wired up in Task 22), there is no isolated unit test here — correctness is verified by the e2e suite (Tasks 23–26). Type-check after each step as your safety net.

- [ ] **Step 1: Scaffold signals, query, and state shape**

`packages/workflows/src/dev-cycle.ts`:

```ts
import { condition, defineQuery, defineSignal, proxyActivities, setHandler, sleep } from '@temporalio/workflow';
import type { BlockReason, Brakes, Stage, TaskInput, TaskStatus, VerdictKind } from '@agentops/contracts';
import { feedbackHash } from '@agentops/contracts';
import { babysitDecision, nextRepairAction, parseVerdict, preImplementStages } from '@agentops/policies';
import type { DevCycleActivities } from './activities-api';

const activities = proxyActivities<DevCycleActivities>({
  startToCloseTimeout: '10 minutes',
});

export const stopSignal = defineSignal('stop');
export const cancelSignal = defineSignal('cancel');
export const clarifySignal = defineSignal<[string]>('clarify');
export const resumeSignal = defineSignal('resume');
export const stateQuery = defineQuery<DevCycleState>('state');

export interface DevCycleState {
  taskId: string;
  stage: Stage;
  status: TaskStatus;
  blockReason: BlockReason | null;
  implementAttempts: number;
  iterations: number;
  cumulativeTokens: number;
  babysitRounds: number;
  prRef: string | null;
}

const MAX_VERDICT_CALLS = 2;
const DEFAULT_BABYSIT_POLL_MS = 5000;

export async function devCycle(input: TaskInput): Promise<DevCycleState> {
  const state: DevCycleState = {
    taskId: input.taskId,
    stage: 'context',
    status: 'running',
    blockReason: null,
    implementAttempts: 0,
    iterations: 0,
    cumulativeTokens: 0,
    babysitRounds: 0,
    prRef: null,
  };

  let cancelled = false;
  let stopRequested = false;
  let effectiveBrakes: Brakes = { ...input.config.brakes };

  setHandler(stopSignal, () => {
    stopRequested = true;
  });
  setHandler(cancelSignal, () => {
    cancelled = true;
  });
  setHandler(clarifySignal, (_text: string) => {
    // M0 stores no clarification text yet — later milestones feed it back into
    // the next stage's prompt via activities. The signal exists now so the
    // `clarify`/`resume` escape hatch (ARCHITECTURE.md §2) is wired end-to-end.
  });
  setHandler(resumeSignal, () => {
    if (state.blockReason === 'token-brake') {
      effectiveBrakes = { ...effectiveBrakes, maxTokens: Number.MAX_SAFE_INTEGER };
    }
    if (state.blockReason === 'iteration-brake') {
      effectiveBrakes = { ...effectiveBrakes, maxIterations: Number.MAX_SAFE_INTEGER };
    }
    if (state.blockReason === 'babysit-brake') {
      effectiveBrakes = { ...effectiveBrakes, maxBabysitRounds: Number.MAX_SAFE_INTEGER };
    }
    state.status = 'running';
    state.blockReason = null;
  });
  setHandler(stateQuery, () => state);

  const waitForResumeOrCancel = async (): Promise<boolean> => {
    await condition(() => cancelled || state.status === 'running');
    return cancelled;
  };

  const runStageAgent = async (
    stage: Stage,
    attempt: number,
    callIndex = 1,
    modelOverride?: { backend: string; model: string },
  ): Promise<string> => {
    const routed = input.config.routing[stage];
    const model = modelOverride ?? routed;
    const backend = model?.backend ?? 'stub';
    const modelName = model?.model ?? 'stub';
    const result = await activities.runAgent({
      taskId: input.taskId,
      stage,
      attempt,
      callIndex,
      backend,
      model: modelName,
      promptRef: `${stage}.md`,
      workspaceRef: input.repo,
      limits: { maxTokens: input.config.brakes.maxTokens, timeoutMs: 600_000 },
    });
    state.cumulativeTokens += result.tokensIn + result.tokensOut;
    await activities.recordRunStats({
      taskId: input.taskId,
      stage,
      backend,
      model: modelName,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      wallMs: result.wallMs,
      outcome: 'pass',
    });
    await activities.recordStageResult({
      taskId: input.taskId,
      stage,
      source: 'agent',
      contentHash: `${stage}-${attempt}-${callIndex}`,
      tokens: result.tokensIn + result.tokensOut,
      outcome: 'pass',
    });
    return result.output;
  };

  const runVerdictStage = async (
    stage: 'full_verify' | 'review',
    attempt: number,
    sentinel: string,
  ): Promise<VerdictKind> => {
    let lastKind: VerdictKind = 'unparseable';
    for (let call = 1; call <= MAX_VERDICT_CALLS; call += 1) {
      const output = await runStageAgent(stage, attempt, call);
      const parsed = parseVerdict(output, sentinel);
      lastKind = parsed.kind;
      if (parsed.kind !== 'unparseable') {
        return parsed.kind;
      }
    }
    return lastKind === 'unparseable' ? 'fail' : lastKind;
  };

  if (input.issueRef) {
    await activities.getIssue(input.issueRef);
  }

  for (const stage of preImplementStages({ config: input.config, hasHumanDesign: false, hasHumanPlan: false })) {
    state.stage = stage;
    await runStageAgent(stage, 1);
    if (cancelled) {
      state.stage = 'failed';
      state.status = 'failed';
      return state;
    }
    if (stopRequested) {
      state.status = 'pending';
      return state;
    }
  }

  let implementAttempt = 1;
  let reviewAttempt = 1;
  let useEscalation = false;
  let exhausted = false;
  let fullVerifyVerdict: VerdictKind = 'unparseable';
  let reviewVerdict: VerdictKind | null = null;

  while (true) {
    state.stage = 'implement';
    const implementModel = useEscalation ? input.config.escalation : undefined;
    const implementOutput = await runStageAgent('implement', implementAttempt, 1, implementModel);
    state.implementAttempts = implementAttempt;
    state.iterations += 1;
    const diffEmpty = implementOutput.trim().length === 0;

    state.stage = 'full_verify';
    fullVerifyVerdict = await runVerdictStage('full_verify', implementAttempt, 'FULL:');

    if (fullVerifyVerdict === 'pass') {
      state.stage = 'review';
      reviewVerdict = await runVerdictStage('review', reviewAttempt, 'VERDICT:');
      reviewAttempt += 1;
    } else {
      reviewVerdict = null;
    }

    const evaluate = () =>
      nextRepairAction({
        implementAttempts: implementAttempt,
        iterations: state.iterations,
        cumulativeTokens: state.cumulativeTokens,
        fullVerify: fullVerifyVerdict,
        review: reviewVerdict ?? 'unparseable',
        diffEmpty,
        brakes: effectiveBrakes,
        hasEscalationModel: input.config.escalation != null,
      });

    let action = evaluate();
    while (action.kind === 'block') {
      state.status = 'blocked';
      state.blockReason = action.reason;
      if (await waitForResumeOrCancel()) {
        state.stage = 'failed';
        state.status = 'failed';
        return state;
      }
      action = evaluate();
    }

    if (action.kind === 'continue') {
      break;
    }
    if (action.kind === 'open-pr-exhausted') {
      exhausted = true;
      break;
    }
    useEscalation = action.useEscalationModel;
    implementAttempt += 1;
  }

  // pr + pr_babysit stages are added in Task 18.
  return state;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @agentops/workflows run typecheck`
Expected: no errors. (`exhausted`, `fullVerifyVerdict`, `reviewVerdict` are unused past this point until Task 18 — if the linter/typechecker flags them as unused, that's expected and resolves once Task 18 consumes them; don't suppress the warning, just proceed to Task 18 immediately.)

- [ ] **Step 3: Commit**

```bash
git add packages/workflows
git commit -m "feat(workflows): devCycle pre-implement stages and implement/verify/review repair loop"
```

---

### Task 18: `workflows` — DevCycle: PR + babysit loop

**Files:**
- Modify: `packages/workflows/src/dev-cycle.ts`
- Create: `packages/workflows/src/index.ts`

- [ ] **Step 1: Replace the placeholder comment with the PR + babysit stages**

In `packages/workflows/src/dev-cycle.ts`, replace:

```ts
  // pr + pr_babysit stages are added in Task 18.
  return state;
}
```

with:

```ts
  state.stage = 'pr';
  const branch = `agentops/${input.taskId}`;
  const findingsSummary = `full_verify: ${fullVerifyVerdict}; review: ${reviewVerdict ?? 'not-run'}`;
  const prBody = exhausted
    ? `Repair attempts exhausted after ${state.implementAttempts} implement attempt(s). Opening PR with outstanding findings.\n${findingsSummary}`
    : `Automated PR for task ${input.taskId}.`;
  const { prRef } = await activities.openPr({
    repo: input.repo,
    branch,
    title: input.goal,
    body: prBody,
  });
  state.prRef = prRef;
  if (exhausted) {
    await activities.commentOnIssue(input.issueRef ?? input.taskId, prBody);
  }

  state.stage = 'pr_babysit';
  const seenFeedbackHashes = new Set<string>();

  while (true) {
    await sleep(DEFAULT_BABYSIT_POLL_MS);
    const feedback = await activities.getPrFeedback(prRef);
    const decision = babysitDecision(
      feedback,
      seenFeedbackHashes,
      state.babysitRounds,
      effectiveBrakes.maxBabysitRounds,
    );

    if (decision === 'merge_ready') {
      break;
    }

    if (decision === 'braked') {
      state.status = 'blocked';
      state.blockReason = 'babysit-brake';
      if (await waitForResumeOrCancel()) {
        state.stage = 'failed';
        state.status = 'failed';
        return state;
      }
      state.stage = 'pr_babysit';
      continue;
    }

    if (decision === 'actionable') {
      seenFeedbackHashes.add(feedbackHash(feedback));
      state.babysitRounds += 1;
      implementAttempt += 1;
      state.stage = 'implement';
      await runStageAgent('implement', implementAttempt);
      state.implementAttempts = implementAttempt;
      state.iterations += 1;
      await activities.pushBranch(branch, `${input.taskId}-${implementAttempt}`);
      state.stage = 'pr_babysit';
      continue;
    }

    // decision === 'waiting': loop again after the next poll interval.
  }

  state.stage = 'done';
  state.status = 'done';
  return state;
}
```

- [ ] **Step 2: Typecheck the full workflow**

Run: `pnpm --filter @agentops/workflows run typecheck`
Expected: no errors — `exhausted`, `fullVerifyVerdict`, `reviewVerdict`, and `implementAttempt` are now all consumed.

- [ ] **Step 3: Barrel export**

`packages/workflows/src/index.ts`:

```ts
export * from './activities-api';
export * from './dev-cycle';
```

Run: `pnpm --filter @agentops/workflows run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/workflows
git commit -m "feat(workflows): devCycle pr and pr_babysit stages, completing the pipeline"
```

---

### Task 19: ESLint determinism-boundary enforcement

**Files:**
- Modify: `eslint.config.js`
- Modify: `package.json` (add `eslint-plugin-import`'s import resolver dep if not already present from Task 1)

M0-SPEC's Definition of Done requires this be "enforced by eslint rule or import-ban config, not convention." This task makes AGENTS.md hard rules #1 and #2 fail the lint step if violated.

- [ ] **Step 1: Add the boundary rules**

`eslint.config.js` — replace the file with:

```js
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const importPlugin = require('eslint-plugin-import');

module.exports = tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { import: importPlugin },
    settings: {
      'import/resolver': {
        typescript: { alwaysTryTypes: true },
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './packages/workflows/src',
              from: ['./packages/activities/src', './packages/ports/src', './packages/backends/src'],
              message:
                'AGENTS.md rule 1 (determinism boundary): packages/workflows may not import activities/ports/backends. All side effects go through proxied activities.',
            },
            {
              target: './packages/policies/src',
              from: [
                './packages/activities/src',
                './packages/ports/src',
                './packages/backends/src',
                './packages/workflows/src',
              ],
              message: 'AGENTS.md rule 2: packages/policies stays pure — no Temporal, no I/O.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/workflows/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'Non-deterministic in workflow code — AGENTS.md rule 1.' },
        { name: 'setTimeout', message: 'Use Temporal sleep() instead — AGENTS.md rule 1.' },
        { name: 'setInterval', message: 'Non-deterministic in workflow code — AGENTS.md rule 1.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Non-deterministic in workflow code — AGENTS.md rule 1.' },
        { object: 'Date', property: 'now', message: 'Non-deterministic in workflow code — AGENTS.md rule 1.' },
      ],
    },
  },
);
```

- [ ] **Step 2: Verify it catches a real violation**

Temporarily add `import { StubBackend } from '@agentops/backends';` to the top of `packages/workflows/src/dev-cycle.ts`, run `pnpm lint`, confirm it fails with the rule 1 message, then remove the line.

Run: `pnpm lint`
Expected (with the temporary import in place): FAIL, citing `import/no-restricted-paths` and the AGENTS.md rule 1 message. After removing the temporary import:

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add eslint.config.js
git commit -m "chore(lint): enforce the determinism boundary (AGENTS.md rules 1-2) via ESLint"
```

---

### Task 20: `worker` package

**Files:**
- Create: `packages/worker/package.json`
- Create: `packages/worker/tsconfig.json`
- Create: `packages/worker/src/create-worker.ts`
- Create: `packages/worker/src/main.ts`

- [ ] **Step 1: Package manifest**

`packages/worker/package.json`:

```json
{
  "name": "@agentops/worker",
  "version": "0.0.0",
  "private": true,
  "main": "src/main.ts",
  "types": "src/create-worker.ts",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "tsc -p tsconfig.json",
    "start": "tsx src/main.ts"
  },
  "dependencies": {
    "@agentops/activities": "workspace:*",
    "@agentops/backends": "workspace:*",
    "@agentops/ports": "workspace:*",
    "@agentops/workflows": "workspace:*",
    "@temporalio/worker": "^1.11.0"
  }
}
```

`packages/worker/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "references": [
    { "path": "../activities" },
    { "path": "../backends" },
    { "path": "../ports" },
    { "path": "../workflows" }
  ]
}
```

Run: `pnpm install`.

- [ ] **Step 2: Worker factory**

`packages/worker/src/create-worker.ts`:

```ts
import { NativeConnection, Worker } from '@temporalio/worker';
import type { DevCycleActivities } from '@agentops/workflows';

export interface CreateWorkerOptions {
  taskQueue: string;
  activities: DevCycleActivities;
  connection?: NativeConnection;
  workflowsPath?: string;
}

export async function createWorker(options: CreateWorkerOptions): Promise<Worker> {
  return Worker.create({
    connection: options.connection,
    taskQueue: options.taskQueue,
    workflowsPath: options.workflowsPath ?? require.resolve('@agentops/workflows'),
    activities: options.activities as unknown as Record<string, (...args: never[]) => Promise<unknown>>,
  });
}
```

The `DevCycleActivities` type import is type-only, so it does not violate the determinism boundary (that rule applies to `packages/workflows`, not `packages/worker` — the worker is where I/O wiring is *supposed* to live).

This is also where `createActivities`'s (Task 15) structural compatibility with `DevCycleActivities` (Task 16) gets checked by the compiler — `main.ts` below assigns one to the other.

- [ ] **Step 3: Manual-run entrypoint**

`packages/worker/src/main.ts`:

```ts
import { NativeConnection } from '@temporalio/worker';
import { createActivities, InMemoryStageResultStore, InMemoryStatsStore } from '@agentops/activities';
import { StubBackend } from '@agentops/backends';
import { MemoryScmPort, MemoryTrackerPort } from '@agentops/ports';
import type { DevCycleActivities } from '@agentops/workflows';
import { createWorker } from './create-worker';

async function main(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });

  const activities: DevCycleActivities = createActivities({
    backends: { stub: new StubBackend() },
    tracker: new MemoryTrackerPort(),
    scm: new MemoryScmPort(),
    stats: new InMemoryStatsStore(),
    stageResults: new InMemoryStageResultStore(),
  });

  const worker = await createWorker({
    taskQueue: 'agentops-devcycle',
    activities,
    connection,
  });

  console.log('agentops worker started on task queue "agentops-devcycle"');
  await worker.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @agentops/worker run typecheck`
Expected: no errors. If `createActivities(...)` is not assignable to `DevCycleActivities`, the compiler error will name the mismatched method — fix the mismatch in whichever of Task 15/16's interfaces is wrong (they must describe the same nine methods with the same signatures).

- [ ] **Step 5: Commit**

```bash
git add packages/worker
git commit -m "feat(worker): Temporal worker factory and manual-run entrypoint"
```

---

### Task 21: `cli` package (start, signal, state)

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/main.ts`

- [ ] **Step 1: Package manifest**

`packages/cli/package.json`:

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
    "@agentops/workflows": "workspace:*",
    "@temporalio/client": "^1.11.0"
  }
}
```

`packages/cli/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "references": [{ "path": "../contracts" }, { "path": "../workflows" }]
}
```

Run: `pnpm install`.

- [ ] **Step 2: Implement the three commands**

`packages/cli/src/main.ts`:

```ts
import { Client, Connection } from '@temporalio/client';
import type { TaskInput } from '@agentops/contracts';
import { cancelSignal, clarifySignal, devCycle, resumeSignal, stateQuery, stopSignal } from '@agentops/workflows';

const TASK_QUEUE = 'agentops-devcycle';

function defaultConfig(): TaskInput['config'] {
  return {
    fastVerifyCommands: ['pnpm lint'],
    fullVerifyCommands: ['pnpm test'],
    stages: {},
    routing: {},
    brakes: { maxImplementAttempts: 3, maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 },
  };
}

async function getClient(): Promise<Client> {
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  return new Client({ connection });
}

async function cmdStart(taskId: string, goal: string, product: string, repo: string, issueRef?: string): Promise<void> {
  const client = await getClient();
  const input: TaskInput = { taskId, product, repo, issueRef, goal, config: defaultConfig() };
  const handle = await client.workflow.start(devCycle, { taskQueue: TASK_QUEUE, workflowId: taskId, args: [input] });
  console.log(`started ${handle.workflowId}`);
}

async function cmdSignal(taskId: string, signal: string, text?: string): Promise<void> {
  const client = await getClient();
  const handle = client.workflow.getHandle(taskId);
  if (signal === 'stop') {
    await handle.signal(stopSignal);
  } else if (signal === 'cancel') {
    await handle.signal(cancelSignal);
  } else if (signal === 'resume') {
    await handle.signal(resumeSignal);
  } else if (signal === 'clarify') {
    await handle.signal(clarifySignal, text ?? '');
  } else {
    throw new Error(`unknown signal: ${signal} (expected stop|cancel|resume|clarify)`);
  }
  console.log(`sent ${signal} to ${taskId}`);
}

async function cmdState(taskId: string): Promise<void> {
  const client = await getClient();
  const handle = client.workflow.getHandle(taskId);
  const state = await handle.query(stateQuery);
  console.log(JSON.stringify(state, null, 2));
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  if (command === 'start') {
    const [taskId, goal, product = 'default', repo = 'default', issueRef] = rest;
    if (!taskId || !goal) {
      throw new Error('usage: cli start <taskId> <goal> [product] [repo] [issueRef]');
    }
    await cmdStart(taskId, goal, product, repo, issueRef);
  } else if (command === 'signal') {
    const [taskId, signal, text] = rest;
    if (!taskId || !signal) {
      throw new Error('usage: cli signal <taskId> <stop|cancel|resume|clarify> [text]');
    }
    await cmdSignal(taskId, signal, text);
  } else if (command === 'state') {
    const [taskId] = rest;
    if (!taskId) {
      throw new Error('usage: cli state <taskId>');
    }
    await cmdState(taskId);
  } else {
    console.error('usage: cli <start|signal|state> ...');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @agentops/cli run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): minimal start/signal/state admin CLI"
```

---

### Task 22: e2e harness

**Files:**
- Create: `vitest.e2e.config.ts`
- Create: `e2e/helpers.ts`

- [ ] **Step 1: e2e vitest config**

`vitest.e2e.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
```

Note: this config deliberately has **no** `resolve.alias` block. e2e tests exercise the real Temporal worker, which loads `@agentops/workflows` from `node_modules` (pnpm's workspace symlink to `packages/workflows`, `main: src/index.ts`) exactly as it would in production — that's the point of the e2e suite versus the aliased unit-test config from Task 1.

- [ ] **Step 2: Shared test harness**

`e2e/helpers.ts`:

```ts
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import type { WorkflowHandle } from '@temporalio/client';
import { createActivities, InMemoryStageResultStore, InMemoryStatsStore } from '@agentops/activities';
import { StubBackend } from '@agentops/backends';
import { MemoryScmPort, MemoryTrackerPort } from '@agentops/ports';
import type { DevCycleActivities, DevCycleState } from '@agentops/workflows';
import { createWorker } from '@agentops/worker';

export interface TestEnv {
  env: TestWorkflowEnvironment;
  worker: Worker;
  stub: StubBackend;
  tracker: MemoryTrackerPort;
  scm: MemoryScmPort;
  stats: InMemoryStatsStore;
  stageResults: InMemoryStageResultStore;
  taskQueue: string;
}

let counter = 0;

export function nextTaskQueue(): string {
  counter += 1;
  return `agentops-devcycle-test-${counter}`;
}

export async function buildTestEnv(): Promise<TestEnv> {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const stub = new StubBackend();
  const tracker = new MemoryTrackerPort();
  const scm = new MemoryScmPort();
  const stats = new InMemoryStatsStore();
  const stageResults = new InMemoryStageResultStore();

  const activities: DevCycleActivities = createActivities({
    backends: { stub },
    tracker,
    scm,
    stats,
    stageResults,
  });

  const taskQueue = nextTaskQueue();
  const worker = await createWorker({
    taskQueue,
    activities,
    connection: env.nativeConnection,
  });

  return { env, worker, stub, tracker, scm, stats, stageResults, taskQueue };
}

export async function waitForStatus(
  handle: WorkflowHandle<(input: never) => Promise<DevCycleState>>,
  statuses: DevCycleState['status'][],
  timeoutMs = 5000,
): Promise<DevCycleState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await handle.query('state');
    if (statuses.includes(state.status)) {
      return state as DevCycleState;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for status in [${statuses.join(', ')}]`);
}
```

`Date.now()`/`setTimeout` here are fine — this file is test infrastructure (Node process code), not workflow code; the determinism boundary only applies inside `packages/workflows/src`.

- [ ] **Step 3: Smoke-test the harness compiles**

Run: `pnpm tsc --noEmit -p packages/worker/tsconfig.json` (sanity check `@agentops/worker`'s exports are usable) — this doesn't execute `e2e/helpers.ts` yet since no test imports it; that happens in Task 23.

- [ ] **Step 4: Commit**

```bash
git add vitest.e2e.config.ts e2e/helpers.ts
git commit -m "test(e2e): TestWorkflowEnvironment harness with in-memory deps"
```

---

### Task 23: e2e scenario 1 — happy path with one repair round

**Files:**
- Create: `e2e/happy-path.e2e.test.ts`

**Scenario (M0-SPEC §e2e acceptance #1):** fake issue → context/design/plan → implement → forced `FULL: FAIL` → fixer round → pass → review pass → PR opened → babysit: first feedback `failed` CI (actionable → fix → push), second feedback green + 0 threads → `done`. Assert stage order (implicit via final state + call counts), attempt counts, PR opened exactly once, stats recorded per stage.

- [ ] **Step 1: Write the test**

`e2e/happy-path.e2e.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskInput } from '@agentops/contracts';
import { devCycle, stateQuery } from '@agentops/workflows';
import { buildTestEnv, waitForStatus, type TestEnv } from './helpers';

describe('DevCycle e2e: happy path with one repair round', () => {
  let testEnv: TestEnv | undefined;

  afterEach(async () => {
    await testEnv?.env.teardown();
  });

  it('reaches done after one full_verify failure and one babysit fix round', async () => {
    testEnv = await buildTestEnv();
    const { env, worker, stub, tracker, scm, stats, taskQueue } = testEnv;

    tracker.seedIssue({ ref: 'issue-1', title: 'Add widget', body: 'Please add a widget', labels: [] });

    stub.scriptResponse('implement', 1, { output: 'diff --git a/widget.ts b/widget.ts (attempt 1)' });
    stub.scriptResponse('full_verify', 1, { output: 'FULL: FAIL 1 test failing' });
    stub.scriptResponse('implement', 2, { output: 'diff --git a/widget.ts b/widget.ts (attempt 2)' });
    stub.scriptResponse('full_verify', 2, { output: 'FULL: PASS' });
    stub.scriptResponse('review', 1, { output: 'VERDICT: PASS' });
    stub.scriptResponse('implement', 3, { output: 'diff --git a/widget.ts b/widget.ts (babysit fix)' });

    scm.scriptFeedback('pr-1', [
      { ciStatus: 'failed', unresolvedThreads: 0, comments: [{ id: 'c1', body: 'CI failed', resolved: false }] },
      { ciStatus: 'green', unresolvedThreads: 0, comments: [] },
    ]);

    const input: TaskInput = {
      taskId: 'happy-path-task',
      product: 'demo',
      repo: 'demo/repo',
      issueRef: 'issue-1',
      goal: 'Add a widget',
      config: {
        fastVerifyCommands: [],
        fullVerifyCommands: [],
        stages: {},
        routing: {},
        brakes: { maxImplementAttempts: 3, maxIterations: 10, maxTokens: 1_000_000, maxBabysitRounds: 5 },
      },
    };

    const finalState = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(devCycle, {
        taskQueue,
        workflowId: input.taskId,
        args: [input],
      });
      await waitForStatus(handle, ['done', 'blocked', 'failed'], 10_000);
      return handle.result();
    });

    expect(finalState.status).toBe('done');
    expect(finalState.stage).toBe('done');
    expect(finalState.implementAttempts).toBe(3);
    expect(scm.getOpenedPrs()).toHaveLength(1);
    expect(stats.all().filter((s) => s.stage === 'implement')).toHaveLength(3);
    expect(stats.all().filter((s) => s.stage === 'full_verify')).toHaveLength(2);
    expect(stats.all().filter((s) => s.stage === 'review')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run and iterate**

Run: `pnpm e2e -- e2e/happy-path.e2e.test.ts`
Expected initially: likely FAIL on first attempt due to SDK wiring details (e.g. `workflowsPath` resolution, query key mismatches). Debug by reading the thrown error:
  - If `require.resolve('@agentops/workflows')` fails: confirm `packages/workflows/package.json` has `"main": "src/index.ts"` and `pnpm install` has linked it into `node_modules/@agentops/workflows`.
  - If the Temporal worker fails to bundle the `.ts` workflow file: fall back to building first — add `"pretest:e2e"`-style step `pnpm --filter @agentops/workflows run build`, and pass `workflowsPath: require.resolve('@agentops/workflows/dist/index.js')` (update that package's `main` to `dist/index.js` for this fallback) — only do this if the direct-`.ts` path demonstrably fails.
  - If counts are off, re-read the `nextRepairAction`/`babysitDecision` flow in `dev-cycle.ts` against the scripted stub sequence above and adjust either the test's scripted responses or (if a real bug) the workflow.

Keep iterating until:

Run: `pnpm e2e -- e2e/happy-path.e2e.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e/happy-path.e2e.test.ts
git commit -m "test(e2e): happy path with one repair round and one babysit fix"
```

---

### Task 24: e2e scenario 2 — brake + rescue

**Files:**
- Create: `e2e/brake-and-rescue.e2e.test.ts`

**Scenario (M0-SPEC §e2e acceptance #2):** stub inflates tokens past `maxTokens` → task blocks with `token-brake` → `resume` signal → continues and completes.

- [ ] **Step 1: Write the test**

`e2e/brake-and-rescue.e2e.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskInput } from '@agentops/contracts';
import { devCycle, resumeSignal } from '@agentops/workflows';
import { buildTestEnv, waitForStatus, type TestEnv } from './helpers';

describe('DevCycle e2e: brake + rescue', () => {
  let testEnv: TestEnv | undefined;

  afterEach(async () => {
    await testEnv?.env.teardown();
  });

  it('blocks on token-brake then completes after a resume signal', async () => {
    testEnv = await buildTestEnv();
    const { env, worker, stub, scm, taskQueue } = testEnv;

    stub.scriptResponse('implement', 1, { output: 'diff', tokensIn: 60_000, tokensOut: 0 });
    stub.scriptResponse('full_verify', 1, { output: 'FULL: PASS', tokensIn: 0, tokensOut: 0 });
    stub.scriptResponse('review', 1, { output: 'VERDICT: PASS', tokensIn: 0, tokensOut: 0 });

    scm.scriptFeedback('pr-1', [{ ciStatus: 'green', unresolvedThreads: 0, comments: [] }]);

    const input: TaskInput = {
      taskId: 'brake-rescue-task',
      product: 'demo',
      repo: 'demo/repo',
      goal: 'Trigger a token brake',
      config: {
        fastVerifyCommands: [],
        fullVerifyCommands: [],
        stages: {},
        routing: {},
        brakes: { maxImplementAttempts: 3, maxIterations: 10, maxTokens: 50_000, maxBabysitRounds: 5 },
      },
    };

    const finalState = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(devCycle, {
        taskQueue,
        workflowId: input.taskId,
        args: [input],
      });

      const blocked = await waitForStatus(handle, ['blocked', 'done', 'failed'], 10_000);
      expect(blocked.status).toBe('blocked');
      expect(blocked.blockReason).toBe('token-brake');

      await handle.signal(resumeSignal);
      await waitForStatus(handle, ['done', 'failed'], 10_000);
      return handle.result();
    });

    expect(finalState.status).toBe('done');
    expect(scm.getOpenedPrs()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run and iterate**

Run: `pnpm e2e -- e2e/brake-and-rescue.e2e.test.ts`
Expected initially: may fail if the token accounting doesn't cross `maxTokens` by the time `nextRepairAction` is evaluated (implement + full_verify + review all run before the check in the current `dev-cycle.ts` design when `full_verify` passes) — verify with a debug log of `state.cumulativeTokens` if the block never triggers, and adjust the scripted `tokensIn` upward if needed. Keep iterating until:

Run: `pnpm e2e -- e2e/brake-and-rescue.e2e.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e/brake-and-rescue.e2e.test.ts
git commit -m "test(e2e): token-brake block and resume-signal rescue"
```

---

### Task 25: e2e scenario 3 — garbage verdict

**Files:**
- Create: `e2e/garbage-verdict.e2e.test.ts`

**Scenario (M0-SPEC §e2e acceptance #3):** reviewer returns garbage twice → bounded retries → treated as retryable FAIL → fixer round proceeds (never `blocked`).

- [ ] **Step 1: Write the test**

`e2e/garbage-verdict.e2e.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskInput } from '@agentops/contracts';
import { devCycle } from '@agentops/workflows';
import { buildTestEnv, waitForStatus, type TestEnv } from './helpers';

describe('DevCycle e2e: garbage verdict never blocks', () => {
  let testEnv: TestEnv | undefined;

  afterEach(async () => {
    await testEnv?.env.teardown();
  });

  it('treats a twice-garbled review verdict as a retryable FAIL and proceeds to a fixer round', async () => {
    testEnv = await buildTestEnv();
    const { env, worker, stub, scm, taskQueue } = testEnv;

    stub.scriptResponse('implement', 1, { output: 'diff attempt 1' });
    stub.scriptResponse('full_verify', 1, { output: 'FULL: PASS' });
    stub.scriptResponse('review', 1, { output: 'not a verdict at all' }, 1);
    stub.scriptResponse('review', 1, { output: 'still garbage' }, 2);

    stub.scriptResponse('implement', 2, { output: 'diff attempt 2' });
    stub.scriptResponse('full_verify', 2, { output: 'FULL: PASS' });
    stub.scriptResponse('review', 2, { output: 'VERDICT: PASS' }, 1);

    scm.scriptFeedback('pr-1', [{ ciStatus: 'green', unresolvedThreads: 0, comments: [] }]);

    const input: TaskInput = {
      taskId: 'garbage-verdict-task',
      product: 'demo',
      repo: 'demo/repo',
      goal: 'Survive a garbled reviewer',
      config: {
        fastVerifyCommands: [],
        fullVerifyCommands: [],
        stages: {},
        routing: {},
        brakes: { maxImplementAttempts: 3, maxIterations: 10, maxTokens: 1_000_000, maxBabysitRounds: 5 },
      },
    };

    let sawBlocked = false;
    const finalState = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(devCycle, {
        taskQueue,
        workflowId: input.taskId,
        args: [input],
      });

      // Poll a few times before completion to assert the workflow never parks as blocked.
      for (let i = 0; i < 5; i += 1) {
        const state = await handle.query('state');
        if (state.status === 'blocked') {
          sawBlocked = true;
        }
        if (state.status === 'done' || state.status === 'failed') {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await waitForStatus(handle, ['done', 'failed'], 10_000);
      return handle.result();
    });

    expect(sawBlocked).toBe(false);
    expect(finalState.status).toBe('done');
    expect(finalState.implementAttempts).toBe(2);
    expect(scm.getOpenedPrs()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run and iterate**

Run: `pnpm e2e -- e2e/garbage-verdict.e2e.test.ts`
Expected: may need adjustment to the polling loop or `MAX_VERDICT_CALLS`/stub keying if the retry count doesn't line up — confirm `runVerdictStage`'s `call` index (1, then 2) matches the `scriptResponse(..., callIndex)` values used above. Iterate until:

Run: `pnpm e2e -- e2e/garbage-verdict.e2e.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e/garbage-verdict.e2e.test.ts
git commit -m "test(e2e): garbled review verdict retried then treated as retryable FAIL"
```

---

### Task 26: e2e scenario 4 — exhausted rounds

**Files:**
- Create: `e2e/exhausted-rounds.e2e.test.ts`

**Scenario (M0-SPEC §e2e acceptance #4):** all attempts fail review → PR opened anyway with findings posted as a comment (assert comment via memory tracker).

- [ ] **Step 1: Write the test**

`e2e/exhausted-rounds.e2e.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskInput } from '@agentops/contracts';
import { devCycle } from '@agentops/workflows';
import { buildTestEnv, waitForStatus, type TestEnv } from './helpers';

describe('DevCycle e2e: exhausted repair rounds open the PR anyway', () => {
  let testEnv: TestEnv | undefined;

  afterEach(async () => {
    await testEnv?.env.teardown();
  });

  it('opens a PR with findings and comments on the issue after 3 failed review rounds', async () => {
    testEnv = await buildTestEnv();
    const { env, worker, stub, tracker, scm, taskQueue } = testEnv;

    tracker.seedIssue({ ref: 'issue-9', title: 'Hard bug', body: 'Never quite passes review', labels: [] });

    for (const attempt of [1, 2, 3]) {
      stub.scriptResponse('implement', attempt, { output: `diff attempt ${attempt}` });
      stub.scriptResponse('full_verify', attempt, { output: 'FULL: PASS' });
    }
    stub.scriptResponse('review', 1, { output: 'VERDICT: FAIL needs more tests' });
    stub.scriptResponse('review', 2, { output: 'VERDICT: FAIL still missing coverage' });
    stub.scriptResponse('review', 3, { output: 'VERDICT: FAIL not there yet' });

    scm.scriptFeedback('pr-1', [{ ciStatus: 'green', unresolvedThreads: 0, comments: [] }]);

    const input: TaskInput = {
      taskId: 'exhausted-rounds-task',
      product: 'demo',
      repo: 'demo/repo',
      issueRef: 'issue-9',
      goal: 'Fix the hard bug',
      config: {
        fastVerifyCommands: [],
        fullVerifyCommands: [],
        stages: {},
        routing: {},
        brakes: { maxImplementAttempts: 3, maxIterations: 10, maxTokens: 1_000_000, maxBabysitRounds: 5 },
      },
    };

    const finalState = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(devCycle, {
        taskQueue,
        workflowId: input.taskId,
        args: [input],
      });
      await waitForStatus(handle, ['done', 'blocked', 'failed'], 10_000);
      return handle.result();
    });

    expect(finalState.status).toBe('done');
    expect(finalState.implementAttempts).toBe(3);
    expect(scm.getOpenedPrs()).toHaveLength(1);
    const comments = tracker.getComments('issue-9');
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatch(/exhausted/i);
    expect(comments[0]).toMatch(/review: fail/i);
  });
});
```

- [ ] **Step 2: Run and iterate**

Run: `pnpm e2e -- e2e/exhausted-rounds.e2e.test.ts`
Expected: may need tweaks to the assertion regex depending on the exact `prBody` wording in `dev-cycle.ts` — align the regex to whatever the actual PR body text says rather than changing the workflow's wording arbitrarily. Iterate until:

Run: `pnpm e2e -- e2e/exhausted-rounds.e2e.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the full e2e suite together**

Run: `pnpm e2e`
Expected: all 4 e2e test files PASS.

- [ ] **Step 4: Commit**

```bash
git add e2e/exhausted-rounds.e2e.test.ts
git commit -m "test(e2e): exhausted repair rounds open PR anyway with findings comment"
```

---

### Task 27: CI workflow

**Files:**
- Create: `.github/workflows/ci.yaml`

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yaml`:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - run: pnpm lint

      - run: pnpm typecheck

      - run: pnpm test

      - run: pnpm test:policies-coverage

      - run: pnpm e2e
```

- [ ] **Step 2: Validate YAML syntax**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yaml'))" 2>/dev/null || node -e "require('yaml').parse(require('fs').readFileSync('.github/workflows/ci.yaml','utf8'))" 2>/dev/null || cat .github/workflows/ci.yaml`
Expected: no parse errors (if neither `yaml` python module nor node `yaml` package is available, visually re-check indentation — this is a fallback, not a hard requirement).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yaml
git commit -m "ci: lint, typecheck, unit tests, policies coverage gate, and e2e on every PR"
```

---

### Task 28: README quick start

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the "Status" section and add a Quick Start**

In `README.md`, replace:

```markdown
## Status

Pre-M0. Nothing is implemented yet — the next commit after this scaffold should start the M0 walking skeleton per [docs/M0-SPEC.md](docs/M0-SPEC.md).
```

with:

```markdown
## Status

M0 walking skeleton implemented: the full DevCycle pipeline runs end-to-end against in-memory
stubs (`pnpm e2e`), zero token spend, no cluster, no real forge. See
[docs/M0-SPEC.md](docs/M0-SPEC.md) for what "M0" covers and [docs/MILESTONES.md](docs/MILESTONES.md)
for what comes next (M1: a real `claude` backend + GitHub ports).

## Quick start

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage
pnpm e2e
```

`pnpm e2e` runs the four required M0 scenarios against `TestWorkflowEnvironment` (time-skipping) —
no running Temporal server needed.

To run the pipeline manually against a local Temporal dev server:

```bash
# terminal 1
temporal server start-dev

# terminal 2
pnpm --filter @agentops/worker run start

# terminal 3
pnpm --filter @agentops/cli run cli start demo-task-1 "Add a widget"
pnpm --filter @agentops/cli run cli state demo-task-1
pnpm --filter @agentops/cli run cli signal demo-task-1 resume
```

The manual run uses the `stub` backend and in-memory tracker/scm ports (same as `pnpm e2e`) — it
exercises the real Temporal server and worker process, but still spends zero tokens and touches no
real repo.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: M0 quick-start instructions"
```

---

### Task 29: Full local verification pass

**Files:** none (verification only).

- [ ] **Step 1: Run the complete local gate exactly as CI will**

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:policies-coverage
pnpm e2e
```

Expected: every command exits 0. If `--frozen-lockfile` fails because the lockfile drifted during this plan's execution, run `pnpm install` (no flag) once, commit the updated `pnpm-lock.yaml`, then re-run the full sequence with `--frozen-lockfile` to confirm it's now stable.

- [ ] **Step 2: Confirm the M0 Definition of Done checklist**

Go through `docs/M0-SPEC.md`'s Definition of Done line by line and confirm each item:
- [ ] All four e2e scenarios green in CI (verified locally in Step 1; CI will re-confirm on the PR in Task 30).
- [ ] `policies` at 100% branch coverage (verified by `pnpm test:policies-coverage` in Step 1).
- [ ] README quick-start present (Task 28).
- [ ] No package violates the determinism boundary, enforced by ESLint (Task 19), not convention.

- [ ] **Step 3: Commit (only if Step 1 produced any fixups)**

If everything was already green, there is nothing to commit — proceed directly to Task 30.

---

### Task 30: Open the PR, pass CI, and resolve the Bugbot review

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
gh pr create --base main --fill --title "feat: M0 walking skeleton — DevCycle over stub/memory backends"
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
# List unresolved threads, then resolve each addressed one by id:
gh api graphql -f query='query($o:String!,$r:String!,$p:Int!){repository(owner:$o,name:$r){pullRequest(number:$p){reviewThreads(first:100){nodes{id isResolved path comments(first:1){nodes{body}}}}}}}' -F o=<owner> -F r=<repo> -F p=<number>
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=<thread-id>
```

**After pushing:** return to Step 4 (re-watch CI), then Step 5 (wait for re-review). Loop until Bugbot reports no unresolved comments.

- [ ] **Step 7: Final verification**

```bash
gh pr checks                                                                    # all green
gh pr view --json reviews,comments                                              # no comment left unaddressed
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e   # suite green locally
```
Confirm no unresolved review threads remain, then mark this task complete.
