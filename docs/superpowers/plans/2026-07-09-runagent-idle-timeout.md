# `runAgent` Idle-Timeout & Live Log Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `K8sJobRunner`'s fixed 10-minute wall-clock kill with an idle-timeout (kill only when the CLI actually goes quiet) plus a generous overall backstop, mirror the CLI's output live into the Job's container logs (so Alloy/Loki actually captures it, closing the ARCHITECTURE.md §5.4 gap), and make both timeouts per-stage configurable in `ProjectConfig`.

**Architecture:** `K8sJobRunner` tracks growth of the CLI's own output/error files (already mounted in the engine-worker pod) as a liveness signal, replacing the single `elapsedMs > timeoutMs` check with an idle check and a backstop check, and reports both via the Temporal heartbeat. The Job's container command changes from a plain `>`/`2>` redirect to a FIFO+`tee` pipeline so the same output also reaches the container's own stdout/stderr (which Alloy already scrapes). A new pure `resolveStageLimits` policy function resolves per-stage overrides from `ProjectConfig.timeouts`, falling back to two new global defaults, and both `dev-cycle.ts` and `platform.ts` are wired to use it.

**Tech Stack:** TypeScript strict, Temporal TypeScript SDK, zod (`@agentops/contracts`), vitest, Node `fs/promises`/`child_process`.

**Design doc:** `docs/superpowers/specs/2026-07-09-runagent-idle-timeout-design.md`

---

### Task 1: `TimeoutsSchema` in `packages/contracts`

**Files:**
- Modify: `packages/contracts/src/model.ts`
- Test: `packages/contracts/src/model.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/contracts/src/model.test.ts`, updating the import on line 2 to also pull in `TimeoutsSchema`:

```ts
import { ModelRefSchema, BrakesSchema, RoutingSchema, TimeoutsSchema } from './model';
```

Append a new `describe` block at the end of the file:

```ts
describe('TimeoutsSchema', () => {
  it('allows a partial timeouts table, same shape as RoutingSchema', () => {
    const timeouts = TimeoutsSchema.parse({ context: { idleTimeoutMs: 600_000 } });
    expect(timeouts.context).toEqual({ idleTimeoutMs: 600_000 });
    expect(timeouts.review).toBeUndefined();
  });

  it('allows a stage entry with both idleTimeoutMs and timeoutMs', () => {
    const timeouts = TimeoutsSchema.parse({ implement: { idleTimeoutMs: 300_000, timeoutMs: 3_600_000 } });
    expect(timeouts.implement).toEqual({ idleTimeoutMs: 300_000, timeoutMs: 3_600_000 });
  });

  it('rejects a negative idleTimeoutMs', () => {
    expect(() => TimeoutsSchema.parse({ context: { idleTimeoutMs: -1 } })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @agentops/contracts test -- model.test.ts`
Expected: FAIL — `TimeoutsSchema` is not exported from `./model`.

- [ ] **Step 3: Implement `TimeoutsSchema`**

In `packages/contracts/src/model.ts`, insert immediately after the existing `RoutingSchema`/`Routing` export (after the `export type Routing = z.infer<typeof RoutingSchema>;` line, before `StageToggleSchema`):

```ts
export const StageTimeoutSchema = z.object({
  idleTimeoutMs: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
});
export type StageTimeout = z.infer<typeof StageTimeoutSchema>;

export const TimeoutsSchema = z.object({
  context: StageTimeoutSchema.optional(),
  assess: StageTimeoutSchema.optional(),
  design: StageTimeoutSchema.optional(),
  plan: StageTimeoutSchema.optional(),
  implement: StageTimeoutSchema.optional(),
  full_verify: StageTimeoutSchema.optional(),
  review: StageTimeoutSchema.optional(),
  pr: StageTimeoutSchema.optional(),
  pr_babysit: StageTimeoutSchema.optional(),
});
export type Timeouts = z.infer<typeof TimeoutsSchema>;
```

