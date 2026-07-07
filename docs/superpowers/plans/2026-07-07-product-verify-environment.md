# Product-Declared Verify Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a product declare, in its own `agentops.json`, the container image and sidecar services every one of its stage Jobs runs in — so a product needing a different Node/toolchain (e.g. pnpm) and live service dependencies (e.g. Postgres, Redis) for its verify commands can get them without any engine code change.

**Architecture:** Two new optional `ProductConfig` fields (`image`, `services`) flow unchanged from `agentops.json` → `TaskInput.config` → every `runStageAgent` call in the `devCycle` workflow → the `runAgent` activity → `K8sJobRunner.buildAgentJob`, which uses `image` to override the container image and renders `services` as native Kubernetes sidecar containers (init containers with `restartPolicy: 'Always'`, GA since K8s 1.29) in the same pod. Both fields are optional and additive — every existing product config continues to produce byte-identical Jobs.

**Tech Stack:** TypeScript, zod (contracts), Temporal TypeScript SDK (workflows/activities), vitest (unit + e2e tests), Kubernetes Job API (`packages/backends/src/k8s`).

**Design doc:** [docs/superpowers/specs/2026-07-07-product-verify-environment-design.md](../specs/2026-07-07-product-verify-environment-design.md)

---

### Task 1: Confirm the cluster supports native sidecar containers (manual, blocking)

**Files:** none — this is a live-cluster check, not a code change.

Native Kubernetes sidecars (`initContainers` with `restartPolicy: 'Always'`, which Task 6 depends on) require Kubernetes ≥1.29. `agentops-platform/bootstrap/bootstrap.sh` installs k3s via `curl -sfL https://get.k3s.io | sh -` with no version pin, so the real cluster's version can't be inferred from the repo — it must be checked live.

- [x] **Step 1: Check the live cluster's Kubernetes version**

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml   # run on the cluster host, or via your kubeconfig
kubectl version -o json | grep -A3 serverVersion
```

Expected: a `serverVersion.minor` of `"29"` or higher (k3s versions track upstream Kubernetes minor versions, e.g. k3s `v1.31.x` → Kubernetes 1.31).

**Confirmed 2026-07-07:** `kubectl version` on the real cluster reports `Server Version: v1.36.2+k3s1` — Kubernetes 1.36, well past the 1.29 requirement.

- [x] **Step 2: Branch on the result**

If `serverVersion.minor >= 29`: proceed to Task 2 — the rest of this plan applies as written. **This is the confirmed case — cleared to proceed.**

If `serverVersion.minor < 29`: **stop**. Task 6's approach (native sidecars) doesn't work on this cluster — sidecars would need to be plain extra containers, which never exit, causing the Job to hang waiting for them to complete alongside the `agent` container. Revisit the design doc's §3 "K8sJobRunner rendering" section before writing any code; this is a design-level blocker, not a task-level one.

---

### Task 2: Add `VerifyServiceSchema` and `image`/`services` fields to `ProductConfigSchema`

**Files:**
- Modify: `packages/contracts/src/product-config.ts`
- Test: `packages/contracts/src/product-config.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/contracts/src/product-config.test.ts`, inside the existing `describe('ProductConfigSchema', ...)` block (after the last `it`):

```ts
  it('accepts an optional image and services array', () => {
    const parsed = ProductConfigSchema.parse({
      ...validConfig,
      image: 'ghcr.io/example/agentops:latest',
      services: [
        {
          name: 'postgres',
          image: 'pgvector/pgvector:pg18',
          env: { POSTGRES_USER: 'app' },
          readiness: { type: 'exec', command: ['pg_isready', '-U', 'app'] },
        },
        { name: 'redis', image: 'redis:7-alpine', readiness: { type: 'tcpSocket', port: 6379 } },
      ],
    });
    expect(parsed.image).toBe('ghcr.io/example/agentops:latest');
    expect(parsed.services).toHaveLength(2);
    expect(parsed.services?.[1]).toEqual({
      name: 'redis',
      image: 'redis:7-alpine',
      readiness: { type: 'tcpSocket', port: 6379 },
    });
  });

  it('rejects a service missing a readiness check', () => {
    expect(() =>
      ProductConfigSchema.parse({
        ...validConfig,
        services: [{ name: 'postgres', image: 'pgvector/pgvector:pg18' }],
      }),
    ).toThrow();
  });
