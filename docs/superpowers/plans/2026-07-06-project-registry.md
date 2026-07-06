# Project Registry & Per-Project GitHub Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single global `GITHUB_TOKEN` (shared by every product/repo the worker fleet ever touches) with a typed **project registry** — one GitHub token per product — so the worker can safely serve multiple repos, and onboarding a new repo becomes config + secret + redeploy instead of an engine code change.

**Architecture:** A new `ProjectRegistry` contract (`packages/contracts`) is validated and loaded from a `PROJECT_REGISTRY_JSON` env var plus one `GITHUB_TOKEN__<PRODUCT>` env var per project (`packages/activities/src/load-project-registry.ts`). The worker builds one `GithubScmPort`/`GithubTrackerPort`/`GitCommandRunner` triple per registered repo (constructed by the wiring layer, since `packages/ports` cannot depend on `packages/activities`) and routes every call through a new `createProjectScopedPorts` dispatcher (`packages/ports`) keyed by repo. The one call that didn't already carry enough repo information to route on — `ScmPort.push` — gains a `repo` parameter. The CLI, targeting one repo per invocation, skips the dispatcher and resolves a single registry entry directly. The chart renders the registry and per-project secrets via Helm's `range`.

**Tech Stack:** TypeScript strict, zod, vitest, Helm.

**Design doc:** [docs/superpowers/specs/2026-07-06-project-registry-design.md](../specs/2026-07-06-project-registry-design.md)

**Task order matters:** Task 3 (the `push` signature change) must land before Task 6 (`createProjectScopedPorts`, which calls the new 4-arg `push`). Tasks 1→2→(3,5)→6→(7,8)→9→10→11→12 is a safe sequence; 3 and 5 don't depend on each other and could be done in either order.

---

### Task 1: `ProjectRegistry` contract

**Files:**
- Create: `packages/contracts/src/project-registry.ts`
- Test: `packages/contracts/src/project-registry.test.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/contracts/src/project-registry.test.ts
import { describe, expect, it } from 'vitest';
import { InvalidProjectRegistryError, parseProjectRegistry, ProjectRegistrySchema } from './project-registry';

const validEntry = {
  product: 'product-a',
  repo: 'flair-hr/product-a',
  trackerType: 'github',
  tokenEnvVar: 'GITHUB_TOKEN__PRODUCT_A',
};

describe('ProjectRegistrySchema', () => {
  it('parses an array of valid entries', () => {
    expect(ProjectRegistrySchema.parse([validEntry])).toEqual([validEntry]);
  });

  it('rejects a trackerType other than github', () => {
    expect(() => ProjectRegistrySchema.parse([{ ...validEntry, trackerType: 'gitea' }])).toThrow();
  });

  it('rejects a non-array', () => {
    expect(() => ProjectRegistrySchema.parse(validEntry)).toThrow();
  });

  it('rejects an entry missing a required field', () => {
    const { tokenEnvVar: _tokenEnvVar, ...withoutTokenEnvVar } = validEntry;
    expect(() => ProjectRegistrySchema.parse([withoutTokenEnvVar])).toThrow();
  });
});

describe('parseProjectRegistry', () => {
  it('returns an empty array for an empty registry', () => {
    expect(parseProjectRegistry([])).toEqual([]);
  });

  it('passes through a valid registry with distinct products/repos/tokenEnvVars', () => {
    const second = {
      product: 'product-b',
      repo: 'flair-hr/product-b',
      trackerType: 'github',
      tokenEnvVar: 'GITHUB_TOKEN__PRODUCT_B',
    };
    expect(parseProjectRegistry([validEntry, second])).toEqual([validEntry, second]);
  });

  it('throws InvalidProjectRegistryError on a schema violation', () => {
    expect(() =>
      parseProjectRegistry([{ product: '', repo: 'x', trackerType: 'github', tokenEnvVar: 'X' }]),
    ).toThrow(InvalidProjectRegistryError);
  });

  it('throws InvalidProjectRegistryError on a non-array', () => {
    expect(() => parseProjectRegistry(validEntry)).toThrow(InvalidProjectRegistryError);
  });

  it('throws naming a duplicate product', () => {
    const duplicate = { ...validEntry, repo: 'flair-hr/other-repo', tokenEnvVar: 'GITHUB_TOKEN__OTHER' };
    expect(() => parseProjectRegistry([validEntry, duplicate])).toThrow(/duplicate product "product-a"/);
  });

  it('throws naming a duplicate repo', () => {
    const duplicate = { ...validEntry, product: 'product-c', tokenEnvVar: 'GITHUB_TOKEN__OTHER' };
    expect(() => parseProjectRegistry([validEntry, duplicate])).toThrow(/duplicate repo "flair-hr\/product-a"/);
  });

  it('throws naming a duplicate tokenEnvVar', () => {
    const duplicate = { ...validEntry, product: 'product-c', repo: 'flair-hr/other-repo' };
    expect(() => parseProjectRegistry([validEntry, duplicate])).toThrow(
      /duplicate tokenEnvVar "GITHUB_TOKEN__PRODUCT_A"/,
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/contracts/src/project-registry.test.ts`
Expected: FAIL — `Cannot find module './project-registry'`.

- [ ] **Step 3: Implement**

```ts
// packages/contracts/src/project-registry.ts
import { z, ZodError } from 'zod';

export const ProjectRegistryEntrySchema = z.object({
  product: z.string().min(1),
  repo: z.string().min(1),
  trackerType: z.literal('github'),
  tokenEnvVar: z.string().min(1),
});
export type ProjectRegistryEntry = z.infer<typeof ProjectRegistryEntrySchema>;

export const ProjectRegistrySchema = z.array(ProjectRegistryEntrySchema);
export type ProjectRegistry = z.infer<typeof ProjectRegistrySchema>;

// Not zod-validated (constructed programmatically, never parsed from raw input) — lives
// here, not in packages/activities, so both loadProjectRegistry (activities) and the
// worker/cli wiring layer can share one type without packages/ports depending on
// packages/activities.
export interface ResolvedProjectEntry extends ProjectRegistryEntry {
  token: string;
}

export class InvalidProjectRegistryError extends Error {
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

function findDuplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }
  return undefined;
}

export function parseProjectRegistry(raw: unknown): ProjectRegistry {
  let registry: ProjectRegistry;
  try {
    registry = ProjectRegistrySchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new InvalidProjectRegistryError(formatZodError(err), err.issues);
    }
    throw err;
  }

  const duplicateProduct = findDuplicate(registry.map((entry) => entry.product));
  if (duplicateProduct) {
    throw new InvalidProjectRegistryError(`duplicate product "${duplicateProduct}" in project registry`);
  }
  const duplicateRepo = findDuplicate(registry.map((entry) => entry.repo));
  if (duplicateRepo) {
    throw new InvalidProjectRegistryError(`duplicate repo "${duplicateRepo}" in project registry`);
  }
  const duplicateTokenEnvVar = findDuplicate(registry.map((entry) => entry.tokenEnvVar));
  if (duplicateTokenEnvVar) {
    throw new InvalidProjectRegistryError(`duplicate tokenEnvVar "${duplicateTokenEnvVar}" in project registry`);
  }

  return registry;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/contracts/src/project-registry.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Export from the package barrel**

Modify `packages/contracts/src/index.ts` — add one line at the end:

```ts
export * from './stage';
export * from './model';
export * from './product-config';
export * from './task-input';
export * from './stage-result';
export * from './verdict';
export * from './agent-run';
export * from './run-stats';
export * from './pr-feedback';
export * from './project-registry';
```

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm --filter @agentops/contracts run typecheck
git add packages/contracts/src/project-registry.ts packages/contracts/src/project-registry.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): add ProjectRegistry schema and parseProjectRegistry"
```

