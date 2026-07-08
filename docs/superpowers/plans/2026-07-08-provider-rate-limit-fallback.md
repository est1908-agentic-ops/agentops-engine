# Provider Rate-Limit Fallback & Heartbeat Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the `pi` backend's model call gets provider-rate-limited (e.g. z.ai's 429 Fair Usage Policy), automatically retry once against a configured fallback model on the same backend, with a heartbeat + log line marking it — and separately, enrich `runAgent`'s heartbeats across every backend so a still-open Temporal workflow's Pending Activities view actually shows what's happening.

**Architecture:** A new `ProviderRateLimitedError` is thrown from `pi-backend.ts` when a turn's error message matches a rate-limit pattern (instead of the generic `ProcessCliProcessError` it throws today). A new `RateLimitFallbackBackend` decorator (structurally identical to the existing `RateWindowedBackend`) catches that error, heartbeats + logs, and retries once against an env-configured fallback model — wired into `main.ts` exactly like `wrapWithRateWindow`. Separately, `K8sJobRunner`, `LiteLlmBackend`, and `create-activities.ts::runAgent` each gain heartbeat calls with real payload (job status/elapsed time/identity fields) where today they either heartbeat with nothing or don't heartbeat at all. Everything lives in `packages/backends`/`packages/activities` — no workflow or contracts changes — so it applies uniformly to both `devCycle` and `platform` workflows.

**Tech Stack:** TypeScript, Vitest, `@temporalio/activity` (`Context.current().heartbeat()`), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-07-08-provider-rate-limit-fallback-design.md`

---

### Task 1: `ProviderRateLimitedError` + `isProviderRateLimitMessage` detection

**Files:**
- Create: `packages/backends/src/provider-rate-limit.ts`
- Test: `packages/backends/src/provider-rate-limit.test.ts`
- Modify: `packages/backends/src/index.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/backends/src/provider-rate-limit.test.ts
import { describe, expect, it } from 'vitest';
import { isProviderRateLimitMessage } from './provider-rate-limit';

