# Claude Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `stub` `AgentBackend` with a real `claude` CLI backend, and give every `DevCycle` stage a real, rendered prompt instead of an unused `promptRef` string.

**Architecture:** A minimal `packages/prompts` package (flat `{{key}}` template rendering, one `.md` file per stage) resolved inside the `runAgent` activity — never inside `packages/workflows` (determinism boundary) and never inside `packages/backends` (backends only see already-rendered text). `ClaudeBackend` spawns the real CLI, pipes the prompt via stdin, and applies a fail-safe error taxonomy: "the CLI ran and said something" is always a normal result (even garbage), "the CLI failed to run" is always a thrown error.

**Tech Stack:** TypeScript strict, `node:child_process` (no new dependency), zod, vitest.

**Prerequisite:** [worktree-activities plan](2026-07-03-worktree-activities.md) must be merged first — this plan's `dev-cycle.ts` edits assume `state.workspaceRef`/`state.branch` and `activities.prepareWorkspace`/`cleanupWorkspace` already exist.

**Design doc:** [docs/superpowers/specs/2026-07-03-claude-backend-design.md](../specs/2026-07-03-claude-backend-design.md)

---

### Task 1: `effort` field on `ModelRefSchema`

**Files:**
- Modify: `packages/contracts/src/model.ts`
- Modify: `packages/contracts/src/model.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/contracts/src/model.test.ts` (inside the existing `describe` for `ModelRefSchema`, or a new one if none exists — check the file first):

```ts
it('accepts an optional effort level', () => {
  expect(() => ModelRefSchema.parse({ backend: 'claude', model: 'claude-sonnet-5', effort: 'high' })).not.toThrow();
});

it('accepts a ModelRef with no effort at all', () => {
  expect(() => ModelRefSchema.parse({ backend: 'claude', model: 'claude-sonnet-5' })).not.toThrow();
});

it('rejects an invalid effort level', () => {
  expect(() => ModelRefSchema.parse({ backend: 'claude', model: 'claude-sonnet-5', effort: 'extreme' })).toThrow();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/contracts/src/model.test.ts`
Expected: FAIL — the third test passes when it shouldn't matter yet, but the first two currently pass anyway (extra fields are stripped by default zod object parsing, not rejected) so this step is mostly a formality; the real signal comes after Step 3 when `effort` becomes a recognized, validated field. Confirm by reading the actual output rather than assuming.

- [ ] **Step 3: Implement**

Modify `packages/contracts/src/model.ts` — add `effort` to `ModelRefSchema`:

```ts
export const ModelRefSchema = z.object({
  backend: z.enum(['claude', 'cursor', 'pi', 'codex', 'stub']),
  model: z.string().min(1),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;
```