Note the key list deliberately matches `RoutingSchema`'s exactly — `dev-cycle.ts`'s existing `RoutableStage = keyof Routing` alias will be passed directly as a `keyof Timeouts` argument in Task 7, which only type-checks if the two key sets are identical.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @agentops/contracts test -- model.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/model.ts packages/contracts/src/model.test.ts
git commit -m "feat(contracts): add TimeoutsSchema for per-stage idle/backstop overrides"
```

---

### Task 2: `timeouts` field on `ProjectConfig`

**Files:**
- Modify: `packages/contracts/src/project-config.ts`
- Test: `packages/contracts/src/project-config.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/contracts/src/project-config.test.ts`, add inside `describe('ProjectConfigSchema', ...)` (after the "accepts an optional escalation model" test):

```ts
  it('accepts an optional per-stage timeouts override', () => {
    const parsed = ProjectConfigSchema.parse({
      ...validConfig,
      timeouts: { context: { idleTimeoutMs: 600_000 }, implement: { timeoutMs: 3_600_000 } },
    });
    expect(parsed.timeouts?.context).toEqual({ idleTimeoutMs: 600_000 });
    expect(parsed.timeouts?.implement).toEqual({ timeoutMs: 3_600_000 });
  });
```

And inside `describe('parseProjectConfig', ...)` (after the "leaves initCommands undefined..." test):

```ts
  it('leaves timeouts undefined when not configured, and passes it through untouched when supplied', () => {
    const empty = parseProjectConfig({});
    expect(empty.timeouts).toBeUndefined();

    const configured = parseProjectConfig({ timeouts: { context: { idleTimeoutMs: 600_000 } } });
    expect(configured.timeouts).toEqual({ context: { idleTimeoutMs: 600_000 } });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @agentops/contracts test -- project-config.test.ts`
Expected: FAIL — `ProjectConfigSchema.parse` throws/strips on the unrecognized `timeouts` key (zod's default is to strip unknown keys, so `parsed.timeouts` is `undefined` and the `toEqual` assertions fail).

- [ ] **Step 3: Implement the field**

In `packages/contracts/src/project-config.ts`, change the import on line 2:

```ts
import { ModelRefSchema, BrakesSchema, RoutingSchema, StageToggleSchema, TimeoutsSchema } from './model';
```

And add `timeouts` to `ProjectConfigSchema` (after `brakes: BrakesSchema,`):

```ts
export const ProjectConfigSchema = z.object({
  image: z.string().min(1).optional(),
  services: z.array(VerifyServiceSchema).optional(),
  initCommands: z.array(z.string()).optional(),
  fastVerifyCommands: z.array(z.string()).optional(),
  fullVerifyCommands: z.array(z.string()).optional(),
  stages: StageToggleSchema,
  routing: RoutingSchema,
  escalation: ModelRefSchema.optional(),
  brakes: BrakesSchema,
  timeouts: TimeoutsSchema.optional(),
});
```

No change is needed in `parseProjectConfig`'s merge logic (`project-config.ts:66-72`): unlike `routing`/`brakes`/`stages` (which have real defaults in `DEFAULT_PROJECT_CONFIG` that a partial override must be merged against), `timeouts` has no default value at all — a project that doesn't set it gets `undefined`, exactly like `image`/`services`/`initCommands`/`escalation` today, and it passes through untouched via the existing `{ ...DEFAULT_PROJECT_CONFIG, ...rawConfig, ... }` spread.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @agentops/contracts test -- project-config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/project-config.ts packages/contracts/src/project-config.test.ts
git commit -m "feat(contracts): add optional per-stage timeouts to ProjectConfig"
```

---

### Task 3: `idleTimeoutMs` + default constants on `AgentRunLimitsSchema`

**Files:**
- Modify: `packages/contracts/src/agent-run.ts`
- Test: `packages/contracts/src/agent-run.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/contracts/src/agent-run.test.ts`, change the import on line 2:

```ts
import {
  AgentRunLimitsSchema,
  AgentRunRequestSchema,
  AgentRunResultSchema,
  BackendRunRequestSchema,
  DEFAULT_BACKSTOP_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
} from './agent-run';
```

Append at the end of the file:

```ts
describe('AgentRunLimitsSchema', () => {
  it('accepts limits without idleTimeoutMs — optional, only K8sJobRunner reads it', () => {
    expect(() => AgentRunLimitsSchema.parse({ maxTokens: 1000, timeoutMs: 60_000 })).not.toThrow();
  });

  it('accepts limits with an explicit idleTimeoutMs', () => {
    const parsed = AgentRunLimitsSchema.parse({ maxTokens: 1000, idleTimeoutMs: 300_000, timeoutMs: 1_800_000 });
    expect(parsed.idleTimeoutMs).toBe(300_000);
  });

  it('rejects a negative idleTimeoutMs', () => {
    expect(() => AgentRunLimitsSchema.parse({ maxTokens: 1000, idleTimeoutMs: -1, timeoutMs: 60_000 })).toThrow();
  });
});

describe('default timeout constants', () => {
  it('DEFAULT_IDLE_TIMEOUT_MS is 5 minutes', () => {
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(300_000);
  });

  it('DEFAULT_BACKSTOP_TIMEOUT_MS is 30 minutes', () => {
    expect(DEFAULT_BACKSTOP_TIMEOUT_MS).toBe(1_800_000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @agentops/contracts test -- agent-run.test.ts`
Expected: FAIL — `DEFAULT_BACKSTOP_TIMEOUT_MS`/`DEFAULT_IDLE_TIMEOUT_MS` are not exported from `./agent-run`.

- [ ] **Step 3: Implement**

In `packages/contracts/src/agent-run.ts`, replace:

```ts
export const AgentRunLimitsSchema = z.object({
  maxTokens: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
});
export type AgentRunLimits = z.infer<typeof AgentRunLimitsSchema>;
```

with:

```ts
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
export const DEFAULT_BACKSTOP_TIMEOUT_MS = 1_800_000;

export const AgentRunLimitsSchema = z.object({
  maxTokens: z.number().int().positive(),
  idleTimeoutMs: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive(),
});
export type AgentRunLimits = z.infer<typeof AgentRunLimitsSchema>;
```

`idleTimeoutMs` is deliberately optional rather than required: only `K8sJobRunner` reads it (Task 5), so backends that don't (`ProcessCliRunner`, `LiteLlmBackend`, `stub`) and their existing test fixtures across `packages/backends` need no changes at all.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @agentops/contracts test -- agent-run.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/agent-run.ts packages/contracts/src/agent-run.test.ts
git commit -m "feat(contracts): add optional idleTimeoutMs and default timeout constants"
```

---

### Task 4: `resolveStageLimits` policy function

**Files:**
- Create: `packages/policies/src/resolve-stage-limits.ts`
- Test: `packages/policies/src/resolve-stage-limits.test.ts`
- Modify: `packages/policies/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/policies/src/resolve-stage-limits.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseProjectConfig } from '@agentops/contracts';
import { resolveStageLimits } from './resolve-stage-limits';

describe('resolveStageLimits', () => {
  it('falls back to the global defaults when a stage has no override', () => {
    const config = parseProjectConfig({});
    expect(resolveStageLimits(config, 'context')).toEqual({ idleTimeoutMs: 300_000, timeoutMs: 1_800_000 });
  });

  it('uses a stage-specific idleTimeoutMs override, defaulting timeoutMs', () => {
    const config = parseProjectConfig({ timeouts: { context: { idleTimeoutMs: 600_000 } } });
    expect(resolveStageLimits(config, 'context')).toEqual({ idleTimeoutMs: 600_000, timeoutMs: 1_800_000 });
  });

  it('uses a stage-specific timeoutMs override, defaulting idleTimeoutMs', () => {
    const config = parseProjectConfig({ timeouts: { implement: { timeoutMs: 3_600_000 } } });
    expect(resolveStageLimits(config, 'implement')).toEqual({ idleTimeoutMs: 300_000, timeoutMs: 3_600_000 });
  });

  it('leaves stages without an override at the defaults, even when other stages are overridden', () => {
    const config = parseProjectConfig({ timeouts: { implement: { timeoutMs: 3_600_000 } } });
    expect(resolveStageLimits(config, 'review')).toEqual({ idleTimeoutMs: 300_000, timeoutMs: 1_800_000 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @agentops/policies test -- resolve-stage-limits.test.ts`
Expected: FAIL — cannot find module `./resolve-stage-limits`.

- [ ] **Step 3: Implement**

Create `packages/policies/src/resolve-stage-limits.ts`:

```ts
import type { ProjectConfig, Timeouts } from '@agentops/contracts';
import { DEFAULT_BACKSTOP_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS } from '@agentops/contracts';

export interface StageLimits {
  idleTimeoutMs: number;
  timeoutMs: number;
}

export function resolveStageLimits(config: ProjectConfig, stage: keyof Timeouts): StageLimits {
  const override = config.timeouts?.[stage];
  return {
    idleTimeoutMs: override?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    timeoutMs: override?.timeoutMs ?? DEFAULT_BACKSTOP_TIMEOUT_MS,
  };
}
```

Add to `packages/policies/src/index.ts`:

```ts
export * from './resolve-stage-limits';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @agentops/policies test -- resolve-stage-limits.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/policies/src/resolve-stage-limits.ts packages/policies/src/resolve-stage-limits.test.ts packages/policies/src/index.ts
git commit -m "feat(policies): add resolveStageLimits for per-stage idle/backstop resolution"
```

---

### Task 5: `K8sJobRunner` idle + backstop timeout logic

**Files:**
- Modify: `packages/backends/src/k8s/k8s-job-runner.ts`
- Test: `packages/backends/src/k8s/k8s-job-runner.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/backends/src/k8s/k8s-job-runner.test.ts`, update the two heartbeat assertions inside `'heartbeats with job-created/polling phase and the last-known Job status'` (the test currently asserts `heartbeats[0]`/`heartbeats[1]` — add the three new keys to both expected objects):

```ts
    expect(heartbeats[0]).toEqual({
      phase: 'job-created',
      jobName,
      taskId: 'task-1',
      stage: 'implement',
      elapsedMs: 0,
      idleMs: 0,
      timeoutMs: 30_000,
      outputBytes: 0,
      errorBytes: 0,
      jobStatus: undefined,
    });
    expect(heartbeats[1]).toEqual({
      phase: 'polling',
      jobName,
      taskId: 'task-1',
      stage: 'implement',
      elapsedMs: 0,
      idleMs: 0,
      timeoutMs: 30_000,
      outputBytes: 0,
      errorBytes: 0,
      jobStatus: { active: 1 },
    });
```

Then add two new tests inside `describe('K8sJobRunner', ...)`, right after the `'throws ProcessCliAuthError when stderr matches the auth pattern'` test (before the block's closing `});`):

```ts
  it('kills the Job and throws when output goes idle, even though the Job status stays active', async () => {
    const workspaceRef = await mkdtemp(path.join(os.tmpdir(), 'agentops-k8s-idle-'));
    const req = {
      ...baseRequest,
      workspaceRef,
      limits: { maxTokens: 1000, idleTimeoutMs: 100, timeoutMs: 100_000 },
    };
    const paths = agentOpsArtifactPaths(req);
    await mkdir(paths.dir, { recursive: true });

    const batchApi = new FakeBatchApi();
    let now = 1_000;
    const runner = new K8sJobRunner(createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }), {
      namespace: 'dev-agents',
      workspacePvcName: 'workspace-tasks',
      workspaceMountPath: '/workspace/tasks',
      batchApi,
      pollIntervalMs: 1,
      now: () => now,
      heartbeat: () => {},
    });

    const runPromise = runner.run(req);
    await vi.waitFor(() => expect(batchApi.creates).toHaveLength(1));
    batchApi.setJobStatus(k8sJobName(req), { active: 1, ready: 1 });

    // No output is ever written -- simulates a Job whose pod is healthy
    // but whose CLI process has genuinely gone silent.
    now += 150;

    await expect(runPromise).rejects.toThrow(/produced no output for 100ms/);
    expect(batchApi.deletes).toHaveLength(1);
  });

  it('kills the Job and throws when the overall backstop is exceeded despite ongoing output', async () => {
    const workspaceRef = await mkdtemp(path.join(os.tmpdir(), 'agentops-k8s-backstop-'));
    const req = {
      ...baseRequest,
      workspaceRef,
      // idleTimeoutMs set impossibly high so only the backstop check can fire.
      limits: { maxTokens: 1000, idleTimeoutMs: 1_000_000, timeoutMs: 100 },
    };
    const paths = agentOpsArtifactPaths(req);
    await mkdir(paths.dir, { recursive: true });

    const batchApi = new FakeBatchApi();
    let now = 1_000;
    const runner = new K8sJobRunner(createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }), {
      namespace: 'dev-agents',
      workspacePvcName: 'workspace-tasks',
      workspaceMountPath: '/workspace/tasks',
      batchApi,
      pollIntervalMs: 1,
      now: () => now,
      heartbeat: () => {},
    });

    const runPromise = runner.run(req);
    await vi.waitFor(() => expect(batchApi.creates).toHaveLength(1));
    await writeFile(paths.outFile, '{"type":"message_start"}\n', 'utf8');

    now += 150; // exceeds timeoutMs (100ms) even though output just grew

    await expect(runPromise).rejects.toThrow(/exceeded overall 100ms budget despite ongoing output/);
    expect(batchApi.deletes).toHaveLength(1);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @agentops/backends test -- k8s-job-runner.test.ts`
Expected: FAIL — the heartbeat assertions fail on missing keys (`toEqual` mismatch); the two new tests fail because `limits.idleTimeoutMs` isn't read yet and the old single-`timeoutMs` check produces a different error message (`"... timed out after 100ms"` / `"... timed out after 100000ms"`, not matching the new idle/backstop message patterns).

- [ ] **Step 3: Implement**

In `packages/backends/src/k8s/k8s-job-runner.ts`, add `stat` to the `node:fs/promises` import:

```ts
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
```

Add a helper function right after `withTimeout` (before the `SHELL_REDIRECT` constant):

```ts
async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}
```

Replace the top of the poll loop in `run()` — from `const start = this.now();` through the closing brace of the `if (this.now() - start > req.limits.timeoutMs) { ... }` block — with:

```ts
    const start = this.now();
    let lastStatus: V1Job['status'];
    let lastProgressAt = start;
    let lastOutputBytes = 0;
    let lastErrorBytes = 0;
    const idleTimeoutMs = req.limits.idleTimeoutMs ?? req.limits.timeoutMs;
    while (true) {
      const outputBytes = await fileSize(paths.outFile);
      const errorBytes = await fileSize(paths.errFile);
      if (outputBytes > lastOutputBytes || errorBytes > lastErrorBytes) {
        lastProgressAt = this.now();
      }
      lastOutputBytes = outputBytes;
      lastErrorBytes = errorBytes;

      try {
        this.heartbeat({
          phase: lastStatus ? 'polling' : 'job-created',
          jobName,
          taskId: req.taskId,
          stage: req.stage,
          elapsedMs: this.now() - start,
          idleMs: this.now() - lastProgressAt,
          timeoutMs: req.limits.timeoutMs,
          outputBytes,
          errorBytes,
          jobStatus: lastStatus,
        });
      } catch (err) {
        await this.opts.batchApi.deleteNamespacedJob(jobName, this.opts.namespace, {
          propagationPolicy: 'Background',
        });
        throw err;
      }

      if (this.now() - lastProgressAt > idleTimeoutMs) {
        await this.opts.batchApi.deleteNamespacedJob(jobName, this.opts.namespace, {
          propagationPolicy: 'Background',
        });
        throw new ProcessCliTimeoutError(
          `${this.spec.binary} produced no output for ${idleTimeoutMs}ms (idle since elapsed ${lastProgressAt - start}ms)`,
        );
      }

      if (this.now() - start > req.limits.timeoutMs) {
        await this.opts.batchApi.deleteNamespacedJob(jobName, this.opts.namespace, {
          propagationPolicy: 'Background',
        });
        throw new ProcessCliTimeoutError(
          `${this.spec.binary} exceeded overall ${req.limits.timeoutMs}ms budget despite ongoing output`,
        );
      }
```

Leave everything from `let statusJob: V1Job;` onward (the status read, success/failure handling, `sleep`) unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @agentops/backends test -- k8s-job-runner.test.ts`
Expected: PASS (all existing tests plus the 2 new ones)

- [ ] **Step 5: Commit**

```bash
git add packages/backends/src/k8s/k8s-job-runner.ts packages/backends/src/k8s/k8s-job-runner.test.ts
git commit -m "feat(backends): replace K8sJobRunner's fixed timeout with idle + backstop checks"
```

---

### Task 6: Live-stream Job output to container logs (FIFO + `tee`)

**Files:**
- Modify: `packages/backends/src/k8s/k8s-job-runner.ts`
- Test: `packages/backends/src/k8s/k8s-job-runner.test.ts`

- [ ] **Step 1: Write the failing tests**

Update the imports at the top of `packages/backends/src/k8s/k8s-job-runner.test.ts`:

```ts
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BackendRunRequest } from '@agentops/contracts';
import { createClaudeCliSpec } from '../claude/claude-backend';
import type { CliSpec } from '../cli-spec';
import { ProcessCliAuthError } from '../process-cli-runner';
import { FakeBatchApi } from './fake-batch-api';
import type { V1Job } from './k8s-types';
import {
  agentOpsArtifactPaths,
  buildAgentJob,
  K8sJobRunner,
  k8sJobName,
} from './k8s-job-runner';
```

Update the `'builds the expected Job shape with shell-safe positional args'` test's `command` assertion:

```ts
    expect(container?.command).toEqual([
      '/bin/sh',
      '-c',
      [
        'mkfifo /tmp/agentops-out /tmp/agentops-err',
        'tee "$OUT_FILE" < /tmp/agentops-out &',
        'tee "$ERR_FILE" < /tmp/agentops-err >&2 &',
        '"$0" "$@" < "$PROMPT_FILE" > /tmp/agentops-out 2> /tmp/agentops-err',
        'CODE=$?',
        'wait',
        'exit "$CODE"',
      ].join('\n'),
      'claude',
      '-p',
      '--output-format',
      'json',
      '--model',
      'claude-sonnet-5',
      '--dangerously-skip-permissions',
    ]);
```

Add a new test at the end of `describe('buildAgentJob', ...)` (right before its closing `});`):

```ts
  it('preserves the real CLI exit code and mirrors stdout/stderr into the artifact files via the FIFO/tee script', async () => {
    const workspaceRef = await mkdtemp(path.join(os.tmpdir(), 'agentops-shell-'));
    const req = { ...baseRequest, workspaceRef };
    const paths = agentOpsArtifactPaths(req);
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.promptFile, 'irrelevant', 'utf8');

    const fixturePath = path.join(workspaceRef, 'fake-cli.sh');
    await writeFile(fixturePath, '#!/bin/sh\necho "$1"\necho "$2" >&2\nexit "$3"\n', { mode: 0o755 });

    const fakeSpec: CliSpec = {
      image: 'ghcr.io/example/fake:abc',
      binary: fixturePath,
      buildArgs: () => ['stdout-line', 'stderr-line', '7'],
      parseOutput: () => {
        throw new Error('not used in this test');
      },
      isAuthError: () => false,
    };

    const job = buildAgentJob(
      req,
      fakeSpec,
      { namespace: 'dev-agents', workspacePvcName: 'workspace-tasks', workspaceMountPath: '/workspace/tasks' },
      paths,
    );
    const [command, ...args] = job.spec?.template?.spec?.containers?.[0].command ?? [];
    if (!command) throw new Error('buildAgentJob did not produce a container command');

    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(command, args, {
        env: { ...process.env, PROMPT_FILE: paths.promptFile, OUT_FILE: paths.outFile, ERR_FILE: paths.errFile },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        expect(stdout).toBe('stdout-line\n');
        expect(stderr).toBe('stderr-line\n');
        resolve(code ?? -1);
      });
    });

    expect(exitCode).toBe(7);
    expect(await readFile(paths.outFile, 'utf8')).toBe('stdout-line\n');
    expect(await readFile(paths.errFile, 'utf8')).toBe('stderr-line\n');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @agentops/backends test -- k8s-job-runner.test.ts`
Expected: FAIL — the command assertion doesn't match the still-plain `exec ... > "$OUT_FILE" 2> "$ERR_FILE"` string, and the new subprocess test either errors (no such file, since `SHELL_REDIRECT` doesn't yet call `tee`) or fails the content/exit-code assertions.

- [ ] **Step 3: Implement**

In `packages/backends/src/k8s/k8s-job-runner.ts`, replace:

```ts
const SHELL_REDIRECT =
  'exec "$0" "$@" < "$PROMPT_FILE" > "$OUT_FILE" 2> "$ERR_FILE"';
```

with:

```ts
// A plain `exec ... > OUT 2> ERR` sent the CLI's entire output only to
// files on the workspace PVC -- nothing reached the container's own
// stdout/stderr, so Alloy (which scrapes container logs, not PVC files)
// captured nothing for the `agent` container. This mirrors the same
// output to both: FIFOs decouple the CLI's write from `tee`'s dual
// write, and the CLI's exit code is captured explicitly in $CODE rather
// than relying on `set -o pipefail`, which dash (a common /bin/sh) does
// not support.
const SHELL_REDIRECT = [
  'mkfifo /tmp/agentops-out /tmp/agentops-err',
  'tee "$OUT_FILE" < /tmp/agentops-out &',
  'tee "$ERR_FILE" < /tmp/agentops-err >&2 &',
  '"$0" "$@" < "$PROMPT_FILE" > /tmp/agentops-out 2> /tmp/agentops-err',
  'CODE=$?',
  'wait',
  'exit "$CODE"',
].join('\n');
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @agentops/backends test -- k8s-job-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/backends/src/k8s/k8s-job-runner.ts packages/backends/src/k8s/k8s-job-runner.test.ts
git commit -m "feat(backends): stream Job CLI output live into container logs via FIFO+tee"
```

---

### Task 7: Wire `dev-cycle.ts` to per-stage resolved limits

**Files:**
- Modify: `packages/workflows/src/dev-cycle.ts`

- [ ] **Step 1: Update the activity proxy timeout**

In `packages/workflows/src/dev-cycle.ts`, change:

```ts
const agentActivities = proxyActivities<Pick<DevCycleActivities, 'runAgent'>>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '15s',
  retry: { maximumAttempts: 5 },
});
```

to:

```ts
const agentActivities = proxyActivities<Pick<DevCycleActivities, 'runAgent'>>({
  startToCloseTimeout: '35 minutes',
  heartbeatTimeout: '15s',
  retry: { maximumAttempts: 5 },
});
```

(5 minutes of headroom over the new 30-minute backstop default, so `K8sJobRunner`'s own delete-and-throw on backstop expiry always completes before Temporal's own `startToCloseTimeout` could force-fail the activity with a less informative error.)

- [ ] **Step 2: Wire `resolveStageLimits` into `runStageAgent`**

Change the import:

```ts
import { babysitDecision, nextRepairAction, parseVerdict, preImplementStages } from '@agentops/policies';
```

to:

```ts
import { babysitDecision, nextRepairAction, parseVerdict, preImplementStages, resolveStageLimits } from '@agentops/policies';
```

Change the `limits` line inside `runStageAgent`'s `agentActivities.runAgent({...})` call:

```ts
          limits: { maxTokens: input.config.brakes.maxTokens, timeoutMs: 600_000 },
```

to:

```ts
          limits: { maxTokens: input.config.brakes.maxTokens, ...resolveStageLimits(input.config, stage) },
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @agentops/workflows typecheck`
Expected: PASS (no test file exists for `dev-cycle.ts` directly — its behavior is covered by the e2e suite, run in Task 9)

- [ ] **Step 4: Commit**

```bash
git add packages/workflows/src/dev-cycle.ts
git commit -m "feat(workflows): resolve per-stage idle/backstop timeouts in devCycle"
```

---

### Task 8: Wire `platform.ts` to the same idle default

**Files:**
- Modify: `packages/workflows/src/platform.ts`

- [ ] **Step 1: Update the activity proxy timeout**

In `packages/workflows/src/platform.ts`, change:

```ts
const agentActivities = proxyActivities<Pick<PlatformActivities, 'runAgent'>>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '15s',
  retry: { maximumAttempts: 5 },
});
```

to:

```ts
const agentActivities = proxyActivities<Pick<PlatformActivities, 'runAgent'>>({
  startToCloseTimeout: '35 minutes',
  heartbeatTimeout: '15s',
  retry: { maximumAttempts: 5 },
});
```

(`platform.ts` already had `PLATFORM_TIMEOUT_MS` sitting at the same 30-minute value as this `startToCloseTimeout` — the exact collision named in the design doc, just never triggered in practice. Same fix as `dev-cycle.ts`.)

- [ ] **Step 2: Add the idle default and thread it into `limits`**

Change the import:

```ts
import { PlatformAgentResultSchema } from '@agentops/contracts';
```

to:

```ts
import { DEFAULT_IDLE_TIMEOUT_MS, PlatformAgentResultSchema } from '@agentops/contracts';
```

Add a constant alongside the existing ones:

```ts
const PLATFORM_MAX_TOKENS = 400_000;
const PLATFORM_TIMEOUT_MS = 1_800_000;
const PLATFORM_IDLE_TIMEOUT_MS = DEFAULT_IDLE_TIMEOUT_MS;
const MAX_RESULT_CALLS = 2;
```

Change the `limits` line inside the `agentActivities.runAgent({...})` call:

```ts
        limits: { maxTokens: PLATFORM_MAX_TOKENS, timeoutMs: PLATFORM_TIMEOUT_MS },
```

to:

```ts
        limits: { maxTokens: PLATFORM_MAX_TOKENS, idleTimeoutMs: PLATFORM_IDLE_TIMEOUT_MS, timeoutMs: PLATFORM_TIMEOUT_MS },
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @agentops/workflows typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/workflows/src/platform.ts
git commit -m "feat(workflows): give the platform agent role an idle timeout too"
```

---

### Task 9: Full repo verification

**Files:** none (verification only).

- [ ] **Step 1: Lint**

Run: `pnpm lint`
Expected: PASS

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Unit tests**

Run: `pnpm test`
Expected: PASS — every package's suite green, including the new/updated tests from Tasks 1–6.

- [ ] **Step 4: e2e suite**

Run: `pnpm e2e`
Expected: PASS. This change touches `workflows`, `policies`, `activities` (transitively, via `backends`), and `backends` — all four categories AGENTS.md's hard rule #6 requires the e2e suite for. The e2e suite uses the `stub` backend (per `docs/M0-SPEC.md`), which never calls `K8sJobRunner`, so it mainly proves `resolveStageLimits`'s wiring into `dev-cycle.ts` doesn't break workflow compilation/execution — it does not exercise the idle/backstop kill paths themselves (those are covered by Task 5's unit tests).

If anything fails here, fix it and re-run the specific failing command before moving on — do not proceed to Task 10 with red output.

- [ ] **Step 5: Commit (only if Steps 1–4 required fixes)**

If all four commands were already green with no changes needed, skip this step. Otherwise:

```bash
git add -A
git commit -m "fix: address lint/typecheck/test/e2e fallout from idle-timeout changes"
```

---

### Task 10: Open the PR, pass CI, and resolve the Bugbot review

**Files:** none (integration / review).

> Sequential and partly asynchronous — CI and Bugbot run on the remote PR.
> **HARD GATE: Do not mark this task complete until ALL Bugbot comments are
> resolved (fixed or replied to) AND CI is green. Check with
> `gh pr view --json reviews,comments` before claiming done.**
>
> Note: per this repo's own history, Bugbot has previously never responded on
> PRs here despite retriggers. Wait a reasonable time (e.g. 15–20 minutes) and
> retrigger once with a `bugbot run` comment; if it still never posts a
> review, treat CI-green as the completion bar instead of blocking
> indefinitely on a review that may never arrive.

- [ ] **Step 1: Sync the latest `main`**

```bash
git fetch origin
git merge origin/main
pnpm lint && pnpm typecheck && pnpm test && pnpm e2e   # resolve conflicts + commit first if any; fix fallout
```

- [ ] **Step 2: Push and open the PR**

```bash
git status --short && git rev-parse --abbrev-ref HEAD   # clean tree, on feature branch (not main)
git push -u origin HEAD
gh pr create --base main --fill --title "feat: idle-timeout + live log streaming for runAgent Jobs"
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

**After pushing:** return to Step 4 (re-watch CI), then Step 5 (wait for re-review). Loop until Bugbot reports no unresolved comments, or until it's clear (per the note above) that it isn't going to respond at all.

- [ ] **Step 7: Final verification**

```bash
gh pr checks                          # all green
gh pr view --json reviews,comments    # no comment left unaddressed
pnpm lint && pnpm typecheck && pnpm test && pnpm e2e   # suite green locally
```
Confirm no unresolved review threads remain, then mark this task complete.
