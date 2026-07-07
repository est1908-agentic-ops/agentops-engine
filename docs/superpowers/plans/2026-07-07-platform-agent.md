# Platform Agent (`platform` workflow) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new Temporal workflow, registered under workflow type `platform`, that runs one investigative agent session against a free-text prompt — reading Temporal history, cluster/log state, and any repo it needs — and, when it concludes a code fix is warranted, hands that fix off to a child `devCycle` run rather than writing code itself.

**Architecture:** A thin workflow (`packages/workflows/src/platform.ts`) calls the existing `runAgent` activity with a new `platform` role (its own prompt, its own K8s Job permissions — read-only kubectl, Temporal REST/actions, Grafana, no push credentials), parses a sentinel-delimited JSON result, and starts zero or more child `devCycle` workflows for any proposed fixes. New engine-repo work only: contracts, a pure result-parsing policy, two new activities (repo-config resolution + a scratch workspace, replacing the git-worktree flow `devCycle` uses), a role-scoped `K8sJobRunner` config, a prompt template, an agent-runner image addition, and chart RBAC/NetworkPolicy for the new role. Full design: `docs/superpowers/specs/2026-07-07-platform-agent-design.md`.

**Tech Stack:** TypeScript, Temporal TypeScript SDK, zod, vitest, pnpm workspaces, Helm.

---

## Task 1: Add the `platform` stage to `StageSchema`

**Files:**
- Modify: `packages/contracts/src/stage.ts`
- Test: `packages/contracts/src/stage.test.ts`

- [ ] **Step 1: Write the failing test**

Open `packages/contracts/src/stage.test.ts` and add a case to its existing `describe('StageSchema', ...)` block (read the file first to match its exact style):

```ts
it('accepts "platform" as a valid stage', () => {
  expect(StageSchema.parse('platform')).toBe('platform');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentops/contracts test -- stage.test.ts`
Expected: FAIL — `platform` is not a valid enum value.

- [ ] **Step 3: Add the enum value**

In `packages/contracts/src/stage.ts`, add `'platform'` to `StageSchema`'s enum array:

```ts
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
  'platform',
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentops/contracts test -- stage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/stage.ts packages/contracts/src/stage.test.ts
git commit -m "feat(contracts): add platform stage for the platform agent workflow"
```

---

## Task 2: Add platform-agent contracts

**Files:**
- Create: `packages/contracts/src/platform-agent.ts`
- Create: `packages/contracts/src/platform-agent.test.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/platform-agent.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  PlatformAgentInputSchema,
  PlatformAgentResultSchema,
  PlatformSentinelSchema,
} from './platform-agent';

describe('PlatformAgentInputSchema', () => {
  it('requires a non-empty prompt', () => {
    expect(() => PlatformAgentInputSchema.parse({ prompt: '' })).toThrow();
  });

  it('allows hintRepos to be omitted', () => {
    const parsed = PlatformAgentInputSchema.parse({ prompt: 'check the last failures' });
    expect(parsed.hintRepos).toBeUndefined();
  });

  it('accepts hintRepos as a list of repo slugs', () => {
    const parsed = PlatformAgentInputSchema.parse({
      prompt: 'check the last failures',
      hintRepos: ['flair-hr/agentops-engine'],
    });
    expect(parsed.hintRepos).toEqual(['flair-hr/agentops-engine']);
  });
});

describe('PlatformSentinelSchema', () => {
  it('defaults actionsTaken and proposedFixes to empty arrays', () => {
    const parsed = PlatformSentinelSchema.parse({ summary: 'all quiet' });
    expect(parsed.actionsTaken).toEqual([]);
    expect(parsed.proposedFixes).toEqual([]);
  });

  it('parses actionsTaken and proposedFixes when present', () => {
    const parsed = PlatformSentinelSchema.parse({
      summary: 'found one bug',
      actionsTaken: [{ type: 'terminate', workflowId: 'issue-broccoli-94', reason: 'stuck retry loop' }],
      proposedFixes: [{ repo: 'flair-hr/agentops-engine', goal: 'bound retry attempts' }],
    });
    expect(parsed.actionsTaken).toHaveLength(1);
    expect(parsed.proposedFixes).toHaveLength(1);
  });

  it('rejects an actionsTaken entry with an invalid type', () => {
    expect(() =>
      PlatformSentinelSchema.parse({
        summary: 'x',
        actionsTaken: [{ type: 'restart', workflowId: 'w', reason: 'r' }],
      }),
    ).toThrow();
  });
});

describe('PlatformAgentResultSchema', () => {
  it('defaults actionsTaken and childWorkflows to empty arrays', () => {
    const parsed = PlatformAgentResultSchema.parse({ summary: 'all quiet' });
    expect(parsed.actionsTaken).toEqual([]);
    expect(parsed.childWorkflows).toEqual([]);
  });

  it('parses a result with child workflows', () => {
    const parsed = PlatformAgentResultSchema.parse({
      summary: 'opened one fix',
      childWorkflows: [{ workflowId: 'platform-1-fix-1', repo: 'flair-hr/agentops-engine', goal: 'bound retries' }],
    });
    expect(parsed.childWorkflows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentops/contracts test -- platform-agent.test.ts`
Expected: FAIL — cannot find module `./platform-agent`.

- [ ] **Step 3: Write the schemas**

Create `packages/contracts/src/platform-agent.ts`:

```ts
import { z } from 'zod';

export const ProposedFixSchema = z.object({
  repo: z.string().min(1),
  goal: z.string().min(1),
});
export type ProposedFix = z.infer<typeof ProposedFixSchema>;

export const PlatformActionSchema = z.object({
  type: z.enum(['terminate', 'signal']),
  workflowId: z.string().min(1),
  reason: z.string().min(1),
});
export type PlatformAction = z.infer<typeof PlatformActionSchema>;

// What the platform-role agent emits after its sentinel line (PLATFORM_RESULT:,
// see packages/policies/src/parse-platform-result.ts). Not the workflow's return
// type -- proposedFixes gets consumed to start child devCycle runs and replaced
// with real childWorkflows (PlatformAgentResultSchema below) before returning.
export const PlatformSentinelSchema = z.object({
  summary: z.string().min(1),
  actionsTaken: z.array(PlatformActionSchema).default([]),
  proposedFixes: z.array(ProposedFixSchema).default([]),
});
export type PlatformSentinelPayload = z.infer<typeof PlatformSentinelSchema>;

export const PlatformAgentInputSchema = z.object({
  prompt: z.string().min(1),
  hintRepos: z.array(z.string()).optional(),
});
export type PlatformAgentInput = z.infer<typeof PlatformAgentInputSchema>;

export const PlatformAgentResultSchema = z.object({
  summary: z.string(),
  actionsTaken: z.array(PlatformActionSchema).default([]),
  childWorkflows: z
    .array(
      z.object({
        workflowId: z.string().min(1),
        repo: z.string().min(1),
        goal: z.string().min(1),
      }),
    )
    .default([]),
});
export type PlatformAgentResult = z.infer<typeof PlatformAgentResultSchema>;
```

- [ ] **Step 4: Export from the package index**

In `packages/contracts/src/index.ts`, add:

```ts
export * from './platform-agent';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @agentops/contracts test -- platform-agent.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/platform-agent.ts packages/contracts/src/platform-agent.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): add platform agent input/result/sentinel schemas"
```

---

## Task 3: Add the sentinel-result parser (`packages/policies`)

**Files:**
- Create: `packages/policies/src/parse-platform-result.ts`
- Create: `packages/policies/src/parse-platform-result.test.ts`
- Modify: `packages/policies/src/index.ts`

This mirrors `parse-verdict.ts`'s "last match wins, unparseable is a distinct outcome, never throw" shape — the `platform` workflow needs to know whether parsing succeeded so it can retry the agent call before falling back to a safe default, the same way `devCycle`'s `runVerdictStage` does.

- [ ] **Step 1: Write the failing test**

Create `packages/policies/src/parse-platform-result.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parsePlatformResult } from './parse-platform-result';

describe('parsePlatformResult', () => {
  it('parses a well-formed sentinel line', () => {
    const text = [
      'I looked at the last three failures.',
      'PLATFORM_RESULT: {"summary": "all quiet", "actionsTaken": [], "proposedFixes": []}',
    ].join('\n');

    const result = parsePlatformResult(text);

    expect(result.parseable).toBe(true);
    expect(result.payload.summary).toBe('all quiet');
    expect(result.payload.actionsTaken).toEqual([]);
    expect(result.payload.proposedFixes).toEqual([]);
  });

  it('parses proposedFixes and actionsTaken when present', () => {
    const text =
      'PLATFORM_RESULT: {"summary": "found a bug", "actionsTaken": [{"type": "terminate", "workflowId": "w1", "reason": "stuck"}], "proposedFixes": [{"repo": "flair-hr/agentops-engine", "goal": "bound retries"}]}';

    const result = parsePlatformResult(text);

    expect(result.parseable).toBe(true);
    expect(result.payload.actionsTaken).toHaveLength(1);
    expect(result.payload.proposedFixes).toHaveLength(1);
  });

  it('is unparseable when the sentinel is missing', () => {
    const result = parsePlatformResult('just some free text, no sentinel here');

    expect(result.parseable).toBe(false);
  });

  it('is unparseable when the JSON after the sentinel is malformed', () => {
    const result = parsePlatformResult('PLATFORM_RESULT: {not valid json');

    expect(result.parseable).toBe(false);
  });

  it('is unparseable when the JSON does not match the schema', () => {
    const result = parsePlatformResult('PLATFORM_RESULT: {"actionsTaken": []}');

    expect(result.parseable).toBe(false);
  });

  it('uses the last sentinel line when more than one is present', () => {
    const text = [
      'PLATFORM_RESULT: {"summary": "draft, ignore this one"}',
      'more reasoning...',
      'PLATFORM_RESULT: {"summary": "final answer"}',
    ].join('\n');

    const result = parsePlatformResult(text);

    expect(result.parseable).toBe(true);
    expect(result.payload.summary).toBe('final answer');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentops/policies test -- parse-platform-result.test.ts`