---

### Task 2: `loadProjectRegistry`

**Files:**
- Create: `packages/activities/src/load-project-registry.ts`
- Test: `packages/activities/src/load-project-registry.test.ts`
- Modify: `packages/activities/src/index.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/activities/src/load-project-registry.test.ts
import { describe, expect, it } from 'vitest';
import { loadProjectRegistry } from './load-project-registry';

describe('loadProjectRegistry', () => {
  it('returns an empty array when PROJECT_REGISTRY_JSON is unset', () => {
    expect(loadProjectRegistry({})).toEqual([]);
  });

  it("resolves each entry's token from its tokenEnvVar", () => {
    const env = {
      PROJECT_REGISTRY_JSON: JSON.stringify([
        { product: 'product-a', repo: 'flair-hr/product-a', trackerType: 'github', tokenEnvVar: 'GITHUB_TOKEN__PRODUCT_A' },
      ]),
      GITHUB_TOKEN__PRODUCT_A: 'ghp_fake',
    };

    expect(loadProjectRegistry(env)).toEqual([
      {
        product: 'product-a',
        repo: 'flair-hr/product-a',
        trackerType: 'github',
        tokenEnvVar: 'GITHUB_TOKEN__PRODUCT_A',
        token: 'ghp_fake',
      },
    ]);
  });

  it('throws naming the product and env var when a referenced tokenEnvVar is missing', () => {
    const env = {
      PROJECT_REGISTRY_JSON: JSON.stringify([
        { product: 'product-a', repo: 'flair-hr/product-a', trackerType: 'github', tokenEnvVar: 'GITHUB_TOKEN__PRODUCT_A' },
      ]),
    };

    expect(() => loadProjectRegistry(env)).toThrow(/"GITHUB_TOKEN__PRODUCT_A".*"product-a"/);
  });

  it('throws on a malformed PROJECT_REGISTRY_JSON', () => {
    expect(() => loadProjectRegistry({ PROJECT_REGISTRY_JSON: '{}' })).toThrow();
  });

  it('resolves multiple entries independently', () => {
    const env = {
      PROJECT_REGISTRY_JSON: JSON.stringify([
        { product: 'product-a', repo: 'flair-hr/product-a', trackerType: 'github', tokenEnvVar: 'GITHUB_TOKEN__PRODUCT_A' },
        { product: 'product-b', repo: 'flair-hr/product-b', trackerType: 'github', tokenEnvVar: 'GITHUB_TOKEN__PRODUCT_B' },
      ]),
      GITHUB_TOKEN__PRODUCT_A: 'token-a',
      GITHUB_TOKEN__PRODUCT_B: 'token-b',
    };

    const resolved = loadProjectRegistry(env);

    expect(resolved.map((entry) => entry.token)).toEqual(['token-a', 'token-b']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/activities/src/load-project-registry.test.ts`
Expected: FAIL — `Cannot find module './load-project-registry'`.

- [ ] **Step 3: Implement**

```ts
// packages/activities/src/load-project-registry.ts
import { parseProjectRegistry, type ResolvedProjectEntry } from '@agentops/contracts';

export function loadProjectRegistry(env: NodeJS.ProcessEnv = process.env): ResolvedProjectEntry[] {
  const raw = env.PROJECT_REGISTRY_JSON;
  if (!raw) {
    return [];
  }
  const registry = parseProjectRegistry(JSON.parse(raw));
  return registry.map((entry) => {
    const token = env[entry.tokenEnvVar];
    if (!token) {
      throw new Error(`loadProjectRegistry: env var "${entry.tokenEnvVar}" for product "${entry.product}" is not set`);
    }
    return { ...entry, token };
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/activities/src/load-project-registry.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Export from the package barrel**

Modify `packages/activities/src/index.ts`:

```ts
export * from './load-env';
export * from './load-project-registry';
export * from './stats-store';
export * from './stage-result-store';
export * from './create-activities';
export * from './workspace/spawn-git-command-runner';
export * from './workspace/workspace-manager';
export * from './workspace/memory-workspace-manager';
```

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm --filter @agentops/activities run typecheck
git add packages/activities/src/load-project-registry.ts packages/activities/src/load-project-registry.test.ts packages/activities/src/index.ts
git commit -m "feat(activities): add loadProjectRegistry"
```

---

### Task 3: `ScmPort.push` gains a `repo` parameter

**Files:**
- Modify: `packages/ports/src/scm-port.ts`
- Modify: `packages/ports/src/github/github-scm-port.ts`
- Modify: `packages/ports/src/github/github-scm-port.test.ts`
- Modify: `packages/ports/src/memory/memory-scm.ts`
- Modify: `packages/ports/src/memory/memory-scm.test.ts`

This is the one `ScmPort` method that doesn't already carry enough repo information for the dispatcher built in Task 6 to route it — `workspaceRef` is an opaque local path, not repo-derived.

- [ ] **Step 1: Update the failing tests first**

In `packages/ports/src/github/github-scm-port.test.ts`, replace the `GithubScmPort — push` block (the calls to `scm.push` are missing the new leading `repo` argument):

```ts
describe('GithubScmPort — push', () => {
  it('runs git push origin <branch> in the given workspace, with no token handling here', async () => {
    const client = fakeClient();
    const { git, calls } = fakeGit();
    const scm = new GithubScmPort(client, git);

    await scm.push('octocat/hello-world', '/tmp/workspace', 'agentops/t1', 'hash-1');

    expect(calls).toEqual([{ args: ['push', 'origin', 'agentops/t1'], cwd: '/tmp/workspace' }]);
  });

  it('throws if the push fails', async () => {
    const client = fakeClient();
    const git: GitCommandRunner = { run: vi.fn().mockResolvedValue({ stdout: '', stderr: 'rejected', exitCode: 1 }) };
    const scm = new GithubScmPort(client, git);

    await expect(scm.push('octocat/hello-world', '/tmp/workspace', 'agentops/t1', 'hash-1')).rejects.toThrow(/rejected/);
  });
});
```

In `packages/ports/src/memory/memory-scm.test.ts`, replace the push test:

```ts
  it('push accepts and ignores repo/workspaceRef (real git happens in the real adapter, not here)', async () => {
    const scm = new MemoryScmPort();
    await expect(scm.push('demo/repo', '/some/workspace/path', 'branch-x', 'hash-x')).resolves.toBeUndefined();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm exec vitest run packages/ports/src/github/github-scm-port.test.ts packages/ports/src/memory/memory-scm.test.ts
```
Expected: FAIL — `push` calls now pass 4 arguments against a 3-arg signature (a TS type error at test-run time via vitest's esbuild transform, or a runtime mismatch — either way, red).

- [ ] **Step 3: Update the `ScmPort` interface**

```ts
// packages/ports/src/scm-port.ts
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
  push(repo: string, workspaceRef: string, branch: string, contentHash: string): Promise<void>;
  readFile(repo: string, path: string): Promise<string | null>;
}
```

- [ ] **Step 4: Update `GithubScmPort.push`**

In `packages/ports/src/github/github-scm-port.ts`, replace the `push` method (`repo` is unused inside — the clone at `workspaceRef` already points at the right remote — but required so the Task 6 dispatcher knows which project's port instance to call):

```ts
  async push(_repo: string, workspaceRef: string, branch: string, _contentHash: string): Promise<void> {
    const result = await this.git.run(['push', 'origin', branch], { cwd: workspaceRef });
    if (result.exitCode !== 0) {
      throw new Error(`GithubScmPort.push: git push failed: ${result.stderr}`);
    }
  }
```

- [ ] **Step 5: Update `MemoryScmPort.push`**

In `packages/ports/src/memory/memory-scm.ts`, replace the `push` method:

```ts
  async push(_repo: string, _workspaceRef: string, _branch: string, _contentHash: string): Promise<void> {}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm exec vitest run packages/ports/src/github/github-scm-port.test.ts packages/ports/src/memory/memory-scm.test.ts
```
Expected: PASS (all tests in both files, 12 + 6).

- [ ] **Step 7: Typecheck the whole package (other callers haven't been updated yet — expect errors, that's Task 4)**

```bash
pnpm --filter @agentops/ports run typecheck
```
Expected: PASS — nothing inside `packages/ports` itself calls `push` outside what was just changed. (Callers in `packages/activities`/`packages/workflows` are updated in Task 4; don't run the root `pnpm typecheck` yet.)

- [ ] **Step 8: Commit**

```bash
git add packages/ports/src/scm-port.ts packages/ports/src/github/github-scm-port.ts packages/ports/src/github/github-scm-port.test.ts packages/ports/src/memory/memory-scm.ts packages/ports/src/memory/memory-scm.test.ts
git commit -m "feat(ports): add repo parameter to ScmPort.push"
```

---

### Task 4: Thread `repo` through the `pushBranch` activity and its workflow call site

**Files:**
- Modify: `packages/workflows/src/activities-api.ts`
- Modify: `packages/workflows/src/dev-cycle.ts`
- Modify: `packages/activities/src/create-activities.ts`
- Modify: `packages/activities/src/create-activities.test.ts`

- [ ] **Step 1: Update the failing test first**

In `packages/activities/src/create-activities.test.ts`, in the `'openPr/getPrFeedback/pushBranch delegate to the scm port'` test, update the `pushBranch` call:

```ts
  it('openPr/getPrFeedback/pushBranch delegate to the scm port', async () => {
    const deps = buildDeps();
    const activities = createActivities(deps);
    const { prRef } = await activities.openPr({ repo: 'demo/repo', branch: 'b', title: 't', body: 'b' });
    deps.scm.scriptFeedback(prRef, [{ ciStatus: 'green', unresolvedThreads: 0, comments: [] }]);
    await expect(activities.getPrFeedback(prRef)).resolves.toMatchObject({ ciStatus: 'green' });
    await expect(activities.pushBranch('demo/repo', '/some/workspace', 'branch', 'hash')).resolves.toBeUndefined();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm exec vitest run packages/activities/src/create-activities.test.ts
```
Expected: FAIL — `pushBranch` still takes 3 args.

- [ ] **Step 3: Update the `DevCycleActivities` interface**

In `packages/workflows/src/activities-api.ts`, change the `pushBranch` line:

```ts
  pushBranch(repo: string, workspaceRef: string, branch: string, contentHash: string): Promise<void>;
```

- [ ] **Step 4: Update the `pushBranch` activity implementation**

In `packages/activities/src/create-activities.ts`, replace the `pushBranch` method:

```ts
    async pushBranch(repo: string, workspaceRef: string, branch: string, contentHash: string): Promise<void> {
      await deps.scm.push(repo, workspaceRef, branch, contentHash);
    },
```

- [ ] **Step 5: Update the workflow call site**

In `packages/workflows/src/dev-cycle.ts`, update the `pushBranch` call (around line 314):

```ts
      await activities.pushBranch(input.repo, state.workspaceRef, state.branch, `${input.taskId}-${implementAttempt}`);
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm exec vitest run packages/activities/src/create-activities.test.ts
pnpm --filter @agentops/workflows run typecheck
pnpm --filter @agentops/activities run typecheck
```
Expected: all PASS.

- [ ] **Step 7: Run the e2e suite (dev-cycle's push call site is only exercised there)**

```bash
pnpm e2e
```
Expected: PASS — the happy-path e2e scenario exercises the babysit fix-round `pushBranch` call.

- [ ] **Step 8: Commit**

```bash
git add packages/workflows/src/activities-api.ts packages/workflows/src/dev-cycle.ts packages/activities/src/create-activities.ts packages/activities/src/create-activities.test.ts
git commit -m "feat(workflows,activities): thread repo through the pushBranch activity"
```

---

### Task 5: `WorkspaceManager` — `git` becomes `resolveGit`

**Files:**
- Modify: `packages/activities/src/workspace/workspace-manager.ts`
- Modify: `packages/activities/src/workspace/workspace-manager.test.ts`

- [ ] **Step 1: Update the existing tests first**

In `packages/activities/src/workspace/workspace-manager.test.ts`, update `buildManager` and the "never writes the auth token" test to pass `resolveGit` instead of `git`:

```ts
function buildManager(): { manager: WorkspaceManager; gitCalls: string[][] } {
  const real = new SpawnGitCommandRunner();
  const gitCalls: string[][] = [];
  const recording = {
    run: (args: string[], opts: { cwd: string }) => {
      gitCalls.push(args);
      return real.run(args, opts);
    },
  };
  const manager = new WorkspaceManager({ resolveGit: () => recording, cacheDir, workspacesDir, cloneUrl: () => remoteDir });
  return { manager, gitCalls };
}
```

```ts
  it('never writes the auth token into the cached clone config', async () => {
    const git = new SpawnGitCommandRunner({ authToken: () => 'super-secret' });
    const manager = new WorkspaceManager({ resolveGit: () => git, cacheDir, workspacesDir, cloneUrl: () => remoteDir });

    await manager.prepare('task-1', 'owner/repo');

    const config = readFileSync(join(cacheDir, 'owner-repo', '.git', 'config'), 'utf8');
    expect(config).not.toContain('super-secret');
  });
```

Then add a new test at the end of the `describe('WorkspaceManager', ...)` block, proving routing (not just the signature change) — it sets up a second git remote and asserts each repo's `prepare()` call lands on its own resolved runner:

```ts
  it('routes each repo to its own resolved git runner', async () => {
    const remoteDirB = join(root, 'remote-b');
    execFileSync('git', ['init', '-b', 'main', remoteDirB]);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: remoteDirB });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: remoteDirB });
    writeFileSync(join(remoteDirB, 'README.md'), 'hello-b');
    execFileSync('git', ['add', 'README.md'], { cwd: remoteDirB });
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: remoteDirB });

    const real = new SpawnGitCommandRunner();
    const callsA: string[][] = [];
    const callsB: string[][] = [];
    const runnerA = {
      run: (args: string[], opts: { cwd: string }) => {
        callsA.push(args);
        return real.run(args, opts);
      },
    };
    const runnerB = {
      run: (args: string[], opts: { cwd: string }) => {
        callsB.push(args);
        return real.run(args, opts);
      },
    };

    const manager = new WorkspaceManager({
      resolveGit: (repo) => (repo === 'owner/repo-a' ? runnerA : runnerB),
      cacheDir,
      workspacesDir,
      cloneUrl: (repo) => (repo === 'owner/repo-a' ? remoteDir : remoteDirB),
    });

    await manager.prepare('task-a', 'owner/repo-a');
    await manager.prepare('task-b', 'owner/repo-b');

    expect(callsA.map((args) => args[0])).toEqual(['clone', 'worktree']);
    expect(callsB.map((args) => args[0])).toEqual(['clone', 'worktree']);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm exec vitest run packages/activities/src/workspace/workspace-manager.test.ts
```
Expected: FAIL — `WorkspaceManagerOptions` has no `resolveGit` field yet (type error) and the new test can't pass against the old single-`git` implementation.

- [ ] **Step 3: Implement**

Replace the full contents of `packages/activities/src/workspace/workspace-manager.ts`:

```ts
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GitCommandRunner } from '@agentops/ports';

export interface WorkspaceManagerOptions {
  resolveGit: (repo: string) => GitCommandRunner;
  cacheDir?: string;
  workspacesDir?: string;
  cloneUrl: (repo: string) => string;
}

export interface PreparedWorkspace {
  workspaceRef: string;
  branch: string;
  baseBranch: string;
}

export interface Workspaces {
  prepare(taskId: string, repo: string): Promise<PreparedWorkspace>;
  cleanup(workspaceRef: string, repo: string): Promise<void>;
}

export class WorkspaceError extends Error {}

function sanitizeRepoSlug(repo: string): string {
  return repo.replace(/[^a-zA-Z0-9-]/g, '-');
}

export class WorkspaceManager implements Workspaces {
  private readonly resolveGit: (repo: string) => GitCommandRunner;
  private readonly cacheDir: string;
  private readonly workspacesDir: string;
  private readonly cloneUrl: (repo: string) => string;

  constructor(opts: WorkspaceManagerOptions) {
    this.resolveGit = opts.resolveGit;
    this.cacheDir = opts.cacheDir ?? join(homedir(), '.agentops', 'cache');
    this.workspacesDir = opts.workspacesDir ?? join(homedir(), '.agentops', 'workspaces');
    this.cloneUrl = opts.cloneUrl;
  }

  async prepare(taskId: string, repo: string): Promise<PreparedWorkspace> {
    const git = this.resolveGit(repo);
    await mkdir(this.cacheDir, { recursive: true });
    await mkdir(this.workspacesDir, { recursive: true });
    const cachePath = join(this.cacheDir, sanitizeRepoSlug(repo));
    await this.ensureBaseClone(git, cachePath, repo);
    const baseBranch = await this.detectDefaultBranch(git, cachePath);
    const branch = `agentops/${taskId}`;
    const workspacePath = join(this.workspacesDir, taskId);

    const addResult = await git.run(
      ['worktree', 'add', workspacePath, '-b', branch, `origin/${baseBranch}`],
      { cwd: cachePath },
    );
    if (addResult.exitCode !== 0) {
      throw new WorkspaceError(`git worktree add failed for ${repo}: ${addResult.stderr}`);
    }

    return { workspaceRef: workspacePath, branch, baseBranch };
  }

  async cleanup(workspaceRef: string, repo: string): Promise<void> {
    // Run the removal from the base clone, not from inside workspaceRef itself — a
    // worktree removing its own cwd out from under the running process is fragile and
    // git-version-dependent. The base clone is the stable, always-present "main" worktree.
    const git = this.resolveGit(repo);
    const cachePath = join(this.cacheDir, sanitizeRepoSlug(repo));
    const result = await git.run(['worktree', 'remove', workspaceRef, '--force'], {
      cwd: cachePath,
    });
    if (result.exitCode !== 0) {
      throw new WorkspaceError(`git worktree remove failed for ${workspaceRef}: ${result.stderr}`);
    }
  }

  private async ensureBaseClone(git: GitCommandRunner, cachePath: string, repo: string): Promise<void> {
    // Check with a plain fs call, not a git invocation with `cwd: cachePath` — spawning
    // git with a cwd that doesn't exist yet (the "not cloned yet" case, which is exactly
    // what we're distinguishing here) fails at the OS level, not as a normal git error.
    if (existsSync(cachePath)) {
      const fetchResult = await git.run(['fetch', 'origin'], { cwd: cachePath });
      if (fetchResult.exitCode !== 0) {
        throw new WorkspaceError(`git fetch failed for ${repo}: ${fetchResult.stderr}`);
      }
      return;
    }
    const cloneResult = await git.run(['clone', this.cloneUrl(repo), cachePath], { cwd: this.cacheDir });
    if (cloneResult.exitCode !== 0) {
      throw new WorkspaceError(`git clone failed for ${repo}: ${cloneResult.stderr}`);
    }
  }

  private async detectDefaultBranch(git: GitCommandRunner, cachePath: string): Promise<string> {
    const result = await git.run(['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: cachePath });
    if (result.exitCode !== 0) {
      throw new WorkspaceError(`could not detect default branch in ${cachePath}: ${result.stderr}`);
    }
    const ref = result.stdout.trim();
    const branch = ref.split('/').pop();
    if (!branch) {
      throw new WorkspaceError(`unexpected symbolic-ref output: "${ref}"`);
    }
    return branch;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm exec vitest run packages/activities/src/workspace/workspace-manager.test.ts
```
Expected: PASS (all 5 tests, including the new routing test).

- [ ] **Step 5: Typecheck (worker's `main.ts` still constructs `WorkspaceManager` with `git` — expect an error there; that's fixed in Task 7)**

```bash
pnpm --filter @agentops/activities run typecheck
```
Expected: PASS (this package alone).

- [ ] **Step 6: Commit**

```bash
git add packages/activities/src/workspace/workspace-manager.ts packages/activities/src/workspace/workspace-manager.test.ts
git commit -m "feat(activities): WorkspaceManager resolves a GitCommandRunner per repo"
```

---

### Task 6: `createProjectScopedPorts` dispatcher

**Files:**
- Create: `packages/ports/src/github/project-scoped-ports.ts`
- Test: `packages/ports/src/github/project-scoped-ports.test.ts`
- Modify: `packages/ports/src/index.ts`

Depends on Task 3 (`push` takes `repo` first). This dispatcher has zero GitHub-specific knowledge — it only knows `ScmPort`/`TrackerPort`/`GitCommandRunner` — and zero Octokit knowledge, so it's tested entirely with plain fakes, no real client construction.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/ports/src/github/project-scoped-ports.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { PrFeedback } from '@agentops/contracts';
import type { GitCommandRunner } from '../git/git-command-runner';
import type { ScmPort } from '../scm-port';
import type { TrackerPort } from '../tracker-port';
import { createProjectScopedPorts, type ProjectScopedPortsEntry } from './project-scoped-ports';

function fakeScm(): ScmPort {
  return {
    openPr: vi.fn().mockResolvedValue({ prRef: 'r#1', url: 'https://x' }),
    getPrFeedback: vi.fn().mockResolvedValue({ ciStatus: 'green', unresolvedThreads: 0, comments: [] } satisfies PrFeedback),
    push: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue('content'),
  };
}

function fakeTracker(): TrackerPort {
  return {
    getIssue: vi.fn().mockResolvedValue({ ref: 'r#1', title: 'T', body: 'B', labels: [] }),
    comment: vi.fn().mockResolvedValue(undefined),
    label: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeGit(): GitCommandRunner {
  return { run: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }) };
}

function buildEntry(repo: string): ProjectScopedPortsEntry {
  return { repo, scm: fakeScm(), tracker: fakeTracker(), git: fakeGit() };
}

describe('createProjectScopedPorts', () => {
  it('routes openPr to the entry matching req.repo', async () => {
    const entryA = buildEntry('owner/repo-a');
    const entryB = buildEntry('owner/repo-b');
    const { scm } = createProjectScopedPorts([entryA, entryB]);

    await scm.openPr({ repo: 'owner/repo-b', branch: 'b', title: 't', body: 'b' });

    expect(entryB.scm.openPr).toHaveBeenCalledTimes(1);
    expect(entryA.scm.openPr).not.toHaveBeenCalled();
  });

  it('routes getPrFeedback/getIssue/comment/label by the repo parsed from the ref', async () => {
    const entryA = buildEntry('owner/repo-a');
    const entryB = buildEntry('owner/repo-b');
    const { scm, tracker } = createProjectScopedPorts([entryA, entryB]);

    await scm.getPrFeedback('owner/repo-b#7');
    await tracker.getIssue('owner/repo-a#3');
    await tracker.comment('owner/repo-a#3', 'hello');
    await tracker.label('owner/repo-b#7', 'bug');

    expect(entryB.scm.getPrFeedback).toHaveBeenCalledWith('owner/repo-b#7');
    expect(entryA.tracker.getIssue).toHaveBeenCalledWith('owner/repo-a#3');
    expect(entryA.tracker.comment).toHaveBeenCalledWith('owner/repo-a#3', 'hello');
    expect(entryB.tracker.label).toHaveBeenCalledWith('owner/repo-b#7', 'bug');
  });

  it('routes push by the explicit repo argument', async () => {
    const entryA = buildEntry('owner/repo-a');
    const entryB = buildEntry('owner/repo-b');
    const { scm } = createProjectScopedPorts([entryA, entryB]);

    await scm.push('owner/repo-a', '/workspace', 'branch', 'hash');

    expect(entryA.scm.push).toHaveBeenCalledWith('owner/repo-a', '/workspace', 'branch', 'hash');
    expect(entryB.scm.push).not.toHaveBeenCalled();
  });

  it('routes readFile by the explicit repo argument', async () => {
    const entryA = buildEntry('owner/repo-a');
    const { scm } = createProjectScopedPorts([entryA]);

    await scm.readFile('owner/repo-a', 'agentops.json');

    expect(entryA.scm.readFile).toHaveBeenCalledWith('owner/repo-a', 'agentops.json');
  });

  it('resolveGit returns the git runner for the matching repo', () => {
    const entryA = buildEntry('owner/repo-a');
    const entryB = buildEntry('owner/repo-b');
    const { resolveGit } = createProjectScopedPorts([entryA, entryB]);

    expect(resolveGit('owner/repo-b')).toBe(entryB.git);
  });

  it('throws a clear error for a repo not in the registry', async () => {
    const { scm } = createProjectScopedPorts([buildEntry('owner/repo-a')]);

    await expect(scm.readFile('owner/unknown-repo', 'x.json')).rejects.toThrow(
      /no project registered for repo "owner\/unknown-repo"/,
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/ports/src/github/project-scoped-ports.test.ts`
Expected: FAIL — `Cannot find module './project-scoped-ports'`.

- [ ] **Step 3: Implement**

```ts
// packages/ports/src/github/project-scoped-ports.ts
import type { GitCommandRunner } from '../git/git-command-runner';
import type { ScmPort } from '../scm-port';
import type { TrackerPort } from '../tracker-port';
import { parseRef } from './parse-ref';

export interface ProjectScopedPortsEntry {
  repo: string;
  scm: ScmPort;
  tracker: TrackerPort;
  git: GitCommandRunner;
}

export interface ProjectScopedPorts {
  scm: ScmPort;
  tracker: TrackerPort;
  resolveGit: (repo: string) => GitCommandRunner;
}

function repoFromRef(ref: string): string {
  const { owner, repo } = parseRef(ref);
  return `${owner}/${repo}`;
}

export function createProjectScopedPorts(entries: ProjectScopedPortsEntry[]): ProjectScopedPorts {
  const byRepo = new Map(entries.map((entry) => [entry.repo, entry]));

  function resolve(repo: string): ProjectScopedPortsEntry {
    const found = byRepo.get(repo);
    if (!found) {
      throw new Error(`createProjectScopedPorts: no project registered for repo "${repo}" — check the project registry`);
    }
    return found;
  }

  return {
    scm: {
      openPr: (req) => resolve(req.repo).scm.openPr(req),
      getPrFeedback: (prRef) => resolve(repoFromRef(prRef)).scm.getPrFeedback(prRef),
      push: (repo, workspaceRef, branch, contentHash) => resolve(repo).scm.push(repo, workspaceRef, branch, contentHash),
      readFile: (repo, path) => resolve(repo).scm.readFile(repo, path),
    },
    tracker: {
      getIssue: (ref) => resolve(repoFromRef(ref)).tracker.getIssue(ref),
      comment: (ref, body) => resolve(repoFromRef(ref)).tracker.comment(ref, body),
      label: (ref, label) => resolve(repoFromRef(ref)).tracker.label(ref, label),
    },
    resolveGit: (repo) => resolve(repo).git,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/ports/src/github/project-scoped-ports.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Export from the package barrel**

Modify `packages/ports/src/index.ts`:

```ts
export * from './tracker-port';
export * from './scm-port';
export * from './memory/memory-tracker';
export * from './memory/memory-scm';
export * from './git/git-command-runner';
export * from './github/parse-ref';
export * from './github/github-client';
export * from './github/github-tracker-port';
export * from './github/github-scm-port';
export * from './github/build-github-ports';
export * from './github/clone-url';
export * from './github/project-scoped-ports';
```

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm --filter @agentops/ports run typecheck
git add packages/ports/src/github/project-scoped-ports.ts packages/ports/src/github/project-scoped-ports.test.ts packages/ports/src/index.ts
git commit -m "feat(ports): add createProjectScopedPorts dispatcher"
```

---

### Task 7: Worker wiring — `buildActivityDependencies` becomes registry-based

**Files:**
- Modify: `packages/worker/package.json`
- Modify: `packages/worker/src/main.ts`
- Modify: `packages/worker/src/main.test.ts`

- [ ] **Step 1: Add the `@agentops/contracts` dependency**

`main.ts` will need `ResolvedProjectEntry`, a type that lives in `@agentops/contracts` — today the worker only depends on it transitively. Modify `packages/worker/package.json`:

```json
{
  "name": "@agentops/worker",
  "version": "0.0.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "tsc -p tsconfig.json",
    "start": "tsx src/main.ts"
  },
  "dependencies": {
    "@agentops/activities": "workspace:*",
    "@agentops/backends": "workspace:*",
    "@agentops/contracts": "workspace:*",
    "@agentops/ports": "workspace:*",
    "@agentops/prompts": "workspace:*",
    "@agentops/workflows": "workspace:*",
    "@kubernetes/client-node": "^1.3.0",
    "@temporalio/worker": "^1.11.0"
  }
}
```

```bash
pnpm install
```
Expected: `pnpm-lock.yaml` updates, no errors.

- [ ] **Step 2: Update the failing test first**

Replace `packages/worker/src/main.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MemoryWorkspaceManager, WorkspaceManager } from '@agentops/activities';
import { MemoryScmPort, MemoryTrackerPort } from '@agentops/ports';
import { buildActivityDependencies } from './main';

describe('buildActivityDependencies', () => {
  it('uses in-memory ports and workspace manager when the registry is empty', () => {
    const deps = buildActivityDependencies([]);

    expect(deps.scm).toBeInstanceOf(MemoryScmPort);
    expect(deps.tracker).toBeInstanceOf(MemoryTrackerPort);
    expect(deps.workspaces).toBeInstanceOf(MemoryWorkspaceManager);
  });

  it('uses project-scoped ports and a real WorkspaceManager when the registry is non-empty', () => {
    const deps = buildActivityDependencies([
      { product: 'demo', repo: 'octocat/demo', trackerType: 'github', tokenEnvVar: 'GITHUB_TOKEN__DEMO', token: 'fake-token' },
    ]);

    expect(deps.scm).not.toBeInstanceOf(MemoryScmPort);
    expect(deps.tracker).not.toBeInstanceOf(MemoryTrackerPort);
    expect(deps.workspaces).toBeInstanceOf(WorkspaceManager);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm exec vitest run packages/worker/src/main.test.ts
```
Expected: FAIL — `buildActivityDependencies` still takes `string | undefined`.

- [ ] **Step 4: Implement**

Replace the full contents of `packages/worker/src/main.ts`:

```ts
import { NativeConnection } from '@temporalio/worker';
import { BatchV1Api, KubeConfig } from '@kubernetes/client-node';
import {
  createActivities,
  InMemoryStageResultStore,
  InMemoryStatsStore,
  loadEnv,
  loadProjectRegistry,
  MemoryWorkspaceManager,
  SpawnGitCommandRunner,
  WorkspaceManager,
  type Workspaces,
} from '@agentops/activities';

loadEnv();
import {
  batchApiFromClient,
  createClaudeCliSpec,
  createPiCliSpec,
  K8sJobRunner,
  ProcessCliRunner,
  StubBackend,
  type AgentBackend,
} from '@agentops/backends';
import type { ResolvedProjectEntry } from '@agentops/contracts';
import {
  createGithubPorts,
  createProjectScopedPorts,
  githubCloneUrl,
  MemoryScmPort,
  MemoryTrackerPort,
  type ScmPort,
  type TrackerPort,
} from '@agentops/ports';
import { PromptPack } from '@agentops/prompts';
import type { DevCycleActivities } from '@agentops/workflows';
import { createWorker } from './create-worker';

export interface ActivityWiring {
  scm: ScmPort;
  tracker: TrackerPort;
  workspaces: Workspaces;
}

export function buildActivityDependencies(registry: ResolvedProjectEntry[]): ActivityWiring {
  if (registry.length === 0) {
    return { scm: new MemoryScmPort(), tracker: new MemoryTrackerPort(), workspaces: new MemoryWorkspaceManager() };
  }
  const entries = registry.map((entry) => {
    const git = new SpawnGitCommandRunner({ authToken: () => entry.token });
    const { scm, tracker } = createGithubPorts(entry.token, git);
    return { repo: entry.repo, scm, tracker, git };
  });
  const { scm, tracker, resolveGit } = createProjectScopedPorts(entries);
  return { scm, tracker, workspaces: new WorkspaceManager({ resolveGit, cloneUrl: githubCloneUrl }) };
}

export function buildBackends(inCluster: boolean): Record<string, AgentBackend> {
  const agentImage =
    process.env.AGENT_RUNNER_IMAGE ?? 'ghcr.io/CHANGEME/agentops-engine/agent-claude:CHANGEME';
  const claudeSpec = createClaudeCliSpec({ image: agentImage });
  const piSpec = createPiCliSpec();

  if (!inCluster) {
    return {
      stub: new StubBackend(),
      claude: new ProcessCliRunner(claudeSpec),
      pi: new ProcessCliRunner(piSpec),
    };
  }

  const kc = new KubeConfig();
  kc.loadFromCluster();

  return {
    stub: new StubBackend(),
    claude: new K8sJobRunner(claudeSpec, {
      namespace: process.env.AGENT_NAMESPACE ?? 'dev-agents',
      workspacePvcName: process.env.WORKSPACE_PVC_NAME ?? 'workspace-tasks',
      workspaceMountPath: process.env.WORKSPACE_MOUNT_PATH ?? '/workspace/tasks',
      authSecretName: process.env.CLAUDE_AUTH_SECRET_NAME,
      imagePullSecretName: process.env.IMAGE_PULL_SECRET_NAME,
      batchApi: batchApiFromClient(kc.makeApiClient(BatchV1Api)),
    }),
    pi: new ProcessCliRunner(piSpec),
  };
}

async function main(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });

  const registry = loadProjectRegistry();
  const inCluster = Boolean(process.env.KUBERNETES_SERVICE_HOST);
  const { scm, tracker, workspaces } = buildActivityDependencies(registry);
  console.log(
    registry.length > 0
      ? `agentops worker: LIVE mode — ${registry.length} project(s) registered: ${registry
          .map((entry) => `${entry.product} (${entry.repo})`)
          .join(', ')} — real GitHub + real agent CLIs, will spend tokens and open real PRs`
      : 'agentops worker: DEMO mode (no PROJECT_REGISTRY_JSON) — in-memory ports + stub backend only',
  );
  console.log(
    inCluster
      ? 'agentops worker: IN-CLUSTER mode (KUBERNETES_SERVICE_HOST set) — claude runs as K8s Jobs'
      : 'agentops worker: LOCAL mode — claude/pi spawn as local processes',
  );

  const activities: DevCycleActivities = createActivities({
    backends: buildBackends(inCluster),
    tracker,
    scm,
    stats: new InMemoryStatsStore(),
    stageResults: new InMemoryStageResultStore(),
    workspaces,
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

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm exec vitest run packages/worker/src/main.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @agentops/worker run typecheck
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/worker/package.json pnpm-lock.yaml packages/worker/src/main.ts packages/worker/src/main.test.ts
git commit -m "feat(worker): wire buildActivityDependencies to the project registry"
```

---

### Task 8: CLI wiring — `buildStartScmPort` becomes registry-based

**Files:**
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/main.test.ts`

A CLI invocation only ever targets one `--repo`, so it doesn't need the Task 6 dispatcher — it looks up the single matching registry entry directly and builds one `GithubScmPort`, same as today's single-token path.

- [ ] **Step 1: Update the failing tests first**

Replace the `buildStartScmPort` describe block in `packages/cli/src/main.test.ts` (keep `seedDemoAgentopsConfig`/`parseFlags` blocks unchanged):

```ts
describe('buildStartScmPort', () => {
  it('returns a seeded MemoryScmPort when the registry is empty', async () => {
    const scm = buildStartScmPort([], 'demo', 'demo/repo');

    expect(scm).toBeInstanceOf(MemoryScmPort);
    const config = await loadProductConfig(scm, 'demo/repo');
    expect(config.routing.implement).toEqual({ backend: 'stub', model: 'stub-v1' });
  });

  it('returns a GithubScmPort for a repo registered under the given product', () => {
    const registry = [
      {
        product: 'my-product',
        repo: 'octocat/demo',
        trackerType: 'github' as const,
        tokenEnvVar: 'GITHUB_TOKEN__MY_PRODUCT',
        token: 'fake-token',
      },
    ];

    const scm = buildStartScmPort(registry, 'my-product', 'octocat/demo');

    expect(scm).toBeInstanceOf(GithubScmPort);
  });

  it('throws when the repo is not registered', () => {
    const registry = [
      {
        product: 'my-product',
        repo: 'octocat/demo',
        trackerType: 'github' as const,
        tokenEnvVar: 'GITHUB_TOKEN__MY_PRODUCT',
        token: 'fake-token',
      },
    ];

    expect(() => buildStartScmPort(registry, 'my-product', 'octocat/other')).toThrow(/no project registered/);
  });

  it('throws when the repo is registered under a different product', () => {
    const registry = [
      {
        product: 'my-product',
        repo: 'octocat/demo',
        trackerType: 'github' as const,
        tokenEnvVar: 'GITHUB_TOKEN__MY_PRODUCT',
        token: 'fake-token',
      },
    ];

    expect(() => buildStartScmPort(registry, 'wrong-product', 'octocat/demo')).toThrow(
      /registered under product "my-product"/,
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm exec vitest run packages/cli/src/main.test.ts
```
Expected: FAIL — `buildStartScmPort` still takes `(githubToken, repo)`.

- [ ] **Step 3: Implement**

Replace the full contents of `packages/cli/src/main.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { Client, Connection } from '@temporalio/client';
import { loadEnv, loadProjectRegistry, SpawnGitCommandRunner } from '@agentops/activities';

loadEnv();
import type { ResolvedProjectEntry, TaskInput } from '@agentops/contracts';
import { createGithubPorts, MemoryScmPort, type ScmPort } from '@agentops/ports';
import { cancelSignal, clarifySignal, devCycle, resumeSignal, stateQuery, stopSignal } from '@agentops/workflows';
import { loadProductConfig } from './load-product-config';

const TASK_QUEUE = 'agentops-devcycle';

export function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`usage: missing value for --${key}`);
    }
    flags[key] = value;
    i += 1;
  }
  return flags;
}

export function seedDemoAgentopsConfig(scm: MemoryScmPort, repo: string): void {
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

export function resolveProjectEntry(
  registry: ResolvedProjectEntry[],
  product: string,
  repo: string,
): ResolvedProjectEntry {
  const entry = registry.find((candidate) => candidate.repo === repo);
  if (!entry) {
    throw new Error(`no project registered for repo "${repo}" — check the project registry`);
  }
  if (entry.product !== product) {
    throw new Error(`repo "${repo}" is registered under product "${entry.product}", not "${product}" — check --product`);
  }
  return entry;
}

export function buildStartScmPort(registry: ResolvedProjectEntry[], product: string, repo: string): ScmPort {
  if (registry.length === 0) {
    const scm = new MemoryScmPort();
    seedDemoAgentopsConfig(scm, repo);
    return scm;
  }
  const entry = resolveProjectEntry(registry, product, repo);
  const git = new SpawnGitCommandRunner({ authToken: () => entry.token });
  return createGithubPorts(entry.token, git).scm;
}

async function getClient(): Promise<Client> {
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  return new Client({ connection });
}

async function cmdStart(taskId: string, goal: string, product: string, repo: string, issueRef?: string): Promise<void> {
  const client = await getClient();
  const scm = buildStartScmPort(loadProjectRegistry(), product, repo);
  const config = await loadProductConfig(scm, repo);
  const input: TaskInput = { taskId, product, repo, issueRef, goal, config };
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
    const flags = parseFlags(rest);
    const taskId = flags['task-id'] ?? randomUUID();
    const { goal, repo, product = 'default', issue } = flags;
    if (!goal || !repo) {
      throw new Error(
        'usage: engine start --goal <text> --repo <owner/repo> [--product <name>] [--issue <owner/repo#N>] [--task-id <id>]',
      );
    }
    await cmdStart(taskId, goal, product, repo, issue);
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

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

Note the behavior change this implies: once a registry is configured, `--product` is validated against the registry, not cosmetic — running `engine start --repo <registered-repo> --goal ...` without an explicit `--product` will default to `'default'` and throw a "registered under product X, not default" error. This is intentional (§"registry validates onboarding" in the design doc) — always pass `--product` explicitly once real projects exist.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm exec vitest run packages/cli/src/main.test.ts
```
Expected: PASS (all tests in the file — `seedDemoAgentopsConfig`, `parseFlags`, and the 4 `buildStartScmPort` tests).

- [ ] **Step 5: Typecheck the whole repo (everything from Tasks 1-8 should now compile together)**

```bash
pnpm typecheck
```
Expected: PASS, no errors anywhere.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/main.ts packages/cli/src/main.test.ts
git commit -m "feat(cli): wire buildStartScmPort to the project registry"
```

---

### Task 9: Helm chart — per-project secrets and the registry env var

**Files:**
- Modify: `charts/engine/values.yaml`
- Modify: `charts/engine/templates/deployment.yaml`
- Modify: `charts/engine/tests/render.golden.yaml`

- [ ] **Step 1: Update `values.yaml`**

Replace `charts/engine/values.yaml`:

```yaml
namespace: dev-agents

image:
  repository: gitactions.est1908.top/agentic-ops
  workerTag: CHANGEME
  agentClaudeTag: CHANGEME
  pullPolicy: IfNotPresent

imagePullSecretName: registry-credentials

replicas: 1

temporalAddress: "localhost:7233"

taskQueue: agentops-devcycle

resources:
  requests:
    cpu: 250m
    memory: 256Mi
  limits:
    cpu: "1"
    memory: 1Gi

workspace:
  pvcName: workspace-tasks
  mountPath: /workspace/tasks
  cachePvcName: workspace-cache
  cacheMountPath: /workspace/cache
  storageClassName: local-path
  taskSize: 10Gi
  cacheSize: 20Gi

# One entry per product. agentops-platform supplies the real list as a values
# override (see docs/superpowers/specs/2026-07-06-project-registry-design.md) —
# this repo ships no real repo names, matching ARCHITECTURE.md §5.8 (the engine
# is product-agnostic). Each entry renders one GITHUB_TOKEN__<PRODUCT> env var
# sourced from githubTokenSecretName, plus one row in PROJECT_REGISTRY_JSON.
#
# projects:
#   product-a:
#     repo: flair-hr/product-a
#     githubTokenSecretName: github-token-product-a
projects: {}

claudeAuthSecretName: claude-credentials
```

- [ ] **Step 2: Update `templates/deployment.yaml`**

Replace the `env:` block inside `templates/deployment.yaml` (everything else in the file is unchanged):

```yaml
          env:
            - name: TEMPORAL_ADDRESS
              value: {{ .Values.temporalAddress | quote }}
            - name: AGENT_NAMESPACE
              value: {{ .Values.namespace | quote }}
            - name: WORKSPACE_PVC_NAME
              value: {{ .Values.workspace.pvcName | quote }}
            - name: WORKSPACE_MOUNT_PATH
              value: {{ .Values.workspace.mountPath | quote }}
            - name: AGENT_RUNNER_IMAGE
              value: "{{ .Values.image.repository }}/agent-claude:{{ .Values.image.agentClaudeTag }}"
            {{- $registry := list }}
            {{- range $product, $cfg := .Values.projects }}
            {{- $envVar := printf "GITHUB_TOKEN__%s" (upper (replace "-" "_" $product)) }}
            {{- $registry = append $registry (dict "product" $product "repo" $cfg.repo "trackerType" "github" "tokenEnvVar" $envVar) }}
            - name: {{ $envVar }}
              valueFrom:
                secretKeyRef:
                  name: {{ $cfg.githubTokenSecretName }}
                  key: GITHUB_TOKEN
            {{- end }}
            - name: PROJECT_REGISTRY_JSON
              value: {{ $registry | toJson | quote }}
            - name: CLAUDE_AUTH_SECRET_NAME
              value: {{ .Values.claudeAuthSecretName | quote }}
            - name: IMAGE_PULL_SECRET_NAME
              value: {{ .Values.imagePullSecretName | quote }}
```

- [ ] **Step 3: Render with default values and inspect the diff against the current golden file**

```bash
cd charts/engine
helm template engine . --namespace dev-agents > /tmp/engine-render.yaml
diff /tmp/engine-render.yaml tests/render.golden.yaml
cd ../..
```
Expected: a diff exactly where the old `GITHUB_TOKEN` env block used to be — no per-project env vars render (default `projects: {}` is empty), and a new `PROJECT_REGISTRY_JSON` line appears.

- [ ] **Step 4: Update the golden file to match the new rendered output**

Replace this block in `charts/engine/tests/render.golden.yaml`:

```yaml
            - name: GITHUB_TOKEN
              valueFrom:
                secretKeyRef:
                  name: github-token
                  key: GITHUB_TOKEN
            - name: CLAUDE_AUTH_SECRET_NAME
              value: "claude-credentials"
```

with the actual output captured in Step 3 for that section (expected to be, but verify against the real render rather than assuming byte-for-byte):

```yaml
            - name: PROJECT_REGISTRY_JSON
              value: "[]"
            - name: CLAUDE_AUTH_SECRET_NAME
              value: "claude-credentials"
```

- [ ] **Step 5: Run the chart's golden test**

```bash
bash charts/engine/tests/run.sh
```
Expected: no output, exit code 0 (the `diff` inside the script is silent on a match).

- [ ] **Step 6: Manually verify the per-project rendering path with a populated `projects` override (not committed — proves the `range`/`toJson` logic once)**

```bash
helm template engine charts/engine --namespace dev-agents \
  --set projects.product-a.repo=flair-hr/product-a \
  --set projects.product-a.githubTokenSecretName=github-token-product-a \
  | grep -A3 'GITHUB_TOKEN__PRODUCT_A\|PROJECT_REGISTRY_JSON'
```
Expected output includes:
```
            - name: GITHUB_TOKEN__PRODUCT_A
              valueFrom:
                secretKeyRef:
                  name: github-token-product-a
            - name: PROJECT_REGISTRY_JSON
              value: "[{\"product\":\"product-a\",\"repo\":\"flair-hr/product-a\",\"trackerType\":\"github\",\"tokenEnvVar\":\"GITHUB_TOKEN__PRODUCT_A\"}]"
```
If the env var name or JSON shape differs from this, fix the template (not the assertion) until it matches — this is the contract `loadProjectRegistry` (Task 2) parses.

- [ ] **Step 7: Commit**

```bash
git add charts/engine/values.yaml charts/engine/templates/deployment.yaml charts/engine/tests/render.golden.yaml
git commit -m "feat(chart): render per-project GitHub token secrets and PROJECT_REGISTRY_JSON"
```

---

### Task 10: README — replace the single-token local-dev instructions

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the "Run locally" section**

Replace this paragraph in `README.md`:

```markdown
Requires `GITHUB_TOKEN` (PAT with `repo` scope) in the environment or a repo-root `.env` file, a running Temporal dev server, and `agentops.json` in the target repo.
```

with:

```markdown
Requires a running Temporal dev server and `agentops.json` in the target repo. For a real (non-demo) run, register at least one project via a repo-root `.env` file — see [project-registry-design.md](docs/superpowers/specs/2026-07-06-project-registry-design.md):

```
PROJECT_REGISTRY_JSON=[{"product":"my-product","repo":"owner/repo","trackerType":"github","tokenEnvVar":"GITHUB_TOKEN__MY_PRODUCT"}]
GITHUB_TOKEN__MY_PRODUCT=ghp_xxx
```

No `.env` at all → DEMO mode (in-memory ports + stub backend, no tokens spent). `--product` must match the registered product for the given `--repo` once a registry is configured.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update local-dev instructions for the project registry"
```

---

### Task 11: Full local verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full gate**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e
```
Expected: all green.

- [ ] **Step 2: Re-verify the chart golden test**

```bash
bash charts/engine/tests/run.sh
```
Expected: no output, exit code 0.

- [ ] **Step 3: Commit if the gate required any fixes**

```bash
git add -A
git commit -m "chore: fix lint/typecheck/test fallout from the project registry"
```
(Skip if Step 1 and Step 2 were already green.)

---

### Task 12: Open the PR, pass CI, and resolve the Bugbot review

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
gh pr create --base main --fill --title "feat: per-project GitHub credentials via a project registry"
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