(Everything else in `model.ts` — `BrakesSchema`, `RoutingSchema`, `StageToggleSchema` — is unchanged.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/contracts/src/model.test.ts`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/model.ts packages/contracts/src/model.test.ts
git commit -m "feat(contracts): add optional effort level to ModelRef"
```

---

### Task 2: `promptContext`/`effort` on `AgentRunRequest`, new `BackendRunRequest`

**Files:**
- Modify: `packages/contracts/src/agent-run.ts`
- Modify: `packages/contracts/src/agent-run.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/contracts/src/agent-run.test.ts`:

```ts
it('AgentRunRequestSchema defaults promptContext to an empty object', () => {
  const parsed = AgentRunRequestSchema.parse({
    taskId: 't1',
    stage: 'implement',
    attempt: 1,
    backend: 'claude',
    model: 'claude-sonnet-5',
    promptRef: 'implement.md',
    workspaceRef: '/tmp/ws',
    limits: { maxTokens: 1000, timeoutMs: 60_000 },
  });
  expect(parsed.promptContext).toEqual({});
  expect(parsed.effort).toBeUndefined();
});

it('AgentRunRequestSchema accepts promptContext and effort', () => {
  const parsed = AgentRunRequestSchema.parse({
    taskId: 't1',
    stage: 'implement',
    attempt: 1,
    backend: 'claude',
    model: 'claude-sonnet-5',
    effort: 'high',
    promptRef: 'implement.md',
    promptContext: { goal: 'add a widget' },
    workspaceRef: '/tmp/ws',
    limits: { maxTokens: 1000, timeoutMs: 60_000 },
  });
  expect(parsed.promptContext).toEqual({ goal: 'add a widget' });
  expect(parsed.effort).toBe('high');
});

describe('BackendRunRequestSchema', () => {
  it('has prompt instead of promptRef/promptContext, keeps everything else', () => {
    const parsed = BackendRunRequestSchema.parse({
      taskId: 't1',
      stage: 'implement',
      attempt: 1,
      callIndex: 1,
      backend: 'claude',
      model: 'claude-sonnet-5',
      effort: 'high',
      workspaceRef: '/tmp/ws',
      limits: { maxTokens: 1000, timeoutMs: 60_000 },
      prompt: 'rendered prompt text',
    });
    expect(parsed.prompt).toBe('rendered prompt text');
    expect((parsed as Record<string, unknown>).promptRef).toBeUndefined();
  });
});
```

(Add `describe`/`it`/`expect` and `AgentRunRequestSchema`/`BackendRunRequestSchema` to the file's existing imports as needed.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/contracts/src/agent-run.test.ts`
Expected: FAIL — `BackendRunRequestSchema` doesn't exist yet; `promptContext` isn't a recognized field yet.

- [ ] **Step 3: Implement**

Replace the contents of `packages/contracts/src/agent-run.ts`:

```ts
import { z } from 'zod';
import { StageSchema } from './stage';

export const AgentRunLimitsSchema = z.object({
  maxTokens: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
});
export type AgentRunLimits = z.infer<typeof AgentRunLimitsSchema>;

const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

export const AgentRunRequestSchema = z.object({
  taskId: z.string().min(1),
  stage: StageSchema,
  attempt: z.number().int().positive(),
  callIndex: z.number().int().positive().default(1),
  backend: z.string().min(1),
  model: z.string().min(1),
  effort: EffortSchema.optional(),
  promptRef: z.string().min(1),
  promptContext: z.record(z.string(), z.unknown()).default({}),
  workspaceRef: z.string().min(1),
  limits: AgentRunLimitsSchema,
});
export type AgentRunRequest = z.infer<typeof AgentRunRequestSchema>;

export const BackendRunRequestSchema = AgentRunRequestSchema
  .omit({ promptRef: true, promptContext: true })
  .extend({ prompt: z.string().min(1) });
export type BackendRunRequest = z.infer<typeof BackendRunRequestSchema>;

export const AgentRunResultSchema = z.object({
  output: z.string(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  wallMs: z.number().int().nonnegative(),
});
export type AgentRunResult = z.infer<typeof AgentRunResultSchema>;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/contracts/src/agent-run.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/agent-run.ts packages/contracts/src/agent-run.test.ts
git commit -m "feat(contracts): add promptContext/effort to AgentRunRequest, add BackendRunRequestSchema"
```

---

### Task 3: `packages/prompts` — pure template renderer

**Files:**
- Create: `packages/prompts/package.json`
- Create: `packages/prompts/tsconfig.json`
- Create: `packages/prompts/src/render-prompt.ts`
- Create: `packages/prompts/src/index.ts`
- Test: `packages/prompts/src/render-prompt.test.ts`

- [ ] **Step 1: Scaffold the package**

`packages/prompts/package.json`:

```json
{
  "name": "@agentops/prompts",
  "version": "0.0.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {}
}
```

`packages/prompts/tsconfig.json`:

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

Add it to the root workspace's devDependencies in `package.json` (alongside the other `@agentops/*` workspace entries) and to `vitest.config.ts`'s `resolve.alias` map:

```ts
      '@agentops/prompts': path.resolve(__dirname, 'packages/prompts/src/index.ts'),
```

Do the same in `vitest.e2e.config.ts` and `vitest.coverage.config.ts` if they define their own `resolve.alias` map (check each file — if they extend/import `vitest.config.ts`'s config instead of duplicating it, no change is needed there).

- [ ] **Step 2: Write the failing tests**

```ts
// packages/prompts/src/render-prompt.test.ts
import { describe, expect, it } from 'vitest';
import { renderPrompt, MissingTemplateVariableError } from './render-prompt';

describe('renderPrompt', () => {
  it('substitutes {{key}} placeholders', () => {
    const result = renderPrompt('Hello {{name}}, goal is {{goal}}.', { name: 'Ada', goal: 'ship it' });
    expect(result).toBe('Hello Ada, goal is ship it.');
  });

  it('substitutes the same key repeated multiple times', () => {
    const result = renderPrompt('{{x}} and {{x}} again', { x: 'foo' });
    expect(result).toBe('foo and foo again');
  });

  it('coerces non-string values to strings', () => {
    const result = renderPrompt('count: {{count}}', { count: 3 });
    expect(result).toBe('count: 3');
  });

  it('throws MissingTemplateVariableError when a referenced key is absent', () => {
    expect(() => renderPrompt('Hello {{name}}', {})).toThrow(MissingTemplateVariableError);
    expect(() => renderPrompt('Hello {{name}}', {})).toThrow(/name/);
  });

  it('ignores context keys the template does not reference', () => {
    const result = renderPrompt('Hello {{name}}', { name: 'Ada', unused: 'ignored' });
    expect(result).toBe('Hello Ada');
  });

  it('returns the template unchanged when it has no placeholders', () => {
    expect(renderPrompt('no placeholders here', {})).toBe('no placeholders here');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/prompts/src/render-prompt.test.ts`
Expected: FAIL — `Cannot find module './render-prompt'`.

- [ ] **Step 4: Implement**

```ts
// packages/prompts/src/render-prompt.ts
export class MissingTemplateVariableError extends Error {
  constructor(key: string) {
    super(`renderPrompt: template references "{{${key}}}" but no such key was provided in context`);
  }
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

export function renderPrompt(template: string, context: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    if (!(key in context)) {
      throw new MissingTemplateVariableError(key);
    }
    return String(context[key]);
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/prompts/src/render-prompt.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Export it**

```ts
// packages/prompts/src/index.ts
export * from './render-prompt';
```

- [ ] **Step 7: Commit**

```bash
git add packages/prompts/package.json packages/prompts/tsconfig.json packages/prompts/src/render-prompt.ts packages/prompts/src/render-prompt.test.ts packages/prompts/src/index.ts package.json vitest.config.ts
git commit -m "feat(prompts): add packages/prompts with pure flat-substitution renderer"
```

---

### Task 4: Prompt templates + file-backed prompt pack loader

**Files:**
- Create: `packages/prompts/templates/context.md`
- Create: `packages/prompts/templates/assess.md`
- Create: `packages/prompts/templates/design.md`
- Create: `packages/prompts/templates/plan.md`
- Create: `packages/prompts/templates/implement.md`
- Create: `packages/prompts/templates/full_verify.md`
- Create: `packages/prompts/templates/review.md`
- Create: `packages/prompts/src/prompt-pack.ts`
- Modify: `packages/prompts/src/index.ts`
- Test: `packages/prompts/src/prompt-pack.test.ts`

Templates live in `packages/prompts/templates/` (not under `src/`) so they're plain data, not compiled by `tsc` — `tsc build` only compiles `.ts` files under `rootDir: src`, so this directory is deliberately a sibling, not a child, of `src/`. **Known gap, deferred:** `pnpm build`'s output in `dist/` won't include these `.md` files; M1 runs everything via `tsx` against source directly (see `packages/worker/package.json`'s `start` script), so this doesn't block M1. Revisit when Docker images (M2) need a built artifact.

- [ ] **Step 1: Write the template files**

`packages/prompts/templates/context.md`:

```markdown
# Context — Task {{taskId}}

Goal: {{goal}}

Linked issue body (may be empty if this task has no linked issue):

{{issueBody}}

Explore this repository (structure, conventions, relevant existing code) enough to understand
what "done" looks like for this goal. You do not need to write any code yet — just build
the context the later design/plan/implement stages will need. Summarize what you found.
```

`packages/prompts/templates/assess.md`:

```markdown
# Assess — Task {{taskId}}

Goal: {{goal}}

Assess how large and how risky this change is. Note anything that changes how it should be
approached (e.g. it's trivial and doesn't need a separate design/plan pass, or it touches a
sensitive area and needs extra care).
```

`packages/prompts/templates/design.md`:

```markdown
# Design — Task {{taskId}}

Goal: {{goal}}

Propose a design for this change: what will change, why, and any alternatives you considered
and rejected. Do not write implementation code yet.
```

`packages/prompts/templates/plan.md`:

```markdown
# Plan — Task {{taskId}}

Goal: {{goal}}

Turn the design into a concrete, ordered implementation plan: which files change, in what
order, and how you'll verify each step. Do not write implementation code yet.
```

`packages/prompts/templates/implement.md`:

```markdown
# Implement — Task {{taskId}}

Goal: {{goal}}

Prior full_verify findings (empty if this is the first attempt):

{{fullVerifyFindings}}

Prior review findings (empty if this is the first attempt):

{{reviewFindings}}

Make the necessary code changes in this workspace to satisfy the goal above, addressing any
findings listed. When you are done, stage and commit your changes with `git add` / `git commit`
in this workspace — nothing you don't commit will ever be pushed or reviewed.
```

`packages/prompts/templates/full_verify.md`:

```markdown
# Full Verify — Task {{taskId}}

Goal: {{goal}}

Run the following verification commands in this workspace:

{{verifyCommands}}

If no commands are listed above, use your own judgment: review the diff (`git diff` against
the base branch) and reason about correctness directly.

End your response with exactly one line, after your explanation:

FULL: PASS

or

FULL: FAIL
```

`packages/prompts/templates/review.md`:

```markdown
# Review — Task {{taskId}}

Goal: {{goal}}

Review the changes currently committed in this workspace (`git diff` against the base branch,
or `git log` if you need history) for correctness, quality, and whether they actually satisfy
the goal above.

End your response with exactly one line, after your explanation:

VERDICT: PASS

or

VERDICT: FAIL
```

- [ ] **Step 2: Write the failing tests**

```ts
// packages/prompts/src/prompt-pack.test.ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PromptPack } from './prompt-pack';

describe('PromptPack', () => {
  it('renders a real bundled template by ref', () => {
    const pack = new PromptPack();
    const rendered = pack.render('implement.md', {
      taskId: 't1',
      goal: 'add a widget',
      fullVerifyFindings: '',
      reviewFindings: '',
    });
    expect(rendered).toContain('Task t1');
    expect(rendered).toContain('add a widget');
  });

  it('renders every built-in stage template without throwing, given the right context', () => {
    const pack = new PromptPack();
    expect(() => pack.render('context.md', { taskId: 't1', goal: 'g', issueBody: '' })).not.toThrow();
    expect(() => pack.render('assess.md', { taskId: 't1', goal: 'g' })).not.toThrow();
    expect(() => pack.render('design.md', { taskId: 't1', goal: 'g' })).not.toThrow();
    expect(() => pack.render('plan.md', { taskId: 't1', goal: 'g' })).not.toThrow();
    expect(() =>
      pack.render('implement.md', { taskId: 't1', goal: 'g', fullVerifyFindings: '', reviewFindings: '' }),
    ).not.toThrow();
    expect(() => pack.render('full_verify.md', { taskId: 't1', goal: 'g', verifyCommands: '' })).not.toThrow();
    expect(() => pack.render('review.md', { taskId: 't1', goal: 'g' })).not.toThrow();
  });

  it('throws a clear error for an unknown template ref', () => {
    const pack = new PromptPack();
    expect(() => pack.render('nonexistent.md', {})).toThrow(/nonexistent\.md/);
  });
});

describe('PromptPack with a custom templatesDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentops-prompts-test-'));
    writeFileSync(join(dir, 'custom.md'), 'Custom: {{value}}');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads templates from an overridden directory', () => {
    const pack = new PromptPack({ templatesDir: dir });
    expect(pack.render('custom.md', { value: 'x' })).toBe('Custom: x');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/prompts/src/prompt-pack.test.ts`
Expected: FAIL — `Cannot find module './prompt-pack'`.

- [ ] **Step 4: Implement**

```ts
// packages/prompts/src/prompt-pack.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderPrompt } from './render-prompt';

export interface PromptPackOptions {
  templatesDir?: string;
}

export class PromptPack {
  private readonly templatesDir: string;

  constructor(opts: PromptPackOptions = {}) {
    this.templatesDir = opts.templatesDir ?? join(__dirname, '..', 'templates');
  }

  render(ref: string, context: Record<string, unknown>): string {
    let template: string;
    try {
      template = readFileSync(join(this.templatesDir, ref), 'utf8');
    } catch {
      throw new Error(`PromptPack: no template found for ref "${ref}" in ${this.templatesDir}`);
    }
    return renderPrompt(template, context);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/prompts/src/prompt-pack.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Export it**

```ts
// packages/prompts/src/index.ts
export * from './render-prompt';
export * from './prompt-pack';
```

- [ ] **Step 7: Commit**

```bash
git add packages/prompts/templates packages/prompts/src/prompt-pack.ts packages/prompts/src/prompt-pack.test.ts packages/prompts/src/index.ts
git commit -m "feat(prompts): add the seven stage templates and a file-backed PromptPack"
```

---

### Task 5: `AgentBackend` interface takes `BackendRunRequest`

**Files:**
- Modify: `packages/backends/src/agent-backend.ts`
- Modify: `packages/backends/src/stub/stub-backend.ts`
- Modify: `packages/backends/src/stub/stub-backend.test.ts`

- [ ] **Step 1: Update the failing test first**

`packages/backends/src/stub/stub-backend.test.ts`'s `baseRequest` object needs a `prompt` field (required by `BackendRunRequest`) and no longer needs `promptRef` (removed from that type):

```ts
const baseRequest = {
  taskId: 'task-1',
  backend: 'stub',
  model: 'stub-v1',
  prompt: 'rendered prompt text',
  workspaceRef: 'demo/repo',
  limits: { maxTokens: 1000, timeoutMs: 60_000 },
} as const;
```

(This replaces the existing `baseRequest` at the top of the file — same four tests below it are otherwise unchanged, since they only vary `stage`/`attempt`/`callIndex`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/backends/src/stub/stub-backend.test.ts`
Expected: FAIL on typecheck — `Property 'promptRef' does not exist` style error will surface once Step 3 lands; run `pnpm --filter @agentops/backends run typecheck` if vitest doesn't itself catch the type error before Step 3.

- [ ] **Step 3: Update the interface and StubBackend**

`packages/backends/src/agent-backend.ts`:

```ts
import type { BackendRunRequest, AgentRunResult } from '@agentops/contracts';

export interface AgentBackend {
  run(req: BackendRunRequest): Promise<AgentRunResult>;
}
```

`packages/backends/src/stub/stub-backend.ts` — only the type import and `run`'s parameter type change:

```ts
import type { BackendRunRequest, AgentRunResult, Stage } from '@agentops/contracts';
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

  async run(req: BackendRunRequest): Promise<AgentRunResult> {
    const scripted = this.script.get(this.key(req.stage, req.attempt, req.callIndex));
    return { ...DEFAULT_RESPONSE, ...scripted };
  }

  private key(stage: Stage, attempt: number, callIndex: number): string {
    return `${stage}#${attempt}.${callIndex}`;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/backends/src/stub/stub-backend.test.ts && pnpm --filter @agentops/backends run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/backends/src/agent-backend.ts packages/backends/src/stub/stub-backend.ts packages/backends/src/stub/stub-backend.test.ts
git commit -m "feat(backends): AgentBackend.run takes a BackendRunRequest"
```

---

### Task 6: `ClaudeBackend`

**Files:**
- Create: `packages/backends/src/claude/claude-backend.ts`
- Test: `packages/backends/src/claude/claude-backend.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/backends/src/claude/claude-backend.test.ts
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { BackendRunRequest } from '@agentops/contracts';
import { ClaudeBackend, ClaudeBackendAuthError, ClaudeBackendProcessError, ClaudeBackendTimeoutError } from './claude-backend';

const baseRequest: BackendRunRequest = {
  taskId: 't1',
  stage: 'implement',
  attempt: 1,
  callIndex: 1,
  backend: 'claude',
  model: 'claude-sonnet-5',
  workspaceRef: '/tmp/ws',
  limits: { maxTokens: 1000, timeoutMs: 5000 },
  prompt: 'do the thing',
};

function fakeChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: { write: (chunk: string) => void; end: () => void };
    kill: (signal?: string) => void;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const stdinWrites: string[] = [];
  child.stdin = {
    write: (chunk: string) => {
      stdinWrites.push(chunk);
    },
    end: () => {},
  };
  const killedSignals: (string | undefined)[] = [];
  child.kill = (signal?: string) => {
    killedSignals.push(signal);
  };
  return { child, killedSignals, stdinWrites };
}

describe('ClaudeBackend', () => {
  it('spawns claude with the expected flags and pipes the prompt via stdin, not argv', async () => {
    const { child, stdinWrites } = fakeChildProcess();
    const calls: { command: string; args: string[] }[] = [];
    const spawnFn = vi.fn((command: string, args: string[]) => {
      calls.push({ command, args });
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 2 }, duration_ms: 10 }));
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ClaudeBackend({ spawn: spawnFn as never });

    await backend.run(baseRequest);

    expect(calls[0].command).toBe('claude');
    expect(calls[0].args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--model',
      'claude-sonnet-5',
      '--max-turns',
      '30',
      '--dangerously-skip-permissions',
    ]);
    expect(stdinWrites.join('')).toBe('do the thing');
  });

  it('adds --effort when the request specifies one', async () => {
    const { child } = fakeChildProcess();
    const calls: string[][] = [];
    const spawnFn = vi.fn((_command: string, args: string[]) => {
      calls.push(args);
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 1 }));
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ClaudeBackend({ spawn: spawnFn as never });

    await backend.run({ ...baseRequest, effort: 'high' });

    expect(calls[0]).toContain('--effort');
    expect(calls[0][calls[0].indexOf('--effort') + 1]).toBe('high');
  });

  it('maps valid JSON output to AgentRunResult', async () => {
    const { child } = fakeChildProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end(
          JSON.stringify({ is_error: false, result: 'final text', usage: { input_tokens: 12, output_tokens: 34 }, duration_ms: 999 }),
        );
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ClaudeBackend({ spawn: spawnFn as never });

    const result = await backend.run(baseRequest);

    expect(result).toEqual({ output: 'final text', tokensIn: 12, tokensOut: 34, wallMs: 999 });
  });

  it('returns raw text with zero tokens when stdout is not valid JSON (never throws)', async () => {
    const { child } = fakeChildProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end('not json at all');
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ClaudeBackend({ spawn: spawnFn as never });

    const result = await backend.run(baseRequest);

    expect(result.output).toBe('not json at all');
    expect(result.tokensIn).toBe(0);
    expect(result.tokensOut).toBe(0);
  });

  it('returns is_error:true JSON output as a normal result (verdict parsing happens downstream)', async () => {
    const { child } = fakeChildProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end(
          JSON.stringify({ is_error: true, result: 'hit an internal snag', usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 5 }),
        );
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ClaudeBackend({ spawn: spawnFn as never });

    const result = await backend.run(baseRequest);

    expect(result.output).toBe('hit an internal snag');
  });

  it('throws ClaudeBackendProcessError when the process exits nonzero with no stdout at all', async () => {
    const { child } = fakeChildProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end('');
        child.stderr.end('fatal: bad flag');
        child.emit('close', 1);
      });
      return child;
    });
    const backend = new ClaudeBackend({ spawn: spawnFn as never });

    await expect(backend.run(baseRequest)).rejects.toThrow(ClaudeBackendProcessError);
  });

  it('throws ClaudeBackendAuthError when stderr matches a known auth-failure pattern', async () => {
    const { child } = fakeChildProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end('');
        child.stderr.end('Error: invalid api key');
        child.emit('close', 1);
      });
      return child;
    });
    const backend = new ClaudeBackend({ spawn: spawnFn as never });

    await expect(backend.run(baseRequest)).rejects.toThrow(ClaudeBackendAuthError);
  });

  it('throws ClaudeBackendTimeoutError and sends SIGTERM when the process outlives the timeout', async () => {
    const { child, killedSignals } = fakeChildProcess();
    const spawnFn = vi.fn(() => child); // never emits 'close' — simulates a hung process
    // killGraceMs kept short so the background SIGKILL fallback timer doesn't outlive the test.
    const backend = new ClaudeBackend({ spawn: spawnFn as never, killGraceMs: 10 });

    await expect(backend.run({ ...baseRequest, limits: { maxTokens: 1000, timeoutMs: 20 } })).rejects.toThrow(
      ClaudeBackendTimeoutError,
    );
    expect(killedSignals).toContain('SIGTERM');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/backends/src/claude/claude-backend.test.ts`
Expected: FAIL — `Cannot find module './claude-backend'`.

- [ ] **Step 3: Implement**

```ts
// packages/backends/src/claude/claude-backend.ts
import { spawn as nodeSpawn } from 'node:child_process';
import type { AgentRunResult, BackendRunRequest } from '@agentops/contracts';
import type { AgentBackend } from '../agent-backend';

export class ClaudeBackendProcessError extends Error {}
export class ClaudeBackendTimeoutError extends Error {}
export class ClaudeBackendAuthError extends Error {}

export interface ClaudeBackendOptions {
  executablePath?: string;
  spawn?: typeof nodeSpawn;
  env?: NodeJS.ProcessEnv;
  maxTurns?: number;
  killGraceMs?: number;
}

interface ClaudeJsonResult {
  is_error?: boolean;
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  duration_ms?: number;
}

const AUTH_ERROR_PATTERN = /(invalid|expired).{0,30}(api key|token)/i;

export class ClaudeBackend implements AgentBackend {
  private readonly executablePath: string;
  private readonly spawnFn: typeof nodeSpawn;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly maxTurns: number;
  private readonly killGraceMs: number;

  constructor(opts: ClaudeBackendOptions = {}) {
    this.executablePath = opts.executablePath ?? 'claude';
    this.spawnFn = opts.spawn ?? nodeSpawn;
    this.env = opts.env;
    this.maxTurns = opts.maxTurns ?? 30;
    this.killGraceMs = opts.killGraceMs ?? 5000;
  }

  async run(req: BackendRunRequest): Promise<AgentRunResult> {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--model',
      req.model,
      '--max-turns',
      String(this.maxTurns),
      '--dangerously-skip-permissions',
    ];
    if (req.effort) {
      args.push('--effort', req.effort);
    }

    const start = Date.now();
    const child = this.spawnFn(this.executablePath, args, {
      cwd: req.workspaceRef,
      env: this.env ?? process.env,
    });
    child.stdin?.write(req.prompt);
    child.stdin?.end();

    return new Promise<AgentRunResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        // Independent of promise settlement below — this must keep running even after we've
        // already rejected, so a process that ignores SIGTERM still gets killed eventually.
        setTimeout(() => child.kill('SIGKILL'), this.killGraceMs);
        settle(() => {
          reject(new ClaudeBackendTimeoutError(`claude timed out after ${req.limits.timeoutMs}ms`));
        });
      }, req.limits.timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (err: Error) => {
        settle(() => reject(new ClaudeBackendProcessError(`failed to spawn claude: ${err.message}`)));
      });

      child.on('close', (exitCode: number | null) => {
        settle(() => {
          const wallMs = Date.now() - start;

          if (AUTH_ERROR_PATTERN.test(stderr)) {
            reject(new ClaudeBackendAuthError(stderr.trim()));
            return;
          }

          if (stdout.trim().length === 0 && (exitCode ?? 1) !== 0) {
            reject(new ClaudeBackendProcessError(`claude exited ${exitCode} with no output: ${stderr.trim()}`));
            return;
          }

          let parsed: ClaudeJsonResult | undefined;
          try {
            parsed = JSON.parse(stdout) as ClaudeJsonResult;
          } catch {
            parsed = undefined;
          }

          if (!parsed || typeof parsed.result !== 'string') {
            resolve({ output: stdout || stderr, tokensIn: 0, tokensOut: 0, wallMs });
            return;
          }

          resolve({
            output: parsed.result,
            tokensIn: parsed.usage?.input_tokens ?? 0,
            tokensOut: parsed.usage?.output_tokens ?? 0,
            wallMs: parsed.duration_ms ?? wallMs,
          });
        });
      });
    });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/backends/src/claude/claude-backend.test.ts`
Expected: PASS (all 8 tests). If the timeout test is flaky, confirm the fake `setTimeout`/`queueMicrotask` ordering — it should not be, since `vi` fake timers aren't used here (the test relies on a real 20ms timeout firing before an unresolved fake child ever emits `close`).

- [ ] **Step 5: Export it from the package barrel**

Registering `'claude'` in a real `ActivityDependencies.backends` map is the shared M1 integration step every sub-project design doc defers (no real worker/CLI wiring exists yet to attach it to) — out of scope here. This step only makes the class importable.

`packages/backends/src/index.ts`:

```ts
export * from './agent-backend';
export * from './stub/stub-backend';
export * from './claude/claude-backend';
```

- [ ] **Step 6: Commit**

```bash
git add packages/backends/src/claude/claude-backend.ts packages/backends/src/claude/claude-backend.test.ts packages/backends/src/index.ts
git commit -m "feat(backends): add ClaudeBackend (real claude CLI, fail-safe error taxonomy)"
```

---

### Task 7: Wire prompt rendering into `runAgent`

**Files:**
- Modify: `packages/activities/src/create-activities.ts`
- Modify: `packages/activities/src/create-activities.test.ts`
- Modify: `packages/workflows/src/activities-api.ts` (no signature change needed — `AgentRunRequest` already carries `promptContext`/`effort` from Task 2; confirm, don't edit, unless the file re-declares those types locally)

- [ ] **Step 1: Update the failing test first**

`packages/activities/src/create-activities.test.ts`'s `buildDeps()` needs a `prompts` dependency, and the existing `runAgent delegates to the named backend` test needs `promptContext` supplied (or it can rely on the schema default `{}` — leave the request as-is if `promptRef: 'implement.md'` still resolves against a real template). Update `buildDeps()`:

```ts
import { PromptPack } from '@agentops/prompts';
// ...
function buildDeps() {
  return {
    backends: { stub: new StubBackend() },
    tracker: new MemoryTrackerPort(),
    scm: new MemoryScmPort(),
    stats: new InMemoryStatsStore(),
    stageResults: new InMemoryStageResultStore(),
    workspaces: new MemoryWorkspaceManager(),
    prompts: new PromptPack(),
  };
}
```

Add `import type { AgentBackend } from '@agentops/backends';` to the file's existing top-of-file imports, then add a new test confirming the render actually happens before the backend is called:

```ts
describe('createActivities — prompt rendering', () => {
  it('renders promptRef/promptContext into prompt text before calling the backend', async () => {
    let receivedPrompt = '';
    const fakeBackend: AgentBackend = {
      async run(req) {
        receivedPrompt = req.prompt;
        return { output: 'ok', tokensIn: 1, tokensOut: 1, wallMs: 1 };
      },
    };
    const activities = createActivities({ ...buildDeps(), backends: { stub: fakeBackend } });

    await activities.runAgent({
      taskId: 't1',
      stage: 'implement',
      attempt: 1,
      callIndex: 1,
      backend: 'stub',
      model: 'stub-v1',
      promptRef: 'implement.md',
      promptContext: { taskId: 't1', goal: 'add a widget', fullVerifyFindings: '', reviewFindings: '' },
      workspaceRef: 'demo/repo',
      limits: { maxTokens: 1000, timeoutMs: 60_000 },
    });

    expect(receivedPrompt).toContain('add a widget');
  });

  it('throws when promptContext is missing a variable the template requires', async () => {
    const deps = buildDeps();
    const activities = createActivities(deps);

    await expect(
      activities.runAgent({
        taskId: 't1',
        stage: 'implement',
        attempt: 1,
        callIndex: 1,
        backend: 'stub',
        model: 'stub-v1',
        promptRef: 'implement.md',
        promptContext: { taskId: 't1', goal: 'g' }, // missing fullVerifyFindings/reviewFindings
        workspaceRef: 'demo/repo',
        limits: { maxTokens: 1000, timeoutMs: 60_000 },
      }),
    ).rejects.toThrow(/fullVerifyFindings/);
  });
});
```

The pre-existing `runAgent delegates to the named backend` test's request has no `promptContext` — `implement.md` now requires `fullVerifyFindings`/`reviewFindings`, so without it the render step throws before ever reaching the stub. Change its `runAgent` call from:

```ts
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
```

to:

```ts
    const result = await activities.runAgent({
      taskId: 't1',
      stage: 'implement',
      attempt: 1,
      callIndex: 1,
      backend: 'stub',
      model: 'stub-v1',
      promptRef: 'implement.md',
      promptContext: { taskId: 't1', goal: 'g', fullVerifyFindings: '', reviewFindings: '' },
      workspaceRef: 'demo/repo',
      limits: { maxTokens: 1000, timeoutMs: 60_000 },
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/activities/src/create-activities.test.ts`
Expected: FAIL — `runAgent` doesn't render anything yet; `req.prompt` is `undefined` in the fake backend.

- [ ] **Step 3: Implement**

`packages/activities/src/create-activities.ts`:

```ts
import type { AgentBackend } from '@agentops/backends';
import type { Issue, OpenPrRequest, OpenPrResult, ScmPort, TrackerPort } from '@agentops/ports';
import type { AgentRunRequest, AgentRunResult, PrFeedback, RunStats } from '@agentops/contracts';
import type { PromptPack } from '@agentops/prompts';
import type { StageResultRecord, StageResultStore } from './stage-result-store';
import type { StatsStore } from './stats-store';
import type { PreparedWorkspace, Workspaces } from './workspace/workspace-manager';

export interface ActivityDependencies {
  backends: Record<string, AgentBackend>;
  tracker: TrackerPort;
  scm: ScmPort;
  stats: StatsStore;
  stageResults: StageResultStore;
  workspaces: Workspaces;
  prompts: PromptPack;
}

export function createActivities(deps: ActivityDependencies) {
  return {
    async runAgent(req: AgentRunRequest): Promise<AgentRunResult> {
      const backend = deps.backends[req.backend];
      if (!backend) {
        throw new Error(`createActivities.runAgent: unknown backend "${req.backend}"`);
      }
      const prompt = deps.prompts.render(req.promptRef, req.promptContext);
      return backend.run({
        taskId: req.taskId,
        stage: req.stage,
        attempt: req.attempt,
        callIndex: req.callIndex,
        backend: req.backend,
        model: req.model,
        effort: req.effort,
        workspaceRef: req.workspaceRef,
        limits: req.limits,
        prompt,
      });
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
    async pushBranch(workspaceRef: string, branch: string, contentHash: string): Promise<void> {
      await deps.scm.push(workspaceRef, branch, contentHash);
    },
    async recordStageResult(result: StageResultRecord): Promise<void> {
      deps.stageResults.record(result);
    },
    async recordRunStats(stats: RunStats): Promise<void> {
      deps.stats.record(stats);
    },
    async prepareWorkspace(req: { taskId: string; repo: string }): Promise<PreparedWorkspace> {
      return deps.workspaces.prepare(req.taskId, req.repo);
    },
    async cleanupWorkspace(workspaceRef: string, repo: string): Promise<void> {
      await deps.workspaces.cleanup(workspaceRef, repo);
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
```

Add `@agentops/prompts` to `packages/activities/package.json`'s `dependencies`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/activities/src/create-activities.test.ts && pnpm --filter @agentops/activities run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/activities/src/create-activities.ts packages/activities/src/create-activities.test.ts packages/activities/package.json
git commit -m "feat(activities): render promptRef/promptContext before calling the backend"
```

---

### Task 8: Wire `promptContext`/`effort` through `dev-cycle.ts`, capture verdict output for repair rounds

**Files:**
- Modify: `packages/workflows/src/dev-cycle.ts`

- [ ] **Step 1: Widen the activity timeout for `runAgent` specifically**

Real `claude` runs can exceed the blanket 10-minute activity timeout. Add a second, longer-lived proxy scoped to just `runAgent`:

```ts
import { condition, defineQuery, defineSignal, proxyActivities, setHandler, sleep } from '@temporalio/workflow';
import type { BlockReason, Brakes, ModelRef, Routing, Stage, TaskInput, TaskStatus, VerdictKind } from '@agentops/contracts';
import { feedbackHash } from '@agentops/contracts';
import { babysitDecision, nextRepairAction, parseVerdict, preImplementStages } from '@agentops/policies';
import type { DevCycleActivities } from './activities-api';

const activities = proxyActivities<DevCycleActivities>({
  startToCloseTimeout: '10 minutes',
});

const agentActivities = proxyActivities<Pick<DevCycleActivities, 'runAgent'>>({
  startToCloseTimeout: '30 minutes',
});
```

(`ModelRef` is added to the existing `@agentops/contracts` type-only import.)

- [ ] **Step 2: Fetch and store the issue body**

Replace:

```ts
  if (input.issueRef) {
    await activities.getIssue(input.issueRef);
  }
```

with:

```ts
  let issueBody = '';
  if (input.issueRef) {
    const issue = await activities.getIssue(input.issueRef);
    issueBody = issue.body;
  }
```

Move this block to right after the `prepared`/`state.workspaceRef`/`state.branch` assignment (from the worktree-activities plan) and before the `preImplementStages` loop — it must run before `context`'s prompt is built.

- [ ] **Step 3: Give `runStageAgent` an `extraContext` parameter, call the widened proxy, pass `effort`**

Replace the whole `runStageAgent` definition:

```ts
  const runStageAgent = async (
    stage: RoutableStage,
    attempt: number,
    callIndex = 1,
    modelOverride?: ModelRef,
    extraContext: Record<string, unknown> = {},
  ): Promise<string> => {
    const routed = input.config.routing[stage];
    const model = modelOverride ?? routed;
    const backend = model?.backend ?? 'stub';
    const modelName = model?.model ?? 'stub';
    const result = await agentActivities.runAgent({
      taskId: input.taskId,
      stage,
      attempt,
      callIndex,
      backend,
      model: modelName,
      effort: model?.effort,
      promptRef: `${stage}.md`,
      promptContext: { taskId: input.taskId, goal: input.goal, ...extraContext },
      workspaceRef: state.workspaceRef,
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
```

- [ ] **Step 4: Make `runVerdictStage` return the raw output too, and accept `extraContext`**

Replace the whole `runVerdictStage` definition:

```ts
  const runVerdictStage = async (
    stage: 'full_verify' | 'review',
    attempt: number,
    sentinel: string,
    extraContext: Record<string, unknown> = {},
  ): Promise<{ kind: VerdictKind; output: string }> => {
    let lastKind: VerdictKind = 'unparseable';
    let lastOutput = '';
    for (let call = 1; call <= MAX_VERDICT_CALLS; call += 1) {
      const output = await runStageAgent(stage, attempt, call, undefined, extraContext);
      lastOutput = output;
      const parsed = parseVerdict(output, sentinel);
      lastKind = parsed.kind;
      if (parsed.kind !== 'unparseable') {
        return { kind: parsed.kind, output };
      }
    }
    return { kind: lastKind === 'unparseable' ? 'fail' : lastKind, output: lastOutput };
  };
```

- [ ] **Step 5: Pass `issueBody` on the `context` stage**

In the `preImplementStages` loop:

```ts
  for (const stage of preImplementStages({ config: input.config, hasHumanDesign: false, hasHumanPlan: false })) {
    state.stage = stage;
    const extraContext = stage === 'context' ? { issueBody } : {};
    await runStageAgent(stage as RoutableStage, 1, 1, undefined, extraContext);
    if (cancelled) {
```

(only the `runStageAgent` call line changes; the `if (cancelled)`/`if (stopRequested)` block below is untouched)

- [ ] **Step 6: Thread `fullVerifyFindings`/`reviewFindings`/`verifyCommands` through the repair loop**

Add two accumulator variables alongside the existing `fullVerifyVerdict`/`reviewVerdict` declarations:

```ts
  let fullVerifyVerdict: VerdictKind = 'unparseable';
  let reviewVerdict: VerdictKind | null = null;
  let lastFullVerifyOutput = '';
  let lastReviewOutput = '';
```

Change the `implement` call inside the `while (true)` repair loop from:

```ts
    state.stage = 'implement';
    const implementModel = useEscalation ? input.config.escalation : undefined;
    const implementOutput = await runStageAgent('implement', implementAttempt, 1, implementModel);
```

to:

```ts
    state.stage = 'implement';
    const implementModel = useEscalation ? input.config.escalation : undefined;
    const implementOutput = await runStageAgent('implement', implementAttempt, 1, implementModel, {
      fullVerifyFindings: lastFullVerifyOutput,
      reviewFindings: lastReviewOutput,
    });
```

Change the `full_verify`/`review` calls from:

```ts
    state.stage = 'full_verify';
    fullVerifyVerdict = await runVerdictStage('full_verify', implementAttempt, 'FULL:');

    if (fullVerifyVerdict === 'pass') {
      state.stage = 'review';
      reviewVerdict = await runVerdictStage('review', reviewAttempt, 'VERDICT:');
      reviewAttempt += 1;
    } else {
      reviewVerdict = null;
    }
```

to:

```ts
    state.stage = 'full_verify';
    const verifyCommands =
      [...input.config.fastVerifyCommands, ...input.config.fullVerifyCommands].join('\n') ||
      '(none configured — use your own judgment on the diff)';
    const fullVerifyResult = await runVerdictStage('full_verify', implementAttempt, 'FULL:', { verifyCommands });
    fullVerifyVerdict = fullVerifyResult.kind;
    lastFullVerifyOutput = fullVerifyResult.output;

    if (fullVerifyVerdict === 'pass') {
      state.stage = 'review';
      const reviewResult = await runVerdictStage('review', reviewAttempt, 'VERDICT:');
      reviewVerdict = reviewResult.kind;
      lastReviewOutput = reviewResult.output;
      reviewAttempt += 1;
    } else {
      reviewVerdict = null;
    }
```

- [ ] **Step 7: Fix the babysit loop's `implement` re-run — it needs the same two keys**

`implement.md` always requires `fullVerifyFindings`/`reviewFindings`, so every call site must supply them — including the babysit loop's repair round. Change:

```ts
      await runStageAgent('implement', implementAttempt);
```

to:

```ts
      await runStageAgent('implement', implementAttempt, 1, undefined, {
        fullVerifyFindings: lastFullVerifyOutput,
        reviewFindings: lastReviewOutput,
      });
```

(Reusing the last known full_verify/review output from the pre-PR repair loop as context — there's no PR-feedback-specific template variable yet; this keeps every `implement` call satisfying the same template contract without inventing new design surface.)

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter @agentops/workflows run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/workflows/src/dev-cycle.ts
git commit -m "feat(workflows): wire promptContext/effort through DevCycle, widen runAgent activity timeout"
```

---

### Task 9: Wire the real prompt pack into e2e tests and the manual-run worker

**Files:**
- Modify: `e2e/helpers.ts`
- Modify: `packages/worker/src/main.ts`

`ActivityDependencies` now requires `prompts` (Task 7) — **two** call sites construct it today, not just the e2e helper: `e2e/helpers.ts` (tests) and `packages/worker/src/main.ts` (the manual-run worker process the README's quick-start documents via `pnpm --filter @agentops/worker run start`). Both break at typecheck if only one is updated. (`@agentops/prompts` is already resolvable in both via the root `package.json` devDependency and `vitest.config.ts` alias added in Task 3, plus `packages/worker`'s own `dependencies` — add `@agentops/prompts` there too if it's missing.)

- [ ] **Step 1: Update `buildTestEnv`**

Add `prompts: new PromptPack()` to the `createActivities` call in `e2e/helpers.ts`:

```ts
import { PromptPack } from '@agentops/prompts';
// ... existing imports unchanged

export async function buildTestEnv(): Promise<TestEnv> {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const stub = new StubBackend();
  const tracker = new MemoryTrackerPort();
  const scm = new MemoryScmPort();
  const stats = new InMemoryStatsStore();
  const stageResults = new InMemoryStageResultStore();
  const workspaces = new MemoryWorkspaceManager();

  const activities: DevCycleActivities = createActivities({
    backends: { stub },
    tracker,
    scm,
    stats,
    stageResults,
    workspaces,
    prompts: new PromptPack(),
  });
  // ...unchanged below
```

- [ ] **Step 2: Update the manual-run worker the same way**

`packages/worker/src/main.ts`:

```ts
import { NativeConnection } from '@temporalio/worker';
import { createActivities, InMemoryStageResultStore, InMemoryStatsStore, MemoryWorkspaceManager } from '@agentops/activities';
import { StubBackend } from '@agentops/backends';
import { MemoryScmPort, MemoryTrackerPort } from '@agentops/ports';
import { PromptPack } from '@agentops/prompts';
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
    workspaces: new MemoryWorkspaceManager(),
    prompts: new PromptPack(),
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

Add `@agentops/prompts` to `packages/worker/package.json`'s `dependencies`.

- [ ] **Step 3: Run the full e2e suite and typecheck**

Run: `pnpm e2e && pnpm --filter @agentops/worker run typecheck`
Expected: PASS — all four e2e scenarios still green (the real end-to-end check that every `promptContext` call site built in Task 8 supplies exactly the keys each template needs; a missing key would surface here as a thrown `MissingTemplateVariableError`), and the worker package typechecks clean.

- [ ] **Step 4: Commit**

```bash
git add e2e/helpers.ts packages/worker/src/main.ts packages/worker/package.json
git commit -m "feat(worker): wire the real PromptPack into e2e tests and the manual-run worker"
```

---

### Task 10: Full local verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full gate**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e
```

Expected: all green.

- [ ] **Step 2: Commit if the gate required any fixes**

```bash
git add -A
git commit -m "chore: fix lint/typecheck fallout from claude backend"
```

(Skip if Step 1 was already green.)

---

### Task 11: Open the PR, pass CI, and resolve the Bugbot review

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
gh pr create --base main --fill --title "feat: real claude backend with rendered prompts"
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