Expected: FAIL — cannot find module `./parse-platform-result`.

- [ ] **Step 3: Write the parser**

Create `packages/policies/src/parse-platform-result.ts`:

```ts
import { PlatformSentinelSchema, type PlatformSentinelPayload } from '@agentops/contracts';

export interface ParsedPlatformResult {
  parseable: boolean;
  payload: PlatformSentinelPayload;
}

const EMPTY_PAYLOAD: PlatformSentinelPayload = { summary: '', actionsTaken: [], proposedFixes: [] };

export function parsePlatformResult(text: string): ParsedPlatformResult {
  // Constructed fresh per call (not module-scoped) -- a `g`-flagged RegExp is
  // stateful across exec() calls via lastIndex, and reusing one across
  // invocations would silently skip matches on some calls. Same reasoning as
  // parse-verdict.ts's per-call `new RegExp(...)`.
  const pattern = /^PLATFORM_RESULT:\s*(.+)$/gm;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    lastMatch = match;
  }
  if (!lastMatch) {
    return { parseable: false, payload: EMPTY_PAYLOAD };
  }

  try {
    const json: unknown = JSON.parse(lastMatch[1]);
    return { parseable: true, payload: PlatformSentinelSchema.parse(json) };
  } catch {
    return { parseable: false, payload: EMPTY_PAYLOAD };
  }
}
```

- [ ] **Step 4: Export from the package index**

In `packages/policies/src/index.ts`, add:

```ts
export * from './parse-platform-result';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @agentops/policies test -- parse-platform-result.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/policies/src/parse-platform-result.ts packages/policies/src/parse-platform-result.test.ts packages/policies/src/index.ts
git commit -m "feat(policies): add sentinel parser for the platform agent's result"
```

---

## Task 4: Relocate `loadProductConfig` from `packages/cli` to `packages/activities`

**Why:** the `platform` workflow needs to load a target repo's `ProductConfig` from inside a Temporal activity (server-side, no filesystem/CLI context) before starting a child `devCycle`. The logic already exists in `packages/cli/src/load-product-config.ts`, written against the same `ScmPort` interface the activities layer already uses — it just lives in the wrong package for a second caller in `packages/activities` to reuse it without a cross-dependency into `packages/cli` (which itself depends on `packages/activities`, so the reverse import isn't available). `packages/cli` already depends on `@agentops/activities`, so this is a pure move, not a new dependency edge.

**Files:**
- Create: `packages/activities/src/load-product-config.ts`
- Create: `packages/activities/src/load-product-config.test.ts`
- Delete: `packages/cli/src/load-product-config.ts`
- Delete: `packages/cli/src/load-product-config.test.ts`
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/activities/src/index.ts`

- [ ] **Step 1: Move the implementation file**

```bash
git mv packages/cli/src/load-product-config.ts packages/activities/src/load-product-config.ts
git mv packages/cli/src/load-product-config.test.ts packages/activities/src/load-product-config.test.ts
```

The file's contents are unchanged — it only imports `ScmPort` from `@agentops/ports` and contract types from `@agentops/contracts`, both already dependencies of `packages/activities` (confirmed: `packages/activities/package.json` lists `@agentops/ports` and `@agentops/contracts`). No import lines inside the moved files need to change.

- [ ] **Step 2: Export it from the activities package**

In `packages/activities/src/index.ts`, add:

```ts
export * from './load-product-config';
```

- [ ] **Step 3: Update the CLI's import**

In `packages/cli/src/main.ts`, remove the old relative import and pull `loadProductConfig` from the activities package instead. Change:

```ts
import { loadEnv, loadProjectRegistry, SpawnGitCommandRunner } from '@agentops/activities';

loadEnv();
import type { ResolvedProjectEntry, TaskInput } from '@agentops/contracts';
import { createGithubPorts, MemoryScmPort, type ScmPort } from '@agentops/ports';
import { cancelSignal, clarifySignal, devCycle, resumeSignal, stateQuery, stopSignal } from '@agentops/workflows';
import { loadProductConfig } from './load-product-config';
```

to:

```ts
import { loadEnv, loadProductConfig, loadProjectRegistry, SpawnGitCommandRunner } from '@agentops/activities';