```

Add to the existing `describe('parseProductConfig', ...)` block (after the last `it`):

```ts
  it('leaves image and services undefined when not configured, and passes them through untouched when supplied', () => {
    const empty = parseProductConfig({});
    expect(empty.image).toBeUndefined();
    expect(empty.services).toBeUndefined();

    const configured = parseProductConfig({
      image: 'ghcr.io/example/agentops:latest',
      services: [{ name: 'redis', image: 'redis:7-alpine', readiness: { type: 'tcpSocket', port: 6379 } }],
    });
    expect(configured.image).toBe('ghcr.io/example/agentops:latest');
    expect(configured.services).toEqual([
      { name: 'redis', image: 'redis:7-alpine', readiness: { type: 'tcpSocket', port: 6379 } },
    ]);
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
pnpm test -- product-config
```

(This repo runs all packages' tests through one root vitest config — `pnpm test -- <pattern>` filters to test files whose path contains `<pattern>`; there is no per-package `test` script.)

Expected: FAIL — `parsed.image`/`parsed.services` are `undefined` (zod strips unrecognized keys by default), and the "rejects a service missing a readiness check" test fails because there's no `services` field to reject anything with yet (the whole object still parses since the unknown `services` key is silently stripped).

- [ ] **Step 3: Implement the schema addition**

Replace the top of `packages/contracts/src/product-config.ts` (everything up to and including `export type ProductConfig = z.infer<typeof ProductConfigSchema>;`) with:

```ts
import { z, ZodError } from 'zod';
import { ModelRefSchema, BrakesSchema, RoutingSchema, StageToggleSchema } from './model';

export const VerifyServiceReadinessSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('exec'), command: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('tcpSocket'), port: z.number().int().positive() }),
]);
export type VerifyServiceReadiness = z.infer<typeof VerifyServiceReadinessSchema>;

export const VerifyServiceSchema = z.object({
  name: z.string().min(1),
  image: z.string().min(1),
  env: z.record(z.string(), z.string()).optional(),
  readiness: VerifyServiceReadinessSchema,
});
export type VerifyService = z.infer<typeof VerifyServiceSchema>;

export const ProductConfigSchema = z.object({
  image: z.string().min(1).optional(),
  services: z.array(VerifyServiceSchema).optional(),
  fastVerifyCommands: z.array(z.string()).optional(),
  fullVerifyCommands: z.array(z.string()).optional(),
  stages: StageToggleSchema,
  routing: RoutingSchema,
  escalation: ModelRefSchema.optional(),
  brakes: BrakesSchema,
});
export type ProductConfig = z.infer<typeof ProductConfigSchema>;
```

Then update the `DEFAULT_PRODUCT_CONFIG` type annotation (the `Omit<...>` list) to also exclude the two new fields, since neither has a sensible default to merge in:

```ts
export const DEFAULT_PRODUCT_CONFIG: Omit<
  ProductConfig,
  'fastVerifyCommands' | 'fullVerifyCommands' | 'image' | 'services'