describe('isProviderRateLimitMessage', () => {
  it('matches the real z.ai Fair Usage Policy 429 message', () => {
    expect(
      isProviderRateLimitMessage(
        "429 Your account's current usage pattern does not comply with the Fair Usage Policy, and your request frequency has been limited. For details, please refer to the Subscription Service Agreement. To restore access, please submit a request.",
      ),
    ).toBe(true);
  });

  it('matches a generic 429 that mentions rate limiting', () => {
    expect(isProviderRateLimitMessage('429 Too Many Requests: rate limit exceeded, retry later')).toBe(true);
  });

  it('does not match a 429 with no rate-limit wording', () => {
    expect(isProviderRateLimitMessage('429 payment required to continue using this model')).toBe(false);
  });

  it('does not match rate-limit wording with no 429', () => {
    expect(isProviderRateLimitMessage('the request frequency for this endpoint is limited')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- packages/backends/src/provider-rate-limit.test.ts`
Expected: FAIL — `Cannot find module './provider-rate-limit'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```typescript
// packages/backends/src/provider-rate-limit.ts
export class ProviderRateLimitedError extends Error {}

// Deliberately narrower than "contains 429" alone -- a bare 429 without one
// of these phrases stays a generic backend error, since not every 429 a CLI
// surfaces is this specific throttle-and-recover class of failure. See
// docs/superpowers/specs/2026-07-08-provider-rate-limit-fallback-design.md.
export function isProviderRateLimitMessage(message: string): boolean {
  return /\b429\b/.test(message) && /(fair usage policy|rate limit|request frequency)/i.test(message);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- packages/backends/src/provider-rate-limit.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Export from the package index**

In `packages/backends/src/index.ts`, add this line after `export * from './litellm/litellm-backend';`:

```typescript
export * from './provider-rate-limit';
```

- [ ] **Step 6: Run the full backends package test suite to check nothing broke**

Run: `pnpm test -- packages/backends`
Expected: PASS (all existing + 4 new tests)

- [ ] **Step 7: Commit**

```bash
git add packages/backends/src/provider-rate-limit.ts packages/backends/src/provider-rate-limit.test.ts packages/backends/src/index.ts
git commit -m "feat(backends): add provider rate-limit detection"
```

---

### Task 2: Wire detection into `pi-backend.ts`

**Files:**
- Modify: `packages/backends/src/pi/pi-backend.ts`
- Modify: `packages/backends/src/pi/pi-backend.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test to the `describe('PiBackend', ...)` block in `packages/backends/src/pi/pi-backend.test.ts` (place it after the `'aborted'` test, before the auth-error test):

```typescript
  it('throws ProviderRateLimitedError (not ProcessCliProcessError) when the error message matches a provider rate-limit pattern', async () => {
    const { child } = fakeChildProcess();
    const errorMessage =
      "429 Your account's current usage pattern does not comply with the Fair Usage Policy, and your request frequency has been limited.";
    const rateLimitedJsonl = JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage },
    });
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end(rateLimitedJsonl);
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ProcessCliRunner(createPiCliSpec(), { spawn: spawnFn as never });

    let error: unknown;
    try {
      await backend.run(baseRequest);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ProviderRateLimitedError);
    expect(error).not.toBeInstanceOf(ProcessCliProcessError);
  });
```

Add the import at the top of the file, alongside the existing `process-cli-runner` import:

```typescript
import { ProviderRateLimitedError } from '../provider-rate-limit';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- packages/backends/src/pi/pi-backend.test.ts`
Expected: FAIL — the thrown error is `ProcessCliProcessError`, not `ProviderRateLimitedError` (`expect(error).toBeInstanceOf(ProviderRateLimitedError)` fails).

- [ ] **Step 3: Write the implementation**

In `packages/backends/src/pi/pi-backend.ts`, add the import alongside the existing one:

```typescript
import { ProcessCliProcessError } from '../process-cli-runner';
import { isProviderRateLimitMessage, ProviderRateLimitedError } from '../provider-rate-limit';
```

Replace the `stopReason` check inside `parseOutput`:

```typescript
      if (lastAssistantMessage?.stopReason === 'error' || lastAssistantMessage?.stopReason === 'aborted') {
        throw new ProcessCliProcessError(
          lastAssistantMessage.errorMessage || `pi turn ended with stopReason "${lastAssistantMessage.stopReason}"`,
        );
      }
```

with:

```typescript
      if (lastAssistantMessage?.stopReason === 'error' || lastAssistantMessage?.stopReason === 'aborted') {
        const message =
          lastAssistantMessage.errorMessage || `pi turn ended with stopReason "${lastAssistantMessage.stopReason}"`;
        if (isProviderRateLimitMessage(message)) {
          throw new ProviderRateLimitedError(message);
        }
        throw new ProcessCliProcessError(message);
      }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- packages/backends/src/pi/pi-backend.test.ts`
Expected: PASS (all existing pi-backend tests + the new one)

- [ ] **Step 5: Commit**

```bash
git add packages/backends/src/pi/pi-backend.ts packages/backends/src/pi/pi-backend.test.ts
git commit -m "feat(backends): recognize provider rate-limit errors in pi-backend"
```

---

### Task 3: `RateLimitFallbackBackend` decorator

**Files:**
- Create: `packages/backends/src/rate-limit-fallback/rate-limit-fallback-backend.ts`
- Test: `packages/backends/src/rate-limit-fallback/rate-limit-fallback-backend.test.ts`
- Modify: `packages/backends/src/index.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/backends/src/rate-limit-fallback/rate-limit-fallback-backend.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { AgentRunResult, BackendRunRequest } from '@agentops/contracts';
import type { AgentBackend } from '../agent-backend';
import { ProviderRateLimitedError } from '../provider-rate-limit';
import { RateLimitFallbackBackend } from './rate-limit-fallback-backend';

const baseRequest: BackendRunRequest = {
  taskId: 't1',
  stage: 'implement',
  attempt: 1,
  callIndex: 1,
  backend: 'pi',
  model: 'zai/glm-5.2',
  workspaceRef: '/tmp/ws',
  limits: { maxTokens: 1000, timeoutMs: 5000 },
  prompt: 'do the thing',
};

const successResult: AgentRunResult = { output: 'ok', tokensIn: 1, tokensOut: 1, wallMs: 10 };

describe('RateLimitFallbackBackend', () => {
  it('delegates straight through on success, without heartbeating or touching the fallback', async () => {
    const run = vi.fn().mockResolvedValue(successResult);
    const inner: AgentBackend = { run };
    const heartbeat = vi.fn();
    const backend = new RateLimitFallbackBackend(inner, 'openrouter/deepseek-v4-pro', 'pi', heartbeat);

    const result = await backend.run(baseRequest);

    expect(result).toBe(successResult);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(baseRequest);
    expect(heartbeat).not.toHaveBeenCalled();
  });

  it('propagates a non-rate-limit error without touching the fallback', async () => {
    const boom = new Error('boom');
    const run = vi.fn().mockRejectedValue(boom);
    const inner: AgentBackend = { run };
    const heartbeat = vi.fn();
    const backend = new RateLimitFallbackBackend(inner, 'openrouter/deepseek-v4-pro', 'pi', heartbeat);

    await expect(backend.run(baseRequest)).rejects.toThrow(boom);
    expect(run).toHaveBeenCalledTimes(1);
    expect(heartbeat).not.toHaveBeenCalled();
  });

  it('heartbeats and retries once against the fallback model on ProviderRateLimitedError', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new ProviderRateLimitedError('429 Fair Usage Policy'))
      .mockResolvedValueOnce(successResult);
    const inner: AgentBackend = { run };
    const heartbeat = vi.fn();
    const backend = new RateLimitFallbackBackend(inner, 'openrouter/deepseek-v4-pro', 'pi', heartbeat);

    const result = await backend.run(baseRequest);

    expect(result).toBe(successResult);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenNthCalledWith(1, baseRequest);
    expect(run).toHaveBeenNthCalledWith(2, { ...baseRequest, model: 'openrouter/deepseek-v4-pro' });
    expect(heartbeat).toHaveBeenCalledWith({
      event: 'provider-rate-limited',
      backend: 'pi',
      taskId: 't1',
      stage: 'implement',
      primaryModel: 'zai/glm-5.2',
      fallbackModel: 'openrouter/deepseek-v4-pro',
      message: '429 Fair Usage Policy',
    });
  });

  it('propagates the fallback error when the fallback attempt also fails', async () => {
    const fallbackErr = new Error('fallback also failed');
    const run = vi
      .fn()
      .mockRejectedValueOnce(new ProviderRateLimitedError('429 Fair Usage Policy'))
      .mockRejectedValueOnce(fallbackErr);
    const inner: AgentBackend = { run };
    const backend = new RateLimitFallbackBackend(inner, 'openrouter/deepseek-v4-pro', 'pi', () => {});

    await expect(backend.run(baseRequest)).rejects.toThrow(fallbackErr);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- packages/backends/src/rate-limit-fallback/rate-limit-fallback-backend.test.ts`
Expected: FAIL — `Cannot find module './rate-limit-fallback-backend'`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/backends/src/rate-limit-fallback/rate-limit-fallback-backend.ts
import { Context } from '@temporalio/activity';
import type { AgentRunResult, BackendRunRequest } from '@agentops/contracts';
import type { AgentBackend } from '../agent-backend';
import { ProviderRateLimitedError } from '../provider-rate-limit';

// Wraps a subscription-lane backend (pi) to retry once against a known-good
// fallback model on the same backend when the provider itself throttles a
// call (ProviderRateLimitedError) -- distinct from RateWindowedBackend, which
// throws *before* ever calling the inner backend based on a locally-tracked
// quota. Only reacts to a real provider response, and only retries once: if
// the fallback also fails, the error propagates untouched into the same
// generic retry path every other backend error already takes in
// create-activities.ts (Temporal's own maximumAttempts + backoff on
// agentActivities), so there's no new bookkeeping for "how many times have
// we tried." See
// docs/superpowers/specs/2026-07-08-provider-rate-limit-fallback-design.md.
export class RateLimitFallbackBackend implements AgentBackend {
  constructor(
    private readonly inner: AgentBackend,
    private readonly fallbackModel: string,
    private readonly backendName: string,
    private readonly heartbeat: (details: unknown) => void = (details) => Context.current().heartbeat(details),
  ) {}

  async run(req: BackendRunRequest): Promise<AgentRunResult> {
    try {
      return await this.inner.run(req);
    } catch (err) {
      if (!(err instanceof ProviderRateLimitedError)) {
        throw err;
      }
      const details = {
        event: 'provider-rate-limited',
        backend: this.backendName,
        taskId: req.taskId,
        stage: req.stage,
        primaryModel: req.model,
        fallbackModel: this.fallbackModel,
        message: err.message,
      };
      this.heartbeat(details);
      // Heartbeat/pending-activity detail is ephemeral -- gone once the
      // workflow closes. This line survives in Loki via the existing stdout
      // pipeline, matching how every other worker log is captured today.
      console.warn(JSON.stringify(details));
      return this.inner.run({ ...req, model: this.fallbackModel });
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- packages/backends/src/rate-limit-fallback/rate-limit-fallback-backend.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Export from the package index**

In `packages/backends/src/index.ts`, add this line after `export * from './provider-rate-limit';`:

```typescript
export * from './rate-limit-fallback/rate-limit-fallback-backend';
```

- [ ] **Step 6: Run the full backends package test suite**

Run: `pnpm test -- packages/backends`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/backends/src/rate-limit-fallback packages/backends/src/index.ts
git commit -m "feat(backends): add RateLimitFallbackBackend"
```

---

### Task 4: Wire the fallback into `main.ts`

**Files:**
- Modify: `packages/worker/src/main.ts`

- [ ] **Step 1: Add the import**

In the `@agentops/backends` import block, add `RateLimitFallbackBackend`:

```typescript
import {
  batchApiFromClient,
  createClaudeCliSpec,
  createPiCliSpec,
  K8sJobRunner,
  LiteLlmBackend,
  ProcessCliRunner,
  RateLimitFallbackBackend,
  RateWindowedBackend,
  RateWindowLimiter,
  StubBackend,
  type AgentBackend,
  type BatchV1ApiLike,
  type K8sJobRunnerOptions,
} from '@agentops/backends';
```

- [ ] **Step 2: Add `wrapWithRateLimitFallback`**

Add this function immediately after `wrapWithRateWindow` (which ends just before `// In-cluster tasks fail two ways...`):

```typescript
// Reacts to a real provider-side rate limit (ProviderRateLimitedError),
// unlike wrapWithRateWindow's proactive local quota check -- see
// docs/superpowers/specs/2026-07-08-provider-rate-limit-fallback-design.md.
// Unset env var (the default) means no fallback, same "off by default"
// convention as the rate window.
function wrapWithRateLimitFallback(backend: AgentBackend, envPrefix: string, name: string): AgentBackend {
  const fallbackModel = process.env[`${envPrefix}_RATE_LIMIT_FALLBACK_MODEL`];
  if (!fallbackModel) {
    return backend;
  }
  return new RateLimitFallbackBackend(backend, fallbackModel, name);
}
```

- [ ] **Step 3: Apply it to `pi` and `platform` in the local (non-cluster) branch**

Replace:

```typescript
    return {
      stub: new StubBackend(),
      claude: wrapWithRateWindow(new ProcessCliRunner(claudeSpec), 'CLAUDE', 'claude'),
      pi: wrapWithRateWindow(new ProcessCliRunner(piSpec), 'PI', 'pi'),
      platform: wrapWithRateWindow(new ProcessCliRunner(piSpec), 'PI', 'platform'),
      litellm,
    };
```

with:

```typescript
    return {
      stub: new StubBackend(),
      claude: wrapWithRateWindow(new ProcessCliRunner(claudeSpec), 'CLAUDE', 'claude'),
      pi: wrapWithRateLimitFallback(wrapWithRateWindow(new ProcessCliRunner(piSpec), 'PI', 'pi'), 'PI', 'pi'),
      platform: wrapWithRateLimitFallback(
        wrapWithRateWindow(new ProcessCliRunner(piSpec), 'PI', 'platform'),
        'PI',
        'platform',
      ),
      litellm,
    };
```

- [ ] **Step 4: Apply it to `pi` and `platform` in the in-cluster branch**

Replace:

```typescript
    pi: wrapWithRateWindow(
      new K8sJobRunner(piSpec, buildJobRunnerOptions(batchApi, { authSecretName: process.env.PI_AUTH_SECRET_NAME })),
      'PI',
      'pi',
    ),
    platform: wrapWithRateWindow(
      new K8sJobRunner(
        piSpec,
        buildJobRunnerOptions(batchApi, {
          authSecretName: process.env.PI_AUTH_SECRET_NAME,
          serviceAccountName: process.env.PLATFORM_AGENT_SERVICE_ACCOUNT,
          additionalSecretNames: process.env.PLATFORM_AGENT_SECRET_NAME ? [process.env.PLATFORM_AGENT_SECRET_NAME] : undefined,
          podLabels: { 'agentops/role': 'platform-agent' },
        }),
      ),
      'PI',
      'platform',
    ),
```

with:

```typescript
    pi: wrapWithRateLimitFallback(
      wrapWithRateWindow(
        new K8sJobRunner(piSpec, buildJobRunnerOptions(batchApi, { authSecretName: process.env.PI_AUTH_SECRET_NAME })),
        'PI',
        'pi',
      ),
      'PI',
      'pi',
    ),
    platform: wrapWithRateLimitFallback(
      wrapWithRateWindow(
        new K8sJobRunner(
          piSpec,
          buildJobRunnerOptions(batchApi, {
            authSecretName: process.env.PI_AUTH_SECRET_NAME,
            serviceAccountName: process.env.PLATFORM_AGENT_SERVICE_ACCOUNT,
            additionalSecretNames: process.env.PLATFORM_AGENT_SECRET_NAME ? [process.env.PLATFORM_AGENT_SECRET_NAME] : undefined,
            podLabels: { 'agentops/role': 'platform-agent' },
          }),
        ),
        'PI',
        'platform',
      ),
      'PI',
      'platform',
    ),
```

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @agentops/worker run typecheck`
Expected: PASS, no type errors.

Note: `wrapWithRateWindow`/`wrapWithRateLimitFallback` are not unit-tested directly at the `main.ts` level — consistent with the existing codebase convention (there is no test for `wrapWithRateWindow` either; `main.test.ts` only covers `assertLiveBackendConfig`, `buildActivityDependencies`, and `resolveWorkspacesDir`). Correctness here is covered by Task 3's `RateLimitFallbackBackend` unit tests plus this typecheck.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/main.ts
git commit -m "feat(worker): wire RateLimitFallbackBackend into pi/platform backends"
```

---

### Task 5: Heartbeat enrichment in `K8sJobRunner`

**Files:**
- Modify: `packages/backends/src/k8s/k8s-job-runner.ts`
- Modify: `packages/backends/src/k8s/k8s-job-runner.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test to the `describe('K8sJobRunner', ...)` block in `packages/backends/src/k8s/k8s-job-runner.test.ts`, after the first test (`'writes the prompt, creates a Job, polls to success...'`):

```typescript
  it('heartbeats with job-created/polling phase and the last-known Job status', async () => {
    const workspaceRef = await mkdtemp(path.join(os.tmpdir(), 'agentops-k8s-heartbeat-'));
    const req = { ...baseRequest, workspaceRef };
    const paths = agentOpsArtifactPaths(req);
    await mkdir(paths.dir, { recursive: true });

    const batchApi = new FakeBatchApi();
    const heartbeats: unknown[] = [];
    const now = 1_000;
    const runner = new K8sJobRunner(createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }), {
      namespace: 'dev-agents',
      workspacePvcName: 'workspace-tasks',
      workspaceMountPath: '/workspace/tasks',
      batchApi,
      pollIntervalMs: 1,
      now: () => now,
      heartbeat: (details) => heartbeats.push(details),
    });

    const runPromise = runner.run(req);
    const jobName = k8sJobName(req);

    await vi.waitFor(() => expect(heartbeats.length).toBeGreaterThanOrEqual(2));
    expect(heartbeats[0]).toEqual({
      phase: 'job-created',
      jobName,
      taskId: 'task-1',
      stage: 'implement',
      elapsedMs: 0,
      timeoutMs: 30_000,
      jobStatus: undefined,
    });
    expect(heartbeats[1]).toEqual({
      phase: 'polling',
      jobName,
      taskId: 'task-1',
      stage: 'implement',
      elapsedMs: 0,
      timeoutMs: 30_000,
      jobStatus: { active: 1 },
    });

    await writeFile(
      paths.outFile,
      JSON.stringify({
        is_error: false,
        result: 'done',
        usage: { input_tokens: 3, output_tokens: 4 },
        duration_ms: 50,
      }),
      'utf8',
    );
    batchApi.setJobStatus(jobName, { succeeded: 1 });

    await expect(runPromise).resolves.toEqual({
      output: 'done',
      tokensIn: 3,
      tokensOut: 4,
      wallMs: 50,
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- packages/backends/src/k8s/k8s-job-runner.test.ts`
Expected: FAIL — `heartbeats[0]` is `undefined` (the current implementation calls `this.heartbeat()` with no arguments, so `heartbeats` would contain `undefined` entries, not objects with a `phase` field).

- [ ] **Step 3: Write the implementation**

In `packages/backends/src/k8s/k8s-job-runner.ts`, change the options interface:

```typescript
  heartbeat?: (details: unknown) => void;
```

Change the constructor and field:

```typescript
export class K8sJobRunner implements AgentBackend {
  private readonly pollIntervalMs: number;
  private readonly heartbeat: (details: unknown) => void;
  private readonly now: () => number;

  constructor(
    private readonly spec: CliSpec,
    private readonly opts: K8sJobRunnerOptions,
  ) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 3000;
    this.heartbeat = opts.heartbeat ?? ((details) => Context.current().heartbeat(details));
    this.now = opts.now ?? Date.now;
  }
```

Replace the whole `run()` poll loop:

```typescript
  async run(req: BackendRunRequest): Promise<AgentRunResult> {
    const paths = agentOpsArtifactPaths(req);
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.promptFile, req.prompt, 'utf8');

    const job = buildAgentJob(req, this.spec, this.opts, paths);
    const jobName = job.metadata!.name!;
    try {
      await this.opts.batchApi.createNamespacedJob(this.opts.namespace, job);
    } catch (err) {
      // The Job name is deterministic from (taskId, stage, attempt, callIndex), so a Temporal-level
      // retry of this same activity call reissues the exact same create. If an earlier retry's create
      // already succeeded but this runner never got to see it finish (e.g. the status poll below
      // failed), the Job is still there under that name -- reuse it instead of erroring forever.
      // Assumes buildAgentJob(req, ...) would still produce the same spec now (bounded retry backoff
      // is on the order of seconds, far under a deploy cycle) -- Jobs are immutable once created, so
      // there is nothing to reconcile if that assumption is ever wrong.
      if (!(err instanceof ApiException) || err.code !== 409) {
        throw err;
      }
    }

    const start = this.now();
    let lastStatus: V1Job['status'];
    while (true) {
      try {
        this.heartbeat({
          phase: lastStatus ? 'polling' : 'job-created',
          jobName,
          taskId: req.taskId,
          stage: req.stage,
          elapsedMs: this.now() - start,
          timeoutMs: req.limits.timeoutMs,
          jobStatus: lastStatus,
        });
      } catch (err) {
        await this.opts.batchApi.deleteNamespacedJob(jobName, this.opts.namespace, {
          propagationPolicy: 'Background',
        });
        throw err;
      }

      if (this.now() - start > req.limits.timeoutMs) {
        await this.opts.batchApi.deleteNamespacedJob(jobName, this.opts.namespace, {
          propagationPolicy: 'Background',
        });
        throw new ProcessCliTimeoutError(`${this.spec.binary} timed out after ${req.limits.timeoutMs}ms`);
      }

      const { body: statusJob } = await this.opts.batchApi.readNamespacedJobStatus(
        jobName,
        this.opts.namespace,
      );
      lastStatus = statusJob.status;

      if (lastStatus?.succeeded === 1 || lastStatus?.failed === 1) {
        const elapsedMs = this.now() - start;
        const stdout = await readFile(paths.outFile, 'utf8').catch(() => '');
        const stderr = await readFile(paths.errFile, 'utf8').catch(() => '');

        if (this.spec.isAuthError(stderr)) {
          throw new ProcessCliAuthError(stderr.trim());
        }
        if (stdout.trim().length === 0 && lastStatus.failed === 1) {
          throw new ProcessCliProcessError(
            `${this.spec.binary} job failed with no output: ${stderr.trim()}`,
          );
        }
        return this.spec.parseOutput(stdout, stderr, elapsedMs);
      }

      await sleep(this.pollIntervalMs);
    }
  }
```

(`V1Job` is already imported at the top of this file via `import type { V1InitContainer, V1Job, V1ReadinessProbe } from './k8s-types';` — no import change needed.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- packages/backends/src/k8s/k8s-job-runner.test.ts`
Expected: PASS (all existing K8sJobRunner tests + the new one)

- [ ] **Step 5: Run the full backends package test suite**

Run: `pnpm test -- packages/backends`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/backends/src/k8s/k8s-job-runner.ts packages/backends/src/k8s/k8s-job-runner.test.ts
git commit -m "feat(backends): enrich K8sJobRunner heartbeats with job status detail"
```

---

### Task 6: Heartbeat enrichment in `LiteLlmBackend`

**Files:**
- Modify: `packages/backends/src/litellm/litellm-backend.ts`
- Modify: `packages/backends/src/litellm/litellm-backend.test.ts`

- [ ] **Step 1: Write the failing test**

Replace the entire contents of `packages/backends/src/litellm/litellm-backend.test.ts` with:

```typescript
import { describe, expect, it, vi } from 'vitest';
import type { BackendRunRequest } from '@agentops/contracts';
import { LiteLlmBackend, LiteLlmBudgetExceededError, LiteLlmRequestError, type LiteLlmBackendOptions } from './litellm-backend';

const baseRequest: BackendRunRequest = {
  taskId: 't1',
  stage: 'context',
  attempt: 1,
  callIndex: 1,
  backend: 'litellm',
  model: 'zai-glm-4.6',
  workspaceRef: '/tmp/ws',
  limits: { maxTokens: 1000, timeoutMs: 5000 },
  prompt: 'summarize the issue',
};

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function makeBackend(opts: Partial<LiteLlmBackendOptions>): LiteLlmBackend {
  return new LiteLlmBackend({
    baseUrl: 'http://litellm.platform.svc.cluster.local:4000',
    apiKey: 'sk-virtual-key',
    heartbeat: () => {},
    ...opts,
  });
}

describe('LiteLlmBackend', () => {
  it('posts an OpenAI-compatible chat completion request with the virtual key as bearer auth', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return fakeResponse(200, {
        choices: [{ message: { content: 'the issue is about X' } }],
        usage: { prompt_tokens: 42, completion_tokens: 7 },
      });
    });
    const backend = makeBackend({ fetchFn: fetchFn as unknown as typeof fetch });

    const result = await backend.run(baseRequest);

    expect(calls[0].url).toBe('http://litellm.platform.svc.cluster.local:4000/chat/completions');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer sk-virtual-key');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      model: 'zai-glm-4.6',
      messages: [{ role: 'user', content: 'summarize the issue' }],
    });
    expect(result).toEqual({ output: 'the issue is about X', tokensIn: 42, tokensOut: 7, wallMs: expect.any(Number) });
  });

  it('heartbeats once before making the request', async () => {
    const fetchFn = vi.fn(async () =>
      fakeResponse(200, {
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    const heartbeat = vi.fn();
    const backend = makeBackend({ fetchFn: fetchFn as unknown as typeof fetch, heartbeat });

    await backend.run(baseRequest);

    expect(heartbeat).toHaveBeenCalledWith({
      phase: 'started',
      taskId: 't1',
      stage: 'context',
      backend: 'litellm',
      model: 'zai-glm-4.6',
    });
  });

  it('throws LiteLlmBudgetExceededError on a 429 whose body identifies BudgetExceededError', async () => {
    const fetchFn = vi.fn(async () =>
      fakeResponse(429, { error: { message: 'Budget has been exceeded! Current cost: 1.20, Max budget: 1.00', error_class: 'BudgetExceededError' } }),
    );
    const backend = makeBackend({ fetchFn: fetchFn as unknown as typeof fetch });

    await expect(backend.run(baseRequest)).rejects.toThrow(LiteLlmBudgetExceededError);
  });

  it('throws the generic LiteLlmRequestError (not budget-exceeded) on a plain 429 rate limit', async () => {
    const fetchFn = vi.fn(async () => fakeResponse(429, { error: { message: 'rate limit exceeded, try again later' } }));
    const backend = makeBackend({ fetchFn: fetchFn as unknown as typeof fetch });

    await expect(backend.run(baseRequest)).rejects.toThrow(LiteLlmRequestError);
    await expect(backend.run(baseRequest)).rejects.not.toThrow(LiteLlmBudgetExceededError);
  });

  it('throws LiteLlmRequestError on a non-429 error status', async () => {
    const fetchFn = vi.fn(async () => fakeResponse(500, { error: { message: 'internal error' } }));
    const backend = makeBackend({ fetchFn: fetchFn as unknown as typeof fetch });

    await expect(backend.run(baseRequest)).rejects.toThrow(LiteLlmRequestError);
  });

  it('throws LiteLlmRequestError when the network request itself fails', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const backend = makeBackend({ fetchFn: fetchFn as unknown as typeof fetch });

    await expect(backend.run(baseRequest)).rejects.toThrow(LiteLlmRequestError);
  });

  it('throws LiteLlmRequestError when the response body has no choices[0].message.content', async () => {
    const fetchFn = vi.fn(async () => fakeResponse(200, { choices: [] }));
    const backend = makeBackend({ fetchFn: fetchFn as unknown as typeof fetch });

    await expect(backend.run(baseRequest)).rejects.toThrow(LiteLlmRequestError);
  });

  it('aborts and throws LiteLlmRequestError when the request exceeds limits.timeoutMs', async () => {
    const fetchFn = vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const backend = makeBackend({ fetchFn: fetchFn as unknown as typeof fetch });

    await expect(backend.run({ ...baseRequest, limits: { maxTokens: 1000, timeoutMs: 10 } })).rejects.toThrow(
      LiteLlmRequestError,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- packages/backends/src/litellm/litellm-backend.test.ts`
Expected: FAIL — `LiteLlmBackendOptions` has no `heartbeat` field yet (type error), and the `'heartbeats once before making the request'` test fails since `heartbeat` is never called.

- [ ] **Step 3: Write the implementation**

In `packages/backends/src/litellm/litellm-backend.ts`, add the import at the top:

```typescript
import { Context } from '@temporalio/activity';
```

Add `heartbeat` to the options interface:

```typescript
export interface LiteLlmBackendOptions {
  baseUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
  heartbeat?: (details: unknown) => void;
}
```

Update the class:

```typescript
export class LiteLlmBackend implements AgentBackend {
  private readonly fetchFn: typeof fetch;
  private readonly heartbeat: (details: unknown) => void;

  constructor(private readonly opts: LiteLlmBackendOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.heartbeat = opts.heartbeat ?? ((details) => Context.current().heartbeat(details));
  }

  async run(req: BackendRunRequest): Promise<AgentRunResult> {
    this.heartbeat({ phase: 'started', taskId: req.taskId, stage: req.stage, backend: req.backend, model: req.model });
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.limits.timeoutMs);
```

(The rest of `run()` is unchanged — only the two lines above are inserted at the top of the method, before `const start = Date.now();`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- packages/backends/src/litellm/litellm-backend.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Run the full backends package test suite**

Run: `pnpm test -- packages/backends`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/backends/src/litellm/litellm-backend.ts packages/backends/src/litellm/litellm-backend.test.ts
git commit -m "feat(backends): heartbeat once before dispatching a LiteLLM request"
```

---

### Task 7: Heartbeat enrichment in `create-activities.ts::runAgent`

**Files:**
- Modify: `packages/activities/package.json`
- Modify: `packages/activities/src/create-activities.ts`
- Modify: `packages/activities/src/create-activities.test.ts`

- [ ] **Step 1: Add the `@temporalio/activity` dependency**

In `packages/activities/package.json`, add it next to the existing `@temporalio/common` line:

```json
    "@temporalio/common": "^1.11.0",
    "@temporalio/activity": "^1.11.0",
```

Run: `pnpm install`
Expected: lockfile updates, no errors.

- [ ] **Step 2: Write the failing test**

In `packages/activities/src/create-activities.test.ts`, update `buildDeps()` to inject a no-op heartbeat by default (otherwise every existing test in this file will start throwing `Context not initialized`, since these tests call `runAgent` directly, not inside a real Temporal activity):

```typescript
function buildDeps() {
  return {
    backends: { stub: new StubBackend() } as Record<string, AgentBackend>,
    tracker: new MemoryTrackerPort(),
    scm: new MemoryScmPort(),
    stats: new InMemoryStatsStore(),
    stageResults: new InMemoryStageResultStore(),
    workspaces: new MemoryWorkspaceManager() as Workspaces,
    prompts: new PromptPack(),
    registry: [] as ResolvedProjectEntry[],
    heartbeat: () => {},
  };
}
```

Add this test to the `describe('createActivities', ...)` block, right after the `'runAgent delegates to the named backend'` test:

```typescript
  it('runAgent heartbeats once before dispatching to the backend', async () => {
    const heartbeats: unknown[] = [];
    const deps = { ...buildDeps(), heartbeat: (details: unknown) => heartbeats.push(details) };
    (deps.backends.stub as StubBackend).scriptResponse('implement', 1, { output: 'diff' });
    const activities = createActivities(deps);

    await activities.runAgent({
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

    expect(heartbeats).toEqual([
      { phase: 'started', taskId: 't1', stage: 'implement', attempt: 1, callIndex: 1, backend: 'stub', model: 'stub-v1' },
    ]);
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test -- packages/activities/src/create-activities.test.ts`
Expected: FAIL — `ActivityDependencies` has no `heartbeat` field yet (type error on `buildDeps()`'s return value / the new test's `deps` object).

- [ ] **Step 4: Write the implementation**

In `packages/activities/src/create-activities.ts`, add the import:

```typescript
import { Context } from '@temporalio/activity';
```

Add `heartbeat` to the dependencies interface:

```typescript
export interface ActivityDependencies {
  backends: Record<string, AgentBackend>;
  tracker: TrackerPort;
  scm: ScmPort;
  stats: StatsStore;
  stageResults: StageResultStore;
  workspaces: Workspaces;
  prompts: PromptPack;
  registry: ResolvedProjectEntry[];
  heartbeat?: (details: unknown) => void;
}
```

Update `createActivities` to resolve the heartbeat function once, and call it before dispatching in `runAgent`:

```typescript
export function createActivities(deps: ActivityDependencies) {
  const heartbeat = deps.heartbeat ?? ((details: unknown) => Context.current().heartbeat(details));
  return {
    async runAgent(req: AgentRunRequest): Promise<AgentRunResult> {
      const backend = deps.backends[req.backend];
      if (!backend) {
        throw new Error(`createActivities.runAgent: unknown backend "${req.backend}"`);
      }
      const prompt = deps.prompts.render(req.promptRef, req.promptContext);
      heartbeat({
        phase: 'started',
        taskId: req.taskId,
        stage: req.stage,
        attempt: req.attempt,
        callIndex: req.callIndex,
        backend: req.backend,
        model: req.model,
      });
      try {
        const result = await backend.run({
```

(Everything below `const result = await backend.run({` is unchanged. Only the `heartbeat` line is inserted between the `prompt` assignment and the existing `try {`.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test -- packages/activities/src/create-activities.test.ts`
Expected: PASS (all existing tests + the new one)

- [ ] **Step 6: Run the full test suite**

Run: `pnpm test`
Expected: PASS across every package.

- [ ] **Step 7: Typecheck everything**

Run: `pnpm typecheck`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add packages/activities/package.json pnpm-lock.yaml packages/activities/src/create-activities.ts packages/activities/src/create-activities.test.ts
git commit -m "feat(activities): heartbeat once before runAgent dispatches to a backend"
```

---

### Task 8: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Lint**

Run: `pnpm lint`
Expected: PASS, no errors.

- [ ] **Step 2: Full typecheck**

Run: `pnpm typecheck`
Expected: PASS across every package.

- [ ] **Step 3: Full test suite**

Run: `pnpm test`
Expected: PASS — every existing test plus the ~15 new ones added across Tasks 1-3, 5-7.

- [ ] **Step 4: e2e suite**

Run: `pnpm e2e`
Expected: PASS, unchanged (this plan adds no new e2e scenario — nothing here changes workflow-visible behavior, per the design doc's non-goals).

- [ ] **Step 5: Commit** (only if any of the above required fixes)

```bash
git add -A
git commit -m "fix: address lint/typecheck/test fallout"
```

If everything already passed with no fixes needed, skip this step — there's nothing to commit.

---

### Task 9: Open the PR, pass CI, and resolve the Bugbot review

**Files:** none (integration / review).

> Sequential and partly asynchronous — CI and Bugbot run on the remote PR.
> **HARD GATE: Do not mark this task complete until ALL Bugbot comments are
> resolved (fixed or replied to) AND CI is green. Check with
> `gh pr view --json reviews,comments` before claiming done.**

- [ ] **Step 1: Sync the latest `main`**

```bash
git fetch origin
git merge origin/main
pnpm test   # resolve conflicts + commit first if any; fix fallout
```

- [ ] **Step 2: Push and open the PR**

```bash
git status --short && git rev-parse --abbrev-ref HEAD   # clean tree, on feature branch (not main)
git push -u origin HEAD
gh pr create --base main --fill --title "feat: provider rate-limit fallback and heartbeat observability"
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
gh pr checks                          # all green
gh pr view --json reviews,comments    # no comment left unaddressed
pnpm test                             # suite green locally
```
Confirm no unresolved review threads remain, then mark this task complete.