loadEnv();
import type { ResolvedProjectEntry, TaskInput } from '@agentops/contracts';
import { createGithubPorts, MemoryScmPort, type ScmPort } from '@agentops/ports';
import { cancelSignal, clarifySignal, devCycle, resumeSignal, stateQuery, stopSignal } from '@agentops/workflows';
```

- [ ] **Step 4: Run the test suites for both packages**

Run: `pnpm --filter @agentops/activities test -- load-product-config.test.ts && pnpm --filter @agentops/cli test`
Expected: both PASS — the moved test file passes unchanged in its new location, and `packages/cli`'s own tests (`main.test.ts`) still pass against the updated import.

- [ ] **Step 5: Commit**

```bash
git add -A packages/activities/src/load-product-config.ts packages/activities/src/load-product-config.test.ts packages/activities/src/index.ts packages/cli/src/main.ts
git commit -m "refactor: move loadProductConfig from packages/cli into packages/activities"
```

---

## Task 5: Add a scratch-workspace capability to `Workspaces`

**Why:** `devCycle`'s `prepareWorkspace`/`cleanupWorkspace` create a git worktree on a specific branch of a specific repo — the right shape for a task that commits code. `platform`'s Job never commits anything; it only needs an empty, writable directory on the same shared PVC for the agent CLI's prompt/output artifacts (`K8sJobRunner`'s `agentOpsArtifactPaths` writes `<workspaceRef>/.agentops/...`, and `workspaceRef` doubles as the container's `workingDir` — it must exist and be writable, but needs no git repo at all). Adding a sibling `prepareScratch`/`cleanupScratch` pair reuses the same `workspacesDir` root `WorkspaceManager` already resolves correctly for both local and in-cluster deployments, without touching the existing git-worktree path.

**Files:**
- Modify: `packages/activities/src/workspace/workspace-manager.ts`
- Modify: `packages/activities/src/workspace/memory-workspace-manager.ts`
- Modify: `packages/activities/src/workspace/workspace-manager.test.ts`
- Modify: `packages/activities/src/workspace/memory-workspace-manager.test.ts`

Both test files already exist. `workspace-manager.test.ts` sets up a module-scoped `workspacesDir` in its top-level `beforeEach` and exposes a `buildManager()` helper returning `{ manager, gitCalls }`; `memory-workspace-manager.test.ts` is one flat `describe('MemoryWorkspaceManager', ...)` block. The steps below add to both, matching their existing structure exactly.

- [ ] **Step 1: Write the failing tests**

Append to `packages/activities/src/workspace/workspace-manager.test.ts`, as a new top-level `describe` block after the existing `describe('WorkspaceManager — spawn failure classification', ...)` block (its `existsSync` import already covers this — no new imports needed):

```ts
describe('WorkspaceManager — scratch workspaces', () => {
  it('prepareScratch creates an empty directory under workspacesDir', async () => {
    const { manager } = buildManager();

    const { workspaceRef } = await manager.prepareScratch('platform-task-1');

    expect(existsSync(workspaceRef)).toBe(true);
    expect(workspaceRef.startsWith(workspacesDir)).toBe(true);
  });

  it('cleanupScratch removes the directory', async () => {
    const { manager } = buildManager();
    const { workspaceRef } = await manager.prepareScratch('platform-task-2');

    await manager.cleanupScratch(workspaceRef);

    expect(existsSync(workspaceRef)).toBe(false);
  });
});
```

Append to `packages/activities/src/workspace/memory-workspace-manager.test.ts`, as a new top-level `describe` block after the existing `describe('MemoryWorkspaceManager', ...)` block:

```ts
describe('MemoryWorkspaceManager — scratch workspaces', () => {
  it('prepareScratch returns a workspaceRef and marks it prepared', async () => {
    const manager = new MemoryWorkspaceManager();

    const { workspaceRef } = await manager.prepareScratch('task-1');

    expect(manager.isScratchPrepared(workspaceRef)).toBe(true);
  });

  it('cleanupScratch marks a prepared scratch workspace cleaned up', async () => {
    const manager = new MemoryWorkspaceManager();
    const { workspaceRef } = await manager.prepareScratch('task-1');

    await manager.cleanupScratch(workspaceRef);

    expect(manager.isScratchCleanedUp(workspaceRef)).toBe(true);
  });

  it('throws when cleanupScratch is called on a workspaceRef that was never prepared', async () => {
    const manager = new MemoryWorkspaceManager();

    await expect(manager.cleanupScratch('memory://scratch/never-prepared')).rejects.toThrow(/never prepared/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @agentops/activities test -- workspace-manager.test.ts memory-workspace-manager.test.ts`
Expected: FAIL — `prepareScratch`/`cleanupScratch` don't exist yet.

- [ ] **Step 3: Implement in `workspace-manager.ts`**

In `packages/activities/src/workspace/workspace-manager.ts`, extend the `Workspaces` interface:

```ts
export interface Workspaces {
  prepare(taskId: string, repo: string, initCommands?: string[]): Promise<PreparedWorkspace>;
  cleanup(workspaceRef: string, repo: string): Promise<void>;
  prepareScratch(taskId: string): Promise<{ workspaceRef: string }>;
  cleanupScratch(workspaceRef: string): Promise<void>;
}
```

Add the two methods to the `WorkspaceManager` class (after `prepare`/before `cleanup`, or wherever reads cleanest next to them):

```ts
async prepareScratch(taskId: string): Promise<{ workspaceRef: string }> {
  const workspaceRef = join(this.workspacesDir, 'scratch', taskId);
  await mkdir(workspaceRef, { recursive: true });
  return { workspaceRef };
}

async cleanupScratch(workspaceRef: string): Promise<void> {
  await rm(workspaceRef, { recursive: true, force: true });
}
```

- [ ] **Step 4: Implement in `memory-workspace-manager.ts`**

In `packages/activities/src/workspace/memory-workspace-manager.ts`:

```ts
export class MemoryWorkspaceManager implements Workspaces {
  private readonly prepared = new Set<string>();
  private readonly cleanedUp = new Set<string>();
  private readonly initCommands = new Map<string, string[] | undefined>();
  private readonly scratchPrepared = new Set<string>();
  private readonly scratchCleanedUp = new Set<string>();

  // ... existing prepare/cleanup/initCommandsFor/isPrepared/isCleanedUp unchanged ...

  async prepareScratch(taskId: string): Promise<{ workspaceRef: string }> {
    const workspaceRef = `memory://scratch/${taskId}`;
    this.scratchPrepared.add(workspaceRef);
    return { workspaceRef };
  }

  async cleanupScratch(workspaceRef: string): Promise<void> {
    if (!this.scratchPrepared.has(workspaceRef)) {
      throw new Error(
        `MemoryWorkspaceManager: cleanupScratch called on a workspaceRef that was never prepared: "${workspaceRef}"`,
      );
    }
    this.scratchCleanedUp.add(workspaceRef);
  }

  isScratchPrepared(workspaceRef: string): boolean {
    return this.scratchPrepared.has(workspaceRef);
  }

  isScratchCleanedUp(workspaceRef: string): boolean {
    return this.scratchCleanedUp.has(workspaceRef);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @agentops/activities test -- workspace-manager.test.ts memory-workspace-manager.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/activities/src/workspace/workspace-manager.ts packages/activities/src/workspace/memory-workspace-manager.ts packages/activities/src/workspace/workspace-manager.test.ts packages/activities/src/workspace/memory-workspace-manager.test.ts
git commit -m "feat(activities): add scratch workspace support for non-repo agent roles"
```

---

## Task 6: Add `resolveRepoConfig`, `prepareScratchWorkspace`, `cleanupScratchWorkspace` activities

**Files:**
- Modify: `packages/activities/src/create-activities.ts`
- Modify: `packages/activities/src/create-activities.test.ts`
- Modify: `packages/worker/src/main.ts`

`create-activities.test.ts` builds its `ActivityDependencies` fixture through a shared `buildDeps()` helper at the top of the file, reused by every `describe` block. Adding the new required `registry` field to `ActivityDependencies` means `buildDeps()` itself must be updated first, or every existing test in the file stops compiling — that update is Step 1 below, before any new test cases.

- [ ] **Step 1: Update the shared `buildDeps()` fixture**

In `packages/activities/src/create-activities.test.ts`, add `ResolvedProjectEntry` to the existing `@agentops/contracts` type-only import and add `registry: []` to `buildDeps()`'s return value:

```ts
import type { AgentBackend } from '@agentops/backends';
import type { BackendRunRequest, ResolvedProjectEntry } from '@agentops/contracts';
```

```ts
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
  };
}
```

- [ ] **Step 2: Write the failing tests**

Append two new `describe` blocks at the end of `packages/activities/src/create-activities.test.ts`, after the existing `describe('createActivities — backend error translation', ...)` block:

```ts
describe('createActivities — resolveRepoConfig', () => {
  it("resolves product from the registry and loads that repo's ProductConfig", async () => {
    const deps = buildDeps();
    deps.scm.seedFile('flair-hr/agentops-engine', 'agentops.json', JSON.stringify({ fastVerifyCommands: ['pnpm lint'] }));
    deps.registry = [{ product: 'engine', repo: 'flair-hr/agentops-engine', trackerType: 'github', tokenEnvVar: 'X' }];
    const activities = createActivities(deps);

    const { product, config } = await activities.resolveRepoConfig('flair-hr/agentops-engine');

    expect(product).toBe('engine');
    expect(config.fastVerifyCommands).toEqual(['pnpm lint']);
  });

  it('falls back to product "default" when the repo is not in the registry', async () => {
    const deps = buildDeps();
    const activities = createActivities(deps);

    const { product } = await activities.resolveRepoConfig('flair-hr/some-other-repo');

    expect(product).toBe('default');
  });
});

describe('createActivities — scratch workspace lifecycle', () => {
  it('prepareScratchWorkspace and cleanupScratchWorkspace delegate to the workspaces dependency', async () => {
    const deps = buildDeps();
    const activities = createActivities(deps);

    const { workspaceRef } = await activities.prepareScratchWorkspace('platform-task-1');
    expect((deps.workspaces as MemoryWorkspaceManager).isScratchPrepared(workspaceRef)).toBe(true);

    await activities.cleanupScratchWorkspace(workspaceRef);
    expect((deps.workspaces as MemoryWorkspaceManager).isScratchCleanedUp(workspaceRef)).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @agentops/activities test -- create-activities.test.ts`
Expected: FAIL — `resolveRepoConfig`/`prepareScratchWorkspace`/`cleanupScratchWorkspace` don't exist, and `ActivityDependencies` has no `registry` field yet (this also surfaces as a compile error on Step 1's `buildDeps()` update until Step 4 adds the field).

- [ ] **Step 4: Implement in `create-activities.ts`**

Add `registry` to `ActivityDependencies` and the three new activities. In `packages/activities/src/create-activities.ts`:

```ts
import { trace } from '@opentelemetry/api';
import { LiteLlmBudgetExceededError, RateWindowExceededError, type AgentBackend } from '@agentops/backends';
import type { Issue, OpenPrRequest, OpenPrResult, ScmPort, TrackerPort } from '@agentops/ports';
import type { AgentRunRequest, AgentRunResult, PrFeedback, ProductConfig, ResolvedProjectEntry, RunStats } from '@agentops/contracts';
import type { PromptPack } from '@agentops/prompts';
import type { StageResultRecord, StageResultStore } from './stage-result-store';
import type { StatsStore } from './stats-store';
import { WorkspaceError, type PreparedWorkspace, type Workspaces } from './workspace/workspace-manager';
import { loadProductConfig } from './load-product-config';
import { ApplicationFailure } from '@temporalio/common';

export interface ActivityDependencies {
  backends: Record<string, AgentBackend>;
  tracker: TrackerPort;
  scm: ScmPort;
  stats: StatsStore;
  stageResults: StageResultStore;
  workspaces: Workspaces;
  prompts: PromptPack;
  registry: ResolvedProjectEntry[];
}
```

Add the three activities to the object `createActivities` returns (alongside the existing ones, e.g. after `cleanupWorkspace`):

```ts
    async resolveRepoConfig(repo: string): Promise<{ product: string; config: ProductConfig }> {
      const entry = deps.registry.find((candidate) => candidate.repo === repo);
      const config = await loadProductConfig(deps.scm, repo);
      return { product: entry?.product ?? 'default', config };
    },
    async prepareScratchWorkspace(taskId: string): Promise<{ workspaceRef: string }> {
      try {
        return await deps.workspaces.prepareScratch(taskId);
      } catch (err) {
        rethrowWorkspaceError(err);
      }
    },
    async cleanupScratchWorkspace(workspaceRef: string): Promise<void> {
      try {
        await deps.workspaces.cleanupScratch(workspaceRef);
      } catch (err) {
        rethrowWorkspaceError(err);
      }
    },
```

- [ ] **Step 5: Update the worker wiring to pass `registry`**

In `packages/worker/src/main.ts`, the `createActivities` call currently doesn't pass `registry`. `registry` is already loaded earlier in `main()` (`const registry = loadProjectRegistry();`) — thread it through:

```ts
  const activities: DevCycleActivities = createActivities({
    backends: buildBackends(inCluster),
    tracker,
    scm,
    stats,
    stageResults: new InMemoryStageResultStore(),
    workspaces,
    prompts: new PromptPack(),
    registry,
  });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @agentops/activities test -- create-activities.test.ts && pnpm --filter @agentops/worker typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/activities/src/create-activities.ts packages/activities/src/create-activities.test.ts packages/worker/src/main.ts
git commit -m "feat(activities): add resolveRepoConfig and scratch workspace activities"
```

---

## Task 7: Let `K8sJobRunner` run a Job under a specific ServiceAccount with extra secrets

**Why:** the `platform` role's Job needs a different pod identity than `devCycle`'s Jobs — a ServiceAccount bound to a read-only ClusterRole (for kubectl) and an extra Secret (Temporal REST + Grafana basic-auth credentials) — without changing anything about how `devCycle`'s own Jobs run today (they keep using the namespace's `default` ServiceAccount and only the `authSecretName` they already pass).

**Files:**
- Modify: `packages/backends/src/k8s/k8s-types.ts`
- Modify: `packages/backends/src/k8s/k8s-job-runner.ts`
- Test: `packages/backends/src/k8s/k8s-job-runner.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/backends/src/k8s/k8s-job-runner.test.ts`, inside the existing `describe('buildAgentJob', ...)` block (matching its existing `baseRequest`/`paths` setup):

```ts
it('sets serviceAccountName when provided', () => {
  const paths = agentOpsArtifactPaths(baseRequest);
  const job = buildAgentJob(
    baseRequest,
    createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }),
    {
      namespace: 'dev-agents',
      workspacePvcName: 'workspace-tasks',
      workspaceMountPath: '/workspace/tasks',
      serviceAccountName: 'engine-platform-agent',
    },
    paths,
  );

  expect(job.spec?.template?.spec?.serviceAccountName).toBe('engine-platform-agent');
});

it('omits serviceAccountName when not provided (devCycle Jobs are unaffected)', () => {
  const paths = agentOpsArtifactPaths(baseRequest);
  const job = buildAgentJob(
    baseRequest,
    createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }),
    { namespace: 'dev-agents', workspacePvcName: 'workspace-tasks', workspaceMountPath: '/workspace/tasks' },
    paths,
  );

  expect(job.spec?.template?.spec?.serviceAccountName).toBeUndefined();
});

it('appends additionalSecretNames to envFrom alongside authSecretName', () => {
  const paths = agentOpsArtifactPaths(baseRequest);
  const job = buildAgentJob(
    baseRequest,
    createClaudeCliSpec({ image: 'ghcr.io/example/agent-claude:abc' }),
    {
      namespace: 'dev-agents',
      workspacePvcName: 'workspace-tasks',
      workspaceMountPath: '/workspace/tasks',
      authSecretName: 'claude-credentials',
      additionalSecretNames: ['platform-agent-credentials'],
    },
    paths,
  );

  expect(job.spec?.template?.spec?.containers?.[0].envFrom).toEqual([
    { secretRef: { name: 'claude-credentials' } },
    { secretRef: { name: 'platform-agent-credentials' } },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentops/backends test -- k8s-job-runner.test.ts`
Expected: FAIL — `serviceAccountName` is `undefined` where expected to be set (option not wired), and `additionalSecretNames` isn't recognized.

- [ ] **Step 3: Extend the types**

In `packages/backends/src/k8s/k8s-types.ts`, add `serviceAccountName` to the pod spec:

```ts
export interface V1Job {
  metadata?: { name?: string; namespace?: string };
  spec?: {
    ttlSecondsAfterFinished?: number;
    backoffLimit?: number;
    activeDeadlineSeconds?: number;
    template?: {
      spec?: {
        restartPolicy?: string;
        serviceAccountName?: string;
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

- [ ] **Step 4: Wire the new options into `buildAgentJob`**

In `packages/backends/src/k8s/k8s-job-runner.ts`, extend `K8sJobRunnerOptions`:

```ts
export interface K8sJobRunnerOptions {
  namespace: string;
  workspacePvcName: string;
  workspaceMountPath: string;
  batchApi: BatchV1ApiLike;
  pollIntervalMs?: number;
  authSecretName?: string;
  additionalSecretNames?: string[];
  serviceAccountName?: string;
  runAsUser?: number;
  imagePullSecretName?: string;
  heartbeat?: () => void;
  now?: () => number;
}
```

Update `buildAgentJob`'s `opts` parameter type and body:

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
    | 'additionalSecretNames'
    | 'serviceAccountName'
    | 'runAsUser'
    | 'imagePullSecretName'
  >,
  paths: ReturnType<typeof agentOpsArtifactPaths>,
): V1Job {
  const args = spec.buildArgs(req);
  const envFrom = [
    ...(opts.authSecretName ? [{ secretRef: { name: opts.authSecretName } }] : []),
    ...(opts.additionalSecretNames ?? []).map((name) => ({ secretRef: { name } })),
  ];
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
          serviceAccountName: opts.serviceAccountName,
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
              envFrom: envFrom.length > 0 ? envFrom : undefined,
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

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @agentops/backends test -- k8s-job-runner.test.ts`
Expected: PASS — also re-run the full file to confirm the pre-existing `buildAgentJob` tests (checking `envFrom`, `securityContext`, etc.) still pass unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/backends/src/k8s/k8s-types.ts packages/backends/src/k8s/k8s-job-runner.ts packages/backends/src/k8s/k8s-job-runner.test.ts
git commit -m "feat(backends): let K8sJobRunner set a serviceAccountName and extra secretRefs"
```

---

## Task 8: Register a `platform` backend entry in the worker

**Why:** `platform`'s workflow calls `runAgent` with `backend: 'platform'` — a new key in the worker's `backends` map, wrapping the same `claude` CLI spec as the `claude` backend but constructed with this role's `serviceAccountName` and `additionalSecretNames` (Task 7), so its Jobs get different permissions without touching the existing `claude`/`pi` entries.

**Files:**
- Modify: `packages/worker/src/main.ts`

- [ ] **Step 1: Extend `buildJobRunnerOptions` to accept the new fields**

In `packages/worker/src/main.ts`, change `buildJobRunnerOptions` to take an options bag instead of a single `authSecretName` positional so it can also carry `serviceAccountName`/`additionalSecretNames`:

```ts
export function buildJobRunnerOptions(
  batchApi: BatchV1ApiLike,
  opts: { authSecretName?: string; serviceAccountName?: string; additionalSecretNames?: string[] } = {},
): K8sJobRunnerOptions {
  return {
    namespace: process.env.AGENT_NAMESPACE ?? 'dev-agents',
    workspacePvcName: process.env.WORKSPACE_PVC_NAME ?? 'workspace-tasks',
    workspaceMountPath: process.env.WORKSPACE_MOUNT_PATH ?? '/workspace/tasks',
    authSecretName: opts.authSecretName,
    additionalSecretNames: opts.additionalSecretNames,
    serviceAccountName: opts.serviceAccountName,
    runAsUser: process.env.AGENT_RUNNER_UID ? Number(process.env.AGENT_RUNNER_UID) : undefined,
    imagePullSecretName: process.env.IMAGE_PULL_SECRET_NAME,
    batchApi,
  };
}
```

- [ ] **Step 2: Update the two existing call sites**

In `buildBackends`, update the `claude` and `pi` entries to pass the new options-bag shape:

```ts
    claude: wrapWithRateWindow(
      new K8sJobRunner(claudeSpec, buildJobRunnerOptions(batchApi, { authSecretName: process.env.CLAUDE_AUTH_SECRET_NAME })),
      'CLAUDE',
      'claude',
    ),
    pi: wrapWithRateWindow(
      new K8sJobRunner(piSpec, buildJobRunnerOptions(batchApi, { authSecretName: process.env.PI_AUTH_SECRET_NAME })),
      'PI',
      'pi',
    ),
```

- [ ] **Step 3: Add the `platform` backend entry**

Still in `buildBackends`, add a third entry after `pi` (inside the `inCluster` branch — the platform role only makes sense with real cluster RBAC/Job permissions, so outside the cluster it can fall back to the same local `claude` CLI spawn the `claude` key already uses):

```ts
  if (!inCluster) {
    return {
      stub: new StubBackend(),
      claude: wrapWithRateWindow(new ProcessCliRunner(claudeSpec), 'CLAUDE', 'claude'),
      pi: wrapWithRateWindow(new ProcessCliRunner(piSpec), 'PI', 'pi'),
      platform: wrapWithRateWindow(new ProcessCliRunner(claudeSpec), 'CLAUDE', 'platform'),
      litellm,
    };
  }

  const kc = new KubeConfig();
  kc.loadFromCluster();
  const batchApi = batchApiFromClient(kc.makeApiClient(BatchV1Api));

  return {
    stub: new StubBackend(),
    claude: wrapWithRateWindow(
      new K8sJobRunner(claudeSpec, buildJobRunnerOptions(batchApi, { authSecretName: process.env.CLAUDE_AUTH_SECRET_NAME })),
      'CLAUDE',
      'claude',
    ),
    pi: wrapWithRateWindow(
      new K8sJobRunner(piSpec, buildJobRunnerOptions(batchApi, { authSecretName: process.env.PI_AUTH_SECRET_NAME })),
      'PI',
      'pi',
    ),
    platform: wrapWithRateWindow(
      new K8sJobRunner(
        claudeSpec,
        buildJobRunnerOptions(batchApi, {
          authSecretName: process.env.CLAUDE_AUTH_SECRET_NAME,
          serviceAccountName: process.env.PLATFORM_AGENT_SERVICE_ACCOUNT,
          additionalSecretNames: process.env.PLATFORM_AGENT_SECRET_NAME ? [process.env.PLATFORM_AGENT_SECRET_NAME] : undefined,
        }),
      ),
      'CLAUDE',
      'platform',
    ),
    litellm,
  };
```

- [ ] **Step 4: Typecheck and run the worker's existing tests**

Run: `pnpm --filter @agentops/worker typecheck && pnpm --filter @agentops/worker test`
Expected: PASS — `buildBackends`/`buildJobRunnerOptions` have no dedicated tests today beyond typechecking against `K8sJobRunnerOptions` (confirm by running the worker package's full test file list); if a test asserts on the old `buildJobRunnerOptions(batchApi, secretName)` two-positional-arg signature, update it to the new options-bag call shown above.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/main.ts
git commit -m "feat(worker): register a platform backend with its own ServiceAccount and secrets"
```

---

## Task 9: Define the `PlatformActivities` interface

**Files:**
- Create: `packages/workflows/src/platform-activities-api.ts`

- [ ] **Step 1: Write the interface**

Create `packages/workflows/src/platform-activities-api.ts`:

```ts
import type { AgentRunRequest, AgentRunResult, ProductConfig, RunStats } from '@agentops/contracts';

export interface PlatformActivities {
  runAgent(req: AgentRunRequest): Promise<AgentRunResult>;
  recordRunStats(stats: RunStats): Promise<void>;
  resolveRepoConfig(repo: string): Promise<{ product: string; config: ProductConfig }>;
  prepareScratchWorkspace(taskId: string): Promise<{ workspaceRef: string }>;
  cleanupScratchWorkspace(workspaceRef: string): Promise<void>;
}
```

No test for this step — it's a type-only file; correctness is verified by Task 10's workflow compiling against it and Task 6/Task 3's activity/policy tests already covering the underlying implementations.

- [ ] **Step 2: Commit**

```bash
git add packages/workflows/src/platform-activities-api.ts
git commit -m "feat(workflows): define the PlatformActivities interface"
```

---

## Task 10: Implement the `platform` workflow

**Files:**
- Create: `packages/workflows/src/platform.ts`
- Modify: `packages/workflows/src/index.ts`
- Modify: `packages/worker/src/create-worker.ts`
- Modify: `packages/policies/package.json` dependency check (verify `packages/workflows` already depends on `@agentops/policies` — it does, per `dev-cycle.ts`'s import; no change needed, called out here so the next step isn't a surprise)

This task has no isolated unit test of its own — mirroring this codebase's existing convention, `devCycle` itself has no separate workflow-unit-test file; workflow orchestration is verified through the `e2e/` suite (`TestWorkflowEnvironment` + a real worker + the `stub` backend). Task 12 provides that coverage for `platform`.

- [ ] **Step 1: Write the workflow**

Create `packages/workflows/src/platform.ts`:

```ts
import { executeChild, proxyActivities, workflowInfo } from '@temporalio/workflow';
import type { PlatformAgentInput, PlatformAgentResult, TaskInput } from '@agentops/contracts';
import { PlatformAgentResultSchema } from '@agentops/contracts';
import { parsePlatformResult } from '@agentops/policies';
import { devCycle } from './dev-cycle';
import type { PlatformActivities } from './platform-activities-api';

const activities = proxyActivities<PlatformActivities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 5 },
});

const agentActivities = proxyActivities<Pick<PlatformActivities, 'runAgent'>>({
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '15s',
  retry: { maximumAttempts: 5 },
});

// This role isn't scoped to one product, so there's no ProductConfig to route
// through -- fixed here at the same reasoning-heavy tier devCycle uses for
// design/review. 'platform' (not 'claude') as the backend key: it's the same
// claude CLI, but a distinct worker backend entry with this role's own
// ServiceAccount/secrets (see packages/worker/src/main.ts buildBackends).
const PLATFORM_MODEL = { backend: 'platform', model: 'claude-sonnet-5', effort: 'high' as const };
const PLATFORM_MAX_TOKENS = 400_000;
const PLATFORM_TIMEOUT_MS = 1_800_000;
const MAX_RESULT_CALLS = 2;

export async function platform(input: PlatformAgentInput): Promise<PlatformAgentResult> {
  const taskId = workflowInfo().workflowId;
  const { workspaceRef } = await activities.prepareScratchWorkspace(taskId);

  let payload;
  try {
    for (let call = 1; call <= MAX_RESULT_CALLS; call += 1) {
      const result = await agentActivities.runAgent({
        taskId,
        stage: 'platform',
        attempt: 1,
        callIndex: call,
        backend: PLATFORM_MODEL.backend,
        model: PLATFORM_MODEL.model,
        effort: PLATFORM_MODEL.effort,
        promptRef: 'platform.md',
        promptContext: {
          taskId,
          prompt: input.prompt,
          hintRepos: (input.hintRepos ?? []).join(', ') || '(none provided)',
        },
        workspaceRef,
        limits: { maxTokens: PLATFORM_MAX_TOKENS, timeoutMs: PLATFORM_TIMEOUT_MS },
      });
      await activities.recordRunStats({
        taskId,
        stage: 'platform',
        backend: PLATFORM_MODEL.backend,
        model: PLATFORM_MODEL.model,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        wallMs: result.wallMs,
        outcome: 'pass',
      });
      const parsed = parsePlatformResult(result.output);
      if (parsed.parseable) {
        payload = parsed.payload;
        break;
      }
    }
  } finally {
    await activities.cleanupScratchWorkspace(workspaceRef);
  }

  if (!payload) {
    return PlatformAgentResultSchema.parse({
      summary: `agent output was unparseable after ${MAX_RESULT_CALLS} attempt(s)`,
    });
  }

  const childWorkflows: PlatformAgentResult['childWorkflows'] = [];
  for (const [index, fix] of payload.proposedFixes.entries()) {
    const { product, config } = await activities.resolveRepoConfig(fix.repo);
    const childTaskId = `${taskId}-fix-${index + 1}`;
    const taskInput: TaskInput = { taskId: childTaskId, product, repo: fix.repo, goal: fix.goal, config };
    await executeChild(devCycle, { workflowId: childTaskId, args: [taskInput] });
    childWorkflows.push({ workflowId: childTaskId, repo: fix.repo, goal: fix.goal });
  }

  return PlatformAgentResultSchema.parse({
    summary: payload.summary,
    actionsTaken: payload.actionsTaken,
    childWorkflows,
  });
}
```

- [ ] **Step 2: Export it from the package index**

In `packages/workflows/src/index.ts`, add:

```ts
export * from './platform';
export * from './platform-activities-api';
```

- [ ] **Step 3: Widen the worker's activities type**

In `packages/worker/src/create-worker.ts`, the worker registers one flat activities object for every workflow type on the task queue — widen the type so it accepts an object satisfying both interfaces:

```ts
import type { DevCycleActivities, PlatformActivities } from '@agentops/workflows';
```

```ts
export interface CreateWorkerOptions {
  taskQueue: string;
  activities: DevCycleActivities & PlatformActivities;
  connection?: NativeConnection;
  workflowsPath?: string;
  namespace?: string;
  tracing?: TracingSetup;
}
```

- [ ] **Step 4: Update `packages/worker/src/main.ts`'s activities type annotation**

The `const activities: DevCycleActivities = createActivities({...})` line now needs to satisfy the wider type too:

```ts
  const activities: DevCycleActivities & PlatformActivities = createActivities({
```

Add `PlatformActivities` to the `@agentops/workflows` import list at the top of the file.

- [ ] **Step 5: Typecheck everything touched so far**

Run: `pnpm --filter @agentops/workflows typecheck && pnpm --filter @agentops/worker typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/workflows/src/platform.ts packages/workflows/src/index.ts packages/worker/src/create-worker.ts packages/worker/src/main.ts
git commit -m "feat(workflows): implement the platform workflow"
```

---

## Task 11: Add the `platform.md` prompt template

**Files:**
- Create: `packages/prompts/templates/platform.md`

- [ ] **Step 1: Write the template**

Create `packages/prompts/templates/platform.md`:

```markdown
# Platform agent — Task {{taskId}}

You are the platform's operations agent. A human asked:

{{prompt}}

Repos to start looking at, if any were suggested (not a restriction — investigate wherever
the evidence leads): {{hintRepos}}

Use the `platform-ops` skill for how to investigate: Temporal's REST API for workflow status
and history, Grafana's Loki and Prometheus datasource proxies for logs and cluster resource
state, read-only `kubectl` for live cluster objects, and read-only clones of any repo you need
to trace an error back to source.

You may take the following actions directly, if you determine they're warranted:

- Terminate a stuck or misbehaving Temporal workflow.
- Send an existing signal (`clarify` or `resume`) to a workflow.

You may NOT modify any Kubernetes resource, push to any branch, or open a pull request
yourself. If you conclude a code change is needed in some repo, describe it as a proposed fix
instead — a separate pipeline (devCycle) will implement it with full verification and review.
An empty list of proposed fixes for a pure question is expected and correct, not a failure.

When you are done, end your response with exactly one line in this exact form — compact JSON,
no line breaks inside it:

PLATFORM_RESULT: {"summary": "...", "actionsTaken": [...], "proposedFixes": [...]}

- `summary`: your findings or answer, in plain language, for a human to read.
- `actionsTaken`: array of `{"type": "terminate"|"signal", "workflowId": "...", "reason": "..."}`
  for anything you already executed directly. Use `[]` if you took no actions.
- `proposedFixes`: array of `{"repo": "owner/repo", "goal": "..."}` for anything you concluded
  needs a code change. Use `[]` if none apply.
```

- [ ] **Step 2: Verify it renders without a missing-placeholder error**

Run a quick manual check (no dedicated test file for prompt template content exists elsewhere in this repo — `render-prompt.test.ts` covers the renderer itself, not individual templates):

```bash
node -e "
const { PromptPack } = require('./packages/prompts/dist/index.js');
const pack = new PromptPack({ templatesDir: './packages/prompts/templates' });
console.log(pack.render('platform.md', { taskId: 't1', prompt: 'check the last failures', hintRepos: '(none provided)' }));
"
```

(If `packages/prompts` isn't built yet, run `pnpm --filter @agentops/prompts build` first, or instead just re-run `pnpm --filter @agentops/prompts test -- render-prompt.test.ts` to confirm the renderer itself still passes — the template content only needs its three placeholders, `{{taskId}}`, `{{prompt}}`, `{{hintRepos}}`, to exactly match what `platform.ts`'s `promptContext` provides, which Task 12's e2e test exercises end-to-end.)

Expected: the rendered output contains the substituted values with no `MissingTemplateVariableError`.

- [ ] **Step 3: Commit**

```bash
git add packages/prompts/templates/platform.md
git commit -m "feat(prompts): add the platform role's prompt template"
```

---

## Task 12: End-to-end test for the `platform` workflow

**Files:**
- Create: `e2e/platform-agent.e2e.test.ts`
- Modify: `e2e/helpers.ts`

- [ ] **Step 1: Extend the shared test-env builder**

`buildTestEnv()` in `e2e/helpers.ts` constructs `DevCycleActivities` — widen it the same way Task 10 widened the worker's type, and pass an empty `registry` by default (tests that need registry entries pass them via a new option):

```ts
export interface BuildTestEnvOptions {
  extraBackends?: Record<string, AgentBackend>;
  tracing?: TracingSetup;
  registry?: ResolvedProjectEntry[];
}

export async function buildTestEnv(opts: BuildTestEnvOptions = {}): Promise<TestEnv> {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const stub = new StubBackend();
  const tracker = new MemoryTrackerPort();
  const scm = new MemoryScmPort();
  const stats = new InMemoryStatsStore();
  const stageResults = new InMemoryStageResultStore();
  const workspaces = new MemoryWorkspaceManager();

  const activities: DevCycleActivities & PlatformActivities = createActivities({
    backends: { stub, platform: stub, ...opts.extraBackends },
    tracker,
    scm,
    stats,
    stageResults,
    workspaces,
    prompts: new PromptPack(),
    registry: opts.registry ?? [],
  });

  const taskQueue = nextTaskQueue();
  const worker = await createWorker({
    taskQueue,
    activities,
    connection: env.nativeConnection,
    tracing: opts.tracing,
  });

  return { env, worker, stub, tracker, scm, stats, stageResults, workspaces, taskQueue };
}
```

Add `PlatformActivities` and `ResolvedProjectEntry` to this file's existing imports (`@agentops/workflows` and `@agentops/contracts` respectively). `backends: { stub, platform: stub, ... }` registers the `stub` backend under both the `stub` and `platform` keys — the e2e test scripts responses by *stage*, not by backend key, so `platform`'s `runAgent` calls (which request `backend: 'platform'`) resolve to the same `StubBackend` instance the rest of this test suite already uses.

- [ ] **Step 2: Write the failing e2e tests**

Create `e2e/platform-agent.e2e.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { PlatformAgentInput } from '@agentops/contracts';
import { devCycle, platform } from '@agentops/workflows';
import { buildTestEnv, waitForStatus, type TestEnv } from './helpers';

describe('platform e2e', () => {
  let testEnv: TestEnv | undefined;

  afterEach(async () => {
    await testEnv?.env.teardown();
  });

  it('answers a pure question with no proposed fixes and starts no child workflow', async () => {
    testEnv = await buildTestEnv();
    const { env, worker, stub, taskQueue } = testEnv;

    stub.scriptResponse('platform', 1, {
      output: 'Nothing looks wrong.\nPLATFORM_RESULT: {"summary": "all quiet", "actionsTaken": [], "proposedFixes": []}',
    });

    const input: PlatformAgentInput = { prompt: 'check the last workflow failures, do you see anything strange?' };

    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(platform, {
        taskQueue,
        workflowId: 'platform-quiet',
        args: [input],
      });
      return handle.result();
    });

    expect(result.summary).toBe('all quiet');
    expect(result.actionsTaken).toEqual([]);
    expect(result.childWorkflows).toEqual([]);
  });

  it('starts a child devCycle for a proposed fix and it runs to done', async () => {
    testEnv = await buildTestEnv({
      registry: [{ product: 'engine', repo: 'demo/repo', trackerType: 'github', tokenEnvVar: 'X' }],
    });
    const { env, worker, stub, scm, taskQueue } = testEnv;

    scm.seedFile('demo/repo', 'agentops.json', JSON.stringify({ fastVerifyCommands: [], fullVerifyCommands: [] }));

    stub.scriptResponse('platform', 1, {
      output:
        'Found a retry-policy bug.\nPLATFORM_RESULT: {"summary": "found one bug", "actionsTaken": [], "proposedFixes": [{"repo": "demo/repo", "goal": "bound retries"}]}',
    });
    stub.scriptResponse('implement', 1, { output: 'diff --git a/x.ts b/x.ts (fix)' });
    stub.scriptResponse('full_verify', 1, { output: 'FULL: PASS' });
    stub.scriptResponse('review', 1, { output: 'VERDICT: PASS' });
    scm.scriptFeedback('pr-1', [{ ciStatus: 'green', unresolvedThreads: 0, comments: [] }]);

    const input: PlatformAgentInput = { prompt: 'investigate the last workflow failures and fix them' };

    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(platform, {
        taskQueue,
        workflowId: 'platform-fix',
        args: [input],
      });
      const platformResult = await handle.result();

      const childHandle = env.client.workflow.getHandle(platformResult.childWorkflows[0].workflowId);
      await waitForStatus(childHandle as never, ['done', 'blocked', 'failed'], 30_000);

      return platformResult;
    });

    expect(result.summary).toBe('found one bug');
    expect(result.childWorkflows).toHaveLength(1);
    expect(result.childWorkflows[0].repo).toBe('demo/repo');
    const childState = await env.client.workflow.getHandle(result.childWorkflows[0].workflowId).result();
    expect(childState.status).toBe('done');
    expect(scm.getOpenedPrs()).toHaveLength(1);
  });

  it('retries once on unparseable output before giving up', async () => {
    testEnv = await buildTestEnv();
    const { env, worker, stub, taskQueue } = testEnv;

    stub.scriptResponse('platform', 1, { output: 'no sentinel in this one' }, 1);
    stub.scriptResponse('platform', 1, { output: 'still no sentinel' }, 2);

    const input: PlatformAgentInput = { prompt: 'anything strange?' };

    const result = await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(platform, {
        taskQueue,
        workflowId: 'platform-unparseable',
        args: [input],
      });
      return handle.result();
    });

    expect(result.summary).toContain('unparseable');
    expect(result.childWorkflows).toEqual([]);
  });
});
```

`devCycle` is imported but unused directly in this file's assertions — remove that import if the linter flags it; the child workflow is exercised via `platform`'s own `executeChild` call, not invoked directly here.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm e2e -- platform-agent.e2e.test.ts`
Expected: FAIL initially for any mismatch between the stub script keys/sentinel format and the real implementation — use these failures to catch any drift between this task and Tasks 6/10/11 before moving on (e.g., a typo in `stage: 'platform'` vs `'platform '`, or a promptContext key mismatch).

- [ ] **Step 4: Fix any drift and re-run until green**

Iterate on whichever earlier task's code doesn't match this test's expectations (do not change the test's expectations to match a bug — these three scenarios are the acceptance criteria for the whole plan).

Run: `pnpm e2e -- platform-agent.e2e.test.ts`
Expected: PASS (all three tests)

- [ ] **Step 5: Run the full existing e2e suite to confirm no regressions**

Run: `pnpm e2e`
Expected: PASS — the `helpers.ts` change in Step 1 (widened `BuildTestEnvOptions`, `registry` default `[]`, `platform: stub` backend entry) must not break any existing `devCycle` e2e test.

- [ ] **Step 6: Commit**

```bash
git add e2e/helpers.ts e2e/platform-agent.e2e.test.ts
git commit -m "test(e2e): cover the platform workflow's fix and no-fix paths"
```

---

## Task 13: Add `curl` and `kubectl` to the shared agent-runner image

**Files:**
- Modify: `images/agent-runner/Dockerfile`

- [ ] **Step 1: Edit the Dockerfile**

In `images/agent-runner/Dockerfile`, extend the `apt-get install` line and add a pinned `kubectl` install. Change:

```dockerfile
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
```

to:

```dockerfile
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# kubectl for the platform role's read-only cluster-state investigation (see
# 2026-07-07-platform-agent-design.md §6) -- harmless for every other role's
# Jobs, which run under the dev-agents namespace's `default` ServiceAccount
# with no RBAC bindings: the binary is present but useless without a bound
# Role/ClusterRole, so this doesn't change what a devCycle Job can reach.
RUN curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/v1.31.1/bin/linux/amd64/kubectl" \
    && chmod +x /usr/local/bin/kubectl
```

Keep this addition before the `USER 1000` line (root privileges are needed to write to `/usr/local/bin`).

- [ ] **Step 2: Verify the image still builds**

Run: `docker build -t agent-runner-test images/agent-runner`
Expected: build succeeds; `docker run --rm agent-runner-test kubectl version --client` and `docker run --rm agent-runner-test curl --version` both print version output without error.

- [ ] **Step 3: Commit**

```bash
git add images/agent-runner/Dockerfile
git commit -m "feat(agent-runner): add curl and kubectl for the platform role's toolbelt"
```

---

## Task 14: Add the `platform-ops` skill to the agent-runner image

**Files:**
- Create: `images/agent-runner/skills/platform-ops/SKILL.md`
- Modify: `images/agent-runner/Dockerfile`

- [ ] **Step 1: Write the skill**

Create `images/agent-runner/skills/platform-ops/SKILL.md`, extending `.claude/skills/debug-devcycle-issue/SKILL.md`'s technique (Temporal REST + Grafana/Loki, both already proven in this repo) with Prometheus and read-only kubectl:

```markdown
---
name: platform-ops
description: Use when running as the platform agent (workflow type "platform") to investigate Temporal workflow failures, cluster/log state, or to reflect on a recent run — pulls workflow history via Temporal's REST API, logs via Grafana's Loki proxy, resource/cluster metrics via Grafana's Prometheus proxy, and live cluster objects via read-only kubectl. Ends with the PLATFORM_RESULT: sentinel described in this task's prompt.
---

# Platform agent operations

No cluster shell access beyond what this role's Job already grants is assumed. Investigation
goes through three channels: two HTTP APIs (Temporal REST, Grafana's datasource proxy in front
of Loki and Prometheus) and read-only `kubectl` (this role's ServiceAccount only — get/list/
watch, no exec/delete/patch/create).

## Temporal — workflow status and history

Same technique as `debug-devcycle-issue`:

```
curl -s "https://<temporal-host>/api/v1/namespaces/<namespace>/workflows/<workflowId>"
curl -s "https://<temporal-host>/api/v1/namespaces/<namespace>/workflows/<workflowId>/history?historyEventFilterType=HISTORY_EVENT_FILTER_TYPE_ALL_EVENT"
```

To list recent workflows (e.g. "the last workflow failures"):

```
curl -s "https://<temporal-host>/api/v1/namespaces/<namespace>/workflows?query=$(python3 -c "import urllib.parse; print(urllib.parse.quote('ExecutionStatus=\"Failed\" OR ExecutionStatus=\"Canceled\"'))")"
```

**Safe actions you may take directly** (see this task's prompt for the exact allow-list):
terminate a workflow via `POST .../workflows/<workflowId>/terminate`, or send an existing
signal (`clarify`/`resume`) via `POST .../workflows/<workflowId>/signal`. Always record what you
did and why in the `actionsTaken` field of your final `PLATFORM_RESULT:` line.

## Grafana → Loki (logs)

Identical to `debug-devcycle-issue`: find the Loki datasource UID via
`/api/datasources`, then GET (never POST) `/api/datasources/proxy/uid/<uid>/loki/api/v1/query_range`
with `-G --data-urlencode`, `start`/`end` in nanoseconds since epoch.

## Grafana → Prometheus (cluster/resource state)

Same proxy pattern, different datasource UID (look for `"type": "prometheus"` in
`/api/datasources`):

```
curl -s -u '<user>:<pass>' -G "https://<grafana-host>/api/datasources/proxy/uid/<uid>/api/v1/query" \
  --data-urlencode 'query=container_memory_usage_bytes{namespace="dev-agents"}'
```

Useful queries: `container_memory_usage_bytes`, `container_cpu_usage_seconds_total`,
`kube_pod_container_status_restarts_total`, `kube_pod_status_phase`.

## kubectl (read-only)

This role's ServiceAccount token is auto-mounted the normal Kubernetes way — no separate
kubeconfig needed, `kubectl` picks it up automatically inside the pod:

```
kubectl get pods -n dev-agents
kubectl describe pod <pod> -n dev-agents
kubectl get events -n dev-agents --sort-by=.lastTimestamp
```

`get`/`describe`/`events` work; `exec`/`delete`/`patch`/`create`/`apply` do not — this
ServiceAccount's ClusterRole grants `get`/`list`/`watch` only. A permission error here is
expected for anything beyond reading; it is not a bug to work around.

## Reading repos

You have read-only clones available for any registered repo (engine, platform, or product) —
use them to trace a stack trace from Temporal/Loki output back to a source file/line, the same
way `debug-devcycle-issue`'s worked example does. You do not have push access to any repo; if
a fix is warranted, describe it in `proposedFixes` instead of committing anything.

## Checklist

- [ ] For "investigate failures": list recent failed/canceled workflows, describe + pull
      history for each, fall back to Loki logs (windowed around start/close time) per the
      history limitation `debug-devcycle-issue` documents (a still-retrying activity's
      failures never land in history).
- [ ] For "check cluster state": kubectl get pods/events in the relevant namespace, cross-check
      restart counts and resource usage against Prometheus if anything looks off.
- [ ] For "reflect on a run": pull the full trace (Temporal history + Loki), read the relevant
      source, and summarize concretely — vague "consider improving X" findings are less useful
      than "stage Y retried N times because Z, bounded by policy W".
- [ ] Always end with exactly one `PLATFORM_RESULT:` line, even when the answer is "nothing
      wrong found" — an empty `actionsTaken`/`proposedFixes` is a valid, complete answer.
```

- [ ] **Step 2: Bake it into the image**

In `images/agent-runner/Dockerfile`, add before the `USER 1000` line (so the copy can be owned by that UID):

```dockerfile
COPY --chown=1000:1000 skills/platform-ops /home/node/.claude/skills/platform-ops
```

- [ ] **Step 3: Verify the image still builds and the file lands where expected**

Run:

```bash
docker build -t agent-runner-test images/agent-runner
docker run --rm agent-runner-test cat /home/node/.claude/skills/platform-ops/SKILL.md
```

Expected: build succeeds; the `cat` prints the skill content.

- [ ] **Step 4: Commit**

```bash
git add images/agent-runner/skills/platform-ops/SKILL.md images/agent-runner/Dockerfile
git commit -m "feat(agent-runner): bake in the platform-ops skill"
```

---

## Task 15: Chart — ServiceAccount, read-only ClusterRole, and NetworkPolicy for the `platform` role

**Files:**
- Create: `charts/engine/templates/platform-agent-serviceaccount.yaml`
- Create: `charts/engine/templates/platform-agent-clusterrole.yaml`
- Create: `charts/engine/templates/platform-agent-clusterrolebinding.yaml`
- Create: `charts/engine/templates/platform-agent-networkpolicy.yaml`
- Modify: `charts/engine/values.yaml`
- Modify: `charts/engine/templates/deployment.yaml`
- Modify: `charts/engine/tests/render.golden.yaml`

- [ ] **Step 1: Add new chart values**

In `charts/engine/values.yaml`, add near `claudeAuthSecretName`/`piAuthSecretName`:

```yaml
claudeAuthSecretName: claude-credentials
piAuthSecretName: pi-credentials

# The platform role (docs/superpowers/specs/2026-07-07-platform-agent-design.md)
# needs credentials devCycle's claude/pi Jobs don't: Temporal REST/action creds
# and Grafana basic auth, bundled by agentops-platform into one Secret with
# whatever keys the platform-ops skill's toolbelt expects (TEMPORAL_HOST,
# GRAFANA_HOST, GRAFANA_USER, GRAFANA_PASSWORD). Empty by default -- same
# "chart ships no cluster assumption" pattern as otelExporterOtlpEndpoint.
platformAgentSecretName: ""
```

- [ ] **Step 2: Add the ServiceAccount**

Create `charts/engine/templates/platform-agent-serviceaccount.yaml`:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ .Release.Name }}-platform-agent
  namespace: {{ .Values.namespace }}
```

- [ ] **Step 3: Add the read-only ClusterRole**

Create `charts/engine/templates/platform-agent-clusterrole.yaml`:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: {{ .Release.Name }}-platform-agent
rules:
  - apiGroups: [""]
    resources: ["pods", "events", "nodes"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets"]
    verbs: ["get", "list", "watch"]
```

- [ ] **Step 4: Add the ClusterRoleBinding**

Create `charts/engine/templates/platform-agent-clusterrolebinding.yaml`:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: {{ .Release.Name }}-platform-agent
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: {{ .Release.Name }}-platform-agent
subjects:
  - kind: ServiceAccount
    name: {{ .Release.Name }}-platform-agent
    namespace: {{ .Values.namespace }}
```

(A ClusterRole bound only to this one namespaced ServiceAccount, not every ServiceAccount cluster-wide — node-level reads require a ClusterRole since `nodes` is a cluster-scoped resource, but the binding itself stays narrow.)

- [ ] **Step 5: Add the NetworkPolicy**

Create `charts/engine/templates/platform-agent-networkpolicy.yaml`:

```yaml
# Standard Kubernetes NetworkPolicy can't match by hostname/FQDN, only by
# port and podSelector/namespaceSelector/ipBlock -- and Temporal, Grafana,
# forge, and LiteLLM/provider endpoints are all reached over HTTPS from this
# role's Job today (see 2026-07-07-platform-agent-design.md §6), some through
# the same public-style ingress hostnames debug-devcycle-issue already uses.
# Port-scoping to DNS + HTTPS is the practical equivalent of "only these
# services" without assuming a CNI capable of FQDN-based policy; revisit with
# namespaceSelector rules once ARCHITECTURE.md's internal *.lab DNS zone (§5.1)
# is in place for Temporal/Grafana specifically.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ .Release.Name }}-platform-agent
  namespace: {{ .Values.namespace }}
spec:
  podSelector:
    matchLabels:
      agentops/role: platform-agent
  policyTypes:
    - Egress
  egress:
    - ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
    - ports:
        - protocol: TCP
          port: 443
```

- [ ] **Step 6: Wire the ServiceAccount name and secret env var into the worker deployment**

The Job's `serviceAccountName`/`additionalSecretNames` are read from env vars by `packages/worker/src/main.ts` (Task 8: `PLATFORM_AGENT_SERVICE_ACCOUNT`, `PLATFORM_AGENT_SECRET_NAME`). Add them in `charts/engine/templates/deployment.yaml`, next to `PI_AUTH_SECRET_NAME`:

```yaml
            - name: PI_AUTH_SECRET_NAME
              value: {{ .Values.piAuthSecretName | quote }}
            - name: PLATFORM_AGENT_SERVICE_ACCOUNT
              value: {{ printf "%s-platform-agent" .Release.Name | quote }}
            {{- if .Values.platformAgentSecretName }}
            - name: PLATFORM_AGENT_SECRET_NAME
              value: {{ .Values.platformAgentSecretName | quote }}
            {{- end }}
```

Note the `platform` role's Job pods still need the `agentops/role: platform-agent` label the NetworkPolicy selects on — `buildAgentJob` (Task 7) doesn't currently set custom pod-template labels at all. Add that now: in `packages/backends/src/k8s/k8s-job-runner.ts`, extend `K8sJobRunnerOptions` with `podLabels?: Record<string, string>`, thread it into `buildAgentJob`'s `template.metadata.labels`, and pass `{ 'agentops/role': 'platform-agent' }` from the `platform` backend's `buildJobRunnerOptions(...)` call in `packages/worker/src/main.ts` (Task 8). This needs `V1Job`'s `template` type in `packages/backends/src/k8s/k8s-types.ts` to gain `metadata?: { labels?: Record<string, string> }`. Add a `buildAgentJob` test asserting `job.spec?.template?.metadata?.labels` equals the passed `podLabels` when set, and is `undefined` when omitted (matching the `serviceAccountName` test style from Task 7) before wiring it through — this is a small addendum to Task 7's file, done here because the NetworkPolicy's dependency on it wasn't apparent until this task.

- [ ] **Step 7: Regenerate the golden file**

Run:

```bash
cd charts/engine
helm template engine . --namespace dev-agents > tests/render.golden.yaml
cd ../..
```

- [ ] **Step 8: Verify the golden-file test passes and inspect the diff**

Run: `bash charts/engine/tests/run.sh`
Expected: PASS (no diff, since the golden file was just regenerated from the same template).

Run: `git diff charts/engine/tests/render.golden.yaml` and read it — confirm the only changes are the new ServiceAccount/ClusterRole/ClusterRoleBinding/NetworkPolicy resources and the two new env vars on the worker Deployment; nothing about the existing `agent-jobs` Role/RoleBinding or `claude`/`pi` env vars should have changed.

- [ ] **Step 9: Commit**

```bash
git add charts/engine/templates/platform-agent-serviceaccount.yaml charts/engine/templates/platform-agent-clusterrole.yaml charts/engine/templates/platform-agent-clusterrolebinding.yaml charts/engine/templates/platform-agent-networkpolicy.yaml charts/engine/values.yaml charts/engine/templates/deployment.yaml charts/engine/tests/render.golden.yaml packages/backends/src/k8s/k8s-types.ts packages/backends/src/k8s/k8s-job-runner.ts packages/backends/src/k8s/k8s-job-runner.test.ts packages/worker/src/main.ts
git commit -m "feat(chart): RBAC, ServiceAccount, and NetworkPolicy for the platform role"
```

---

## Task 16: Update `MILESTONES.md`'s M6 entry

**Files:**
- Modify: `docs/MILESTONES.md`

- [ ] **Step 1: Add a note to the M6 section**

In `docs/MILESTONES.md`, under the `## M6 — Self-healing → Phase 2 gate` heading, add a status note (matching the style of the existing `**Status (...):**` notes on M2/M3/M5):

```markdown
## M6 — Self-healing → Phase 2 gate

`Heal` workflow auto-starts on `blocked`/`failed`; GlitchTip → `ProdErrorTriage` → auto-filed issue → DevCycle with incident profile.

**Done when:** an injected agent failure and an injected prod exception each end in a merged fix or a well-reasoned human escalation.

**Status (2026-07-07):** the manually-triggered `platform` workflow ([design](superpowers/specs/2026-07-07-platform-agent-design.md), [plan](superpowers/plans/2026-07-07-platform-agent.md)) generalizes this milestone's diagnosis-and-fix capability — same "read Temporal history + logs, fix via a devCycle PR" shape, just prompted by a human instead of auto-triggered. When this milestone starts, `Heal`'s auto-trigger should be a thin signal handler that starts a `platform` run with a synthesized prompt on `blocked`/`failed`, not a second diagnosis pipeline built from scratch.
```

- [ ] **Step 2: Commit**

```bash
git add docs/MILESTONES.md
git commit -m "docs: note platform workflow's relationship to M6 Heal"
```

---

## Task 17: Open the PR, pass CI, and resolve the Bugbot review

**Files:** none (integration / review).

> Sequential and partly asynchronous — CI and Bugbot run on the remote PR.
> **HARD GATE: Do not mark this task complete until ALL Bugbot comments are
> resolved (fixed or replied to) AND CI is green. Check with
> `gh pr view --json reviews,comments` before claiming done.**

- [ ] **Step 1: Sync the latest `main`**

```bash
git fetch origin
git merge origin/main
pnpm lint && pnpm typecheck && pnpm test && pnpm e2e && bash charts/engine/tests/run.sh   # resolve conflicts + commit first if any; fix fallout
```

- [ ] **Step 2: Push and open the PR**

```bash
git status --short && git rev-parse --abbrev-ref HEAD   # clean tree, on feature branch (not main)
git push -u origin HEAD
gh pr create --base main --fill --title "feat: add the platform agent workflow"
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
pnpm lint && pnpm typecheck && pnpm test && pnpm e2e && bash charts/engine/tests/run.sh   # suite green locally
```
Confirm no unresolved review threads remain, then mark this task complete.