> = {
```

(Leave the rest of `DEFAULT_PRODUCT_CONFIG`'s body, `InvalidProductConfigError`, `formatZodError`, and `parseProductConfig` exactly as they are — `parseProductConfig`'s existing `{ ...DEFAULT_PRODUCT_CONFIG, ...rawConfig, ... }` spread already passes `image`/`services` through untouched from `rawConfig`, since neither needs deep-merging.)

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
pnpm test -- product-config
```

Expected: PASS, all tests including the three new ones.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/product-config.ts packages/contracts/src/product-config.test.ts
git commit -m "feat(contracts): add image and services fields to ProductConfig"
```

---

### Task 3: Add `image`/`services` to `AgentRunRequestSchema`/`BackendRunRequestSchema`

**Files:**
- Modify: `packages/contracts/src/agent-run.ts`
- Test: `packages/contracts/src/agent-run.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/contracts/src/agent-run.test.ts`, inside `describe('AgentRunRequestSchema', ...)`:

```ts
  it('accepts an optional image and services array', () => {
    const parsed = AgentRunRequestSchema.parse({
      taskId: 't1',
      stage: 'full_verify',
      attempt: 1,
      backend: 'claude',
      model: 'claude-sonnet-5',
      image: 'ghcr.io/example/agentops:latest',
      services: [{ name: 'redis', image: 'redis:7-alpine', readiness: { type: 'tcpSocket', port: 6379 } }],
      promptRef: 'full_verify.md',
      workspaceRef: '/tmp/ws',
      limits: { maxTokens: 1000, timeoutMs: 60_000 },
    });
    expect(parsed.image).toBe('ghcr.io/example/agentops:latest');
    expect(parsed.services).toEqual([
      { name: 'redis', image: 'redis:7-alpine', readiness: { type: 'tcpSocket', port: 6379 } },
    ]);
  });
```

Add to `describe('BackendRunRequestSchema', ...)`:

```ts
  it('carries image and services through, same as AgentRunRequestSchema', () => {
    const parsed = BackendRunRequestSchema.parse({
      taskId: 't1',
      stage: 'full_verify',
      attempt: 1,
      callIndex: 1,
      backend: 'claude',
      model: 'claude-sonnet-5',
      image: 'ghcr.io/example/agentops:latest',
      services: [{ name: 'redis', image: 'redis:7-alpine', readiness: { type: 'tcpSocket', port: 6379 } }],
      workspaceRef: '/tmp/ws',
      limits: { maxTokens: 1000, timeoutMs: 60_000 },
      prompt: 'run verify',
    });
    expect(parsed.image).toBe('ghcr.io/example/agentops:latest');
    expect(parsed.services).toHaveLength(1);
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
pnpm test -- agent-run
```

Expected: FAIL — `parsed.image`/`parsed.services` are `undefined`.

- [ ] **Step 3: Implement the schema addition**

In `packages/contracts/src/agent-run.ts`, add the import and the two new fields:

```ts
import { z } from 'zod';
import { StageSchema } from './stage';
import { VerifyServiceSchema } from './product-config';

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
  image: z.string().min(1).optional(),
  services: z.array(VerifyServiceSchema).optional(),
  promptRef: z.string().min(1),
  promptContext: z.record(z.string(), z.unknown()).default({}),
  workspaceRef: z.string().min(1),
  limits: AgentRunLimitsSchema,
});
export type AgentRunRequest = z.infer<typeof AgentRunRequestSchema>;
```

(`BackendRunRequestSchema` is derived from `AgentRunRequestSchema` via `.omit({...}).extend({...})` and needs no separate edit — it inherits `image`/`services` automatically.)

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
pnpm test -- agent-run
```

Expected: PASS, all tests including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/agent-run.ts packages/contracts/src/agent-run.test.ts
git commit -m "feat(contracts): thread image and services through AgentRunRequest"
```

---

### Task 4: Thread `image`/`services` through `createActivities.runAgent`

**Files:**
- Modify: `packages/activities/src/create-activities.ts:36-47`
- Test: `packages/activities/src/create-activities.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/activities/src/create-activities.test.ts`. First add this import at the top, alongside the existing ones:

```ts
import type { BackendRunRequest } from '@agentops/contracts';
```

Then add this test inside `describe('createActivities', ...)`:

```ts
  it('runAgent passes image and services through to the backend', async () => {
    const captured: BackendRunRequest[] = [];
    const recording: AgentBackend = {
      async run(req) {
        captured.push(req);
        return { output: 'ok', tokensIn: 1, tokensOut: 1, wallMs: 10 };
      },
    };
    const deps = { ...buildDeps(), backends: { recording } };
    const activities = createActivities(deps);

    await activities.runAgent({
      taskId: 't1',
      stage: 'full_verify',
      attempt: 1,
      callIndex: 1,
      backend: 'recording',
      model: 'stub-v1',
      image: 'ghcr.io/example/agentops:latest',
      services: [{ name: 'redis', image: 'redis:7-alpine', readiness: { type: 'tcpSocket', port: 6379 } }],
      promptRef: 'full_verify.md',
      promptContext: {},
      workspaceRef: 'demo/repo',
      limits: { maxTokens: 1000, timeoutMs: 60_000 },
    });

    expect(captured[0].image).toBe('ghcr.io/example/agentops:latest');
    expect(captured[0].services).toEqual([
      { name: 'redis', image: 'redis:7-alpine', readiness: { type: 'tcpSocket', port: 6379 } },
    ]);
  });
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
pnpm test -- create-activities
```

Expected: FAIL — `captured[0].image`/`captured[0].services` are `undefined` (`createActivities.runAgent` doesn't forward them yet).

- [ ] **Step 3: Implement the passthrough**

In `packages/activities/src/create-activities.ts`, update the `backend.run({...})` call (currently lines 36-47):

```ts
        return await backend.run({
          taskId: req.taskId,
          stage: req.stage,
          attempt: req.attempt,
          callIndex: req.callIndex,
          backend: req.backend,
          model: req.model,
          effort: req.effort,
          image: req.image,
          services: req.services,
          workspaceRef: req.workspaceRef,
          limits: req.limits,
          prompt,
        });
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
pnpm test -- create-activities
```

Expected: PASS, all tests including the new one.

- [ ] **Step 5: Commit**

```bash
git add packages/activities/src/create-activities.ts packages/activities/src/create-activities.test.ts
git commit -m "feat(activities): pass image and services through to the backend"
```

---

### Task 5: Thread `image`/`services` through `dev-cycle.ts`'s `runStageAgent`

**Files:**
- Modify: `packages/workflows/src/dev-cycle.ts:140-152`
- Test (new): `e2e/product-image-and-services.e2e.test.ts`

`dev-cycle.ts` has no dedicated unit test file — `devCycle`'s behavior is proven exclusively through the `e2e/*.e2e.test.ts` suite (Temporal's `TestWorkflowEnvironment`), so this task's test lives there, following the existing pattern (see `e2e/happy-path.e2e.test.ts`).

- [ ] **Step 1: Write the failing e2e test**

Create `e2e/product-image-and-services.e2e.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentBackend } from '@agentops/backends';
import type { BackendRunRequest, TaskInput } from '@agentops/contracts';
import { devCycle } from '@agentops/workflows';
import { buildTestEnv, waitForStatus, type TestEnv } from './helpers';

describe('DevCycle e2e: product image and services reach every stage agent call', () => {
  let testEnv: TestEnv | undefined;

  afterEach(async () => {
    await testEnv?.env.teardown();
  });

  it('threads config.image and config.services from TaskInput into runAgent for implement/full_verify/review', async () => {
    const captured: BackendRunRequest[] = [];
    const recording: AgentBackend = {
      async run(req) {
        captured.push(req);
        if (req.stage === 'full_verify') return { output: 'FULL: PASS', tokensIn: 1, tokensOut: 1, wallMs: 10 };
        if (req.stage === 'review') return { output: 'VERDICT: PASS', tokensIn: 1, tokensOut: 1, wallMs: 10 };
        return { output: 'diff --git a/widget.ts b/widget.ts', tokensIn: 1, tokensOut: 1, wallMs: 10 };
      },
    };

    testEnv = await buildTestEnv({ recording });
    const { env, worker, tracker, scm, taskQueue } = testEnv;

    tracker.seedIssue({ ref: 'issue-1', title: 'Add widget', body: 'Please add a widget', labels: [] });
    scm.scriptFeedback('pr-1', [{ ciStatus: 'green', unresolvedThreads: 0, comments: [] }]);

    const recordingRoute = { backend: 'recording', model: 'recording-v1' };
    const input: TaskInput = {
      taskId: 'image-services-task',
      product: 'demo',
      repo: 'demo/repo',
      issueRef: 'issue-1',
      goal: 'Add a widget',
      config: {
        image: 'ghcr.io/example/agentops:latest',
        services: [{ name: 'redis', image: 'redis:7-alpine', readiness: { type: 'tcpSocket', port: 6379 } }],
        fastVerifyCommands: [],
        fullVerifyCommands: [],
        stages: {},
        routing: {
          implement: recordingRoute,
          full_verify: recordingRoute,
          review: recordingRoute,
        },
        brakes: { maxImplementAttempts: 3, maxIterations: 10, maxTokens: 1_000_000, maxBabysitRounds: 5 },
      },
    };

    const finalState = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(devCycle, {
        taskQueue,
        workflowId: input.taskId,
        args: [input],
      });
      await waitForStatus(handle, ['done', 'blocked', 'failed'], 30_000);
      return handle.result();
    });

    expect(finalState.status).toBe('done');
    expect(captured.length).toBeGreaterThanOrEqual(2); // implement + full_verify, at least
    for (const req of captured) {
      expect(req.image).toBe('ghcr.io/example/agentops:latest');
      expect(req.services).toEqual([{ name: 'redis', image: 'redis:7-alpine', readiness: { type: 'tcpSocket', port: 6379 } }]);
    }
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
pnpm e2e -- product-image-and-services
```

Expected: FAIL — `req.image`/`req.services` are `undefined` on every captured request (`runStageAgent` doesn't forward them yet).

- [ ] **Step 3: Implement the passthrough**

In `packages/workflows/src/dev-cycle.ts`, update the `agentActivities.runAgent({...})` call inside `runStageAgent` (currently lines 140-152):

```ts
        result = await agentActivities.runAgent({
          taskId: input.taskId,
          stage,
          attempt,
          callIndex,
          backend,
          model: modelName,
          effort: model?.effort,
          image: input.config.image,
          services: input.config.services,
          promptRef: `${stage}.md`,
          promptContext: { taskId: input.taskId, goal: input.goal, ...extraContext },
          workspaceRef: state.workspaceRef,
          limits: { maxTokens: input.config.brakes.maxTokens, timeoutMs: 600_000 },
        });
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
pnpm e2e -- product-image-and-services
```

Expected: PASS.

- [ ] **Step 5: Run the full e2e suite to confirm no regressions**

```bash
pnpm e2e
```

Expected: PASS — all existing e2e scenarios (`happy-path`, `brake-and-rescue`, `garbage-verdict`, `exhausted-rounds`, `litellm-routing-and-budget`) still pass unchanged, since `image`/`services` are `undefined` in their configs and `undefined` fields don't change existing `runAgent` call behavior.

- [ ] **Step 6: Commit**

```bash
git add packages/workflows/src/dev-cycle.ts e2e/product-image-and-services.e2e.test.ts
git commit -m "feat(workflows): thread product image and services into every stage's agent call"
```

---

### Task 6: Render `image` override and `services` as native sidecars in `K8sJobRunner`

**Files:**
- Modify: `packages/backends/src/k8s/k8s-types.ts`
- Modify: `packages/backends/src/k8s/k8s-job-runner.ts`
- Test: `packages/backends/src/k8s/k8s-job-runner.test.ts`

- [ ] **Step 1: Add the new types to `k8s-types.ts`**

Replace the full contents of `packages/backends/src/k8s/k8s-types.ts` with:

```ts
export type V1ReadinessProbe = { exec: { command: string[] } } | { tcpSocket: { port: number } };

export interface V1InitContainer {
  name: string;
  image: string;
  restartPolicy?: 'Always';
  env?: Array<{ name: string; value: string }>;
  readinessProbe?: V1ReadinessProbe;
}

export interface V1Job {
  metadata?: { name?: string; namespace?: string };
  spec?: {
    ttlSecondsAfterFinished?: number;
    backoffLimit?: number;
    activeDeadlineSeconds?: number;
    template?: {
      spec?: {
        restartPolicy?: string;
        securityContext?: { runAsNonRoot?: boolean; runAsUser?: number };
        imagePullSecrets?: Array<{ name: string }>;
        volumes?: Array<{ name: string; persistentVolumeClaim?: { claimName: string } }>;
        initContainers?: V1InitContainer[];
        containers?: Array<{
          name: string;
          image: string;
          workingDir?: string;
          command?: string[];
          env?: Array<{ name: string; value: string }>;
          envFrom?: Array<{ secretRef?: { name: string } }>;
          securityContext?: { runAsNonRoot?: boolean; runAsUser?: number; allowPrivilegeEscalation?: boolean };
          volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
          readinessProbe?: V1ReadinessProbe;
        }>;
      };
    };
  };
  status?: {
    succeeded?: number;
    failed?: number;
    active?: number;
  };
}
```

This is a pure type-level change (no runtime code) — there's nothing to unit test in isolation; Steps 2-5 below prove it compiles and behaves correctly through `buildAgentJob`.

- [ ] **Step 2: Write the failing tests**

Add to `packages/backends/src/k8s/k8s-job-runner.test.ts`, inside `describe('buildAgentJob', ...)` (after the last existing `it`):

```ts
  it('uses req.image instead of spec.image when the request declares one', () => {
    const paths = agentOpsArtifactPaths(baseRequest);
    const job = buildAgentJob(
      { ...baseRequest, image: 'gitactions.est1908.top/broccoli/agentops:latest' },
      createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }),
      { namespace: 'dev-agents', workspacePvcName: 'workspace-tasks', workspaceMountPath: '/workspace/tasks' },
      paths,
    );
    const container = job.spec?.template?.spec?.containers?.[0];
    expect(container?.image).toBe('gitactions.est1908.top/broccoli/agentops:latest');
  });

  it('has no initContainers when the request declares no services', () => {
    const paths = agentOpsArtifactPaths(baseRequest);
    const job = buildAgentJob(
      baseRequest,
      createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }),
      { namespace: 'dev-agents', workspacePvcName: 'workspace-tasks', workspaceMountPath: '/workspace/tasks' },
      paths,
    );
    expect(job.spec?.template?.spec?.initContainers).toBeUndefined();
  });

  it('renders req.services as native sidecar initContainers with restartPolicy Always', () => {
    const paths = agentOpsArtifactPaths(baseRequest);
    const job = buildAgentJob(
      {
        ...baseRequest,
        services: [
          {
            name: 'postgres',
            image: 'pgvector/pgvector:pg18',
            env: { POSTGRES_USER: 'broccoli', POSTGRES_PASSWORD: 'broccoli' },
            readiness: { type: 'exec', command: ['pg_isready', '-U', 'broccoli'] },
          },
          {
            name: 'redis',
            image: 'redis:7-alpine',
            readiness: { type: 'tcpSocket', port: 6379 },
          },
        ],
      },
      createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }),
      { namespace: 'dev-agents', workspacePvcName: 'workspace-tasks', workspaceMountPath: '/workspace/tasks' },
      paths,
    );

    expect(job.spec?.template?.spec?.initContainers).toEqual([
      {
        name: 'postgres',
        image: 'pgvector/pgvector:pg18',
        restartPolicy: 'Always',
        env: [
          { name: 'POSTGRES_USER', value: 'broccoli' },
          { name: 'POSTGRES_PASSWORD', value: 'broccoli' },
        ],
        readinessProbe: { exec: { command: ['pg_isready', '-U', 'broccoli'] } },
      },
      {
        name: 'redis',
        image: 'redis:7-alpine',
        restartPolicy: 'Always',
        env: undefined,
        readinessProbe: { tcpSocket: { port: 6379 } },
      },
    ]);
  });
```

- [ ] **Step 3: Run the tests and confirm they fail**

```bash
pnpm test -- k8s-job-runner
```

Expected: FAIL — the "uses req.image" test fails because `buildAgentJob` still always uses `spec.image`; the "renders req.services" test fails because `initContainers` is never set.

- [ ] **Step 4: Implement image override and sidecar rendering**

In `packages/backends/src/k8s/k8s-job-runner.ts`, add these imports (alongside the existing ones) and two helper functions (placed after the `agentOpsArtifactPaths`/`k8sJobName` functions, before `buildAgentJob`):

```ts
import type { VerifyService, VerifyServiceReadiness } from '@agentops/contracts';
import type { V1InitContainer, V1Job, V1ReadinessProbe } from './k8s-types';
```

(Replace the existing `import type { V1Job } from './k8s-types';` line with the one above.)

```ts
function toReadinessProbe(readiness: VerifyServiceReadiness): V1ReadinessProbe {
  return readiness.type === 'exec'
    ? { exec: { command: readiness.command } }
    : { tcpSocket: { port: readiness.port } };
}

function buildInitContainers(services: VerifyService[] | undefined): V1InitContainer[] | undefined {
  if (!services || services.length === 0) {
    return undefined;
  }
  return services.map((service) => ({
    name: service.name,
    image: service.image,
    restartPolicy: 'Always',
    env: service.env ? Object.entries(service.env).map(([name, value]) => ({ name, value })) : undefined,
    readinessProbe: toReadinessProbe(service.readiness),
  }));
}
```

Then in `buildAgentJob`, add one line computing `initContainers` and wire it into the pod spec, and change the container's `image` to prefer `req.image`:

```ts
export function buildAgentJob(
  req: BackendRunRequest,
  spec: CliSpec,
  opts: Pick<
    K8sJobRunnerOptions,
    | 'namespace'
    | 'workspacePvcName'
    | 'workspaceMountPath'
    | 'authSecretName'
    | 'runAsUser'
    | 'imagePullSecretName'
  >,
  paths: ReturnType<typeof agentOpsArtifactPaths>,
): V1Job {
  const args = spec.buildArgs(req);
  const envFrom = opts.authSecretName ? [{ secretRef: { name: opts.authSecretName } }] : undefined;
  const runAsUser = opts.runAsUser ?? 1000;
  const imagePullSecrets = opts.imagePullSecretName ? [{ name: opts.imagePullSecretName }] : undefined;
  const initContainers = buildInitContainers(req.services);

  return {
    metadata: {
      name: k8sJobName(req),
      namespace: opts.namespace,
    },
    spec: {
      ttlSecondsAfterFinished: 300,
      backoffLimit: 0,
      activeDeadlineSeconds: Math.ceil(req.limits.timeoutMs / 1000),
      template: {
        spec: {
          restartPolicy: 'Never',
          securityContext: { runAsNonRoot: true, runAsUser },
          imagePullSecrets,
          volumes: [
            {
              name: 'workspace-tasks',
              persistentVolumeClaim: { claimName: opts.workspacePvcName },
            },
          ],
          initContainers,
          containers: [
            {
              name: 'agent',
              image: req.image ?? spec.image,
              workingDir: req.workspaceRef,
              command: ['/bin/sh', '-c', SHELL_REDIRECT, spec.binary, ...args],
              env: [
                { name: 'PROMPT_FILE', value: paths.promptFile },
                { name: 'OUT_FILE', value: paths.outFile },
                { name: 'ERR_FILE', value: paths.errFile },
              ],
              envFrom,
              securityContext: { runAsNonRoot: true, runAsUser, allowPrivilegeEscalation: false },
              volumeMounts: [
                {
                  name: 'workspace-tasks',
                  mountPath: opts.workspaceMountPath,
                },
              ],
            },
          ],
        },
      },
    },
  };
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
pnpm test -- k8s-job-runner
```

Expected: PASS, all tests including the three new ones.

- [ ] **Step 6: Run the full backends test suite to confirm no regressions**

```bash
pnpm test -- packages/backends
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/backends/src/k8s/k8s-types.ts packages/backends/src/k8s/k8s-job-runner.ts packages/backends/src/k8s/k8s-job-runner.test.ts
git commit -m "feat(backends): render product image override and services as native K8s sidecars"
```

---

### Task 7: Publish a stable `agent-runner:latest` tag from CI

**Files:**
- Modify: `.github/workflows/ci.yaml:65-70`

Products extending `agent-runner` as their own Dockerfile's base image (per the design doc's broccoli onboarding example) need a stable tag to `FROM` — today only the per-commit sha tag is pushed.

- [ ] **Step 1: Add the `latest` tag**

In `.github/workflows/ci.yaml`, find the `build-images` job's agent-runner build step (currently):

```yaml
      - uses: docker/build-push-action@v6
        with:
          context: images/agent-runner
          file: images/agent-runner/Dockerfile
          push: ${{ github.ref == 'refs/heads/main' }}
          tags: gitactions.est1908.top/agentic-ops/agent-runner:${{ github.sha }}
```

Replace the `tags:` line with:

```yaml
      - uses: docker/build-push-action@v6
        with:
          context: images/agent-runner
          file: images/agent-runner/Dockerfile
          push: ${{ github.ref == 'refs/heads/main' }}
          tags: |
            gitactions.est1908.top/agentic-ops/agent-runner:${{ github.sha }}
            gitactions.est1908.top/agentic-ops/agent-runner:latest
```

- [ ] **Step 2: Validate the YAML is well-formed**

```bash
pnpm exec prettier --check .github/workflows/ci.yaml
```

Expected: `All matched files use Prettier code style!` (prettier parses YAML and will fail loudly on a syntax error, e.g. bad indentation).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yaml
git commit -m "ci: publish a stable agent-runner:latest tag alongside the sha tag"
```

---

### Task 8: Open the PR, pass CI, and resolve the Bugbot review

**Files:** none (integration / review).

> Sequential and partly asynchronous — CI and Bugbot run on the remote PR.
> **HARD GATE: Do not mark this task complete until ALL Bugbot comments are
> resolved (fixed or replied to) AND CI is green. Check with
> `gh pr view --json reviews,comments` before claiming done.**

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
gh pr create --base main --fill --title "feat: product-declared verify environment (image + services)"
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
pnpm lint && pnpm typecheck && pnpm test && pnpm e2e   # suite green locally
```
Confirm no unresolved review threads remain, then mark this task complete.
