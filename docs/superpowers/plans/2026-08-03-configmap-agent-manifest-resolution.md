# ConfigMap-first Activity Config Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make config-sync and repository workflows consume platform-owned `agentops.json` from the mounted managed-project ConfigMap before falling back to the target repository.

**Architecture:** Thread the worker's existing `ManagedProjectRegistryDeps` into `createActivities` and route both `loadAgentsManifest` and `resolveRepoConfig` through the already-tested `resolveProjectConfig` precedence boundary. Preserve the unregistered-repository short circuit and repository-file fallback when no stored config exists.

**Tech Stack:** TypeScript 6, pnpm workspaces, Vitest, Temporal activities, `FileManagedProjectStore`, zod-validated project contracts.

---

### Task 1: Reproduce and fix activity config precedence

**Files:**

- Modify: `packages/activities/src/create-activities.test.ts`
- Modify: `packages/activities/src/create-activities.ts`

- [ ] **Step 1: Add a managed-config test helper**

Import `ManagedProjectStore`, `parseProjectConfig`, and
`ManagedProjectRegistryDeps`, then add a helper beside `buildDeps`:

```ts
import { parseProjectConfig, type ManagedProjectStore } from '@agentops/contracts';
import type { ManagedProjectRegistryDeps } from './resolve-managed-projects';

function managedProjectDeps(
  repo: string,
  project: string,
  config: ReturnType<typeof parseProjectConfig> | null,
): ManagedProjectRegistryDeps {
  const store = {
    async get(candidate: string) {
      if (candidate !== repo) return null;
      return {
        id: 'managed-1',
        project,
        repo,
        trackerType: 'github' as const,
        tokenSecret: 'github-token',
        credentialSet: true,
        config,
        createdAt: '',
        updatedAt: '',
      };
    },
  } as unknown as ManagedProjectStore;
  return { store, resolveToken: async () => 'unused' };
}
```

- [ ] **Step 2: Write failing ConfigMap-first tests**

Add tests that seed no repository config and assert both activity methods return
stored configuration without reading SCM:

```ts
it('loads the agent manifest from managed-project config without reading the repo', async () => {
  const deps = {
    ...buildDeps(),
    managedProjectDeps: managedProjectDeps(
      'flair-hr/employee-hub-monorepo',
      'employee-hub-monorepo',
      parseProjectConfig({
        agents: [
          {
            name: 'rollbar-monitor',
            workflow: 'rollbarMonitor',
            schedule: '0 6 * * *',
            enabled: false,
            input: { rollbarProject: 'employee-hub' },
          },
        ],
        worker: { image: 'example/worker:sha', externalSecrets: ['rollbar-token'] },
      }),
    ),
  };
  const readFile = vi.spyOn(deps.scm, 'readFile');
  deps.registry = [
    {
      project: 'employee-hub-monorepo',
      repo: 'flair-hr/employee-hub-monorepo',
      trackerType: 'github',
      token: 'fake',
      readRepositories: [],
    },
  ];

  const manifest = await createActivities(deps).loadAgentsManifest(
    'employee-hub-monorepo',
    'flair-hr/employee-hub-monorepo',
  );

  expect(manifest.agents.map((agent) => agent.name)).toEqual(['rollbar-monitor']);
  expect(manifest.worker?.image).toBe('example/worker:sha');
  expect(readFile).not.toHaveBeenCalled();
});

it('resolves workflow config from managed-project config without reading the repo', async () => {
  const deps = {
    ...buildDeps(),
    managedProjectDeps: managedProjectDeps(
      'est1908/agentops-engine',
      'engine',
      parseProjectConfig({ fastVerifyCommands: ['pnpm lint'] }),
    ),
  };
  const readFile = vi.spyOn(deps.scm, 'readFile');
  deps.registry = [
    {
      project: 'engine',
      repo: 'est1908/agentops-engine',
      trackerType: 'github',
      token: 'fake',
      readRepositories: [],
    },
  ];

  const result = await createActivities(deps).resolveRepoConfig('est1908/agentops-engine');

  expect(result).toMatchObject({ registered: true, project: 'engine' });
  expect(result.config.fastVerifyCommands).toEqual(['pnpm lint']);
  expect(readFile).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run the tests and verify RED**

Run:

```bash
pnpm test -- packages/activities/src/create-activities.test.ts
```

Expected: the new tests fail because `loadAgentsManifest` returns no agents and
`resolveRepoConfig` reads repository defaults; the no-SCM-read assertions fail.

- [ ] **Step 4: Route both activities through the shared resolver**

In `create-activities.ts`, import the existing resolver and dependency type:

```ts
import { resolveProjectConfig } from './resolve-project-config';
import type { ManagedProjectRegistryDeps } from './resolve-managed-projects';
```

Add the optional dependency to `ActivityDependencies`:

```ts
export interface ActivityDependencies {
  // existing fields...
  managedProjectDeps?: ManagedProjectRegistryDeps;
}
```

Keep the unregistered short circuit in `resolveRepoConfig`, but replace its
direct repository read:

```ts
const config = await resolveProjectConfig(deps.managedProjectDeps, deps.scm, repo);
return { registered: true, project: entry.project, config };
```

Replace `loadAgentsManifest`'s direct repository read:

```ts
const config = await resolveProjectConfig(deps.managedProjectDeps, deps.scm, repo);
return { agents: config.agents ?? [], worker: config.worker };
```

- [ ] **Step 5: Add and verify repository fallback coverage**

Add a test with managed `config: null`, a seeded repo `agentops.json`, and an SCM
spy. Assert `loadAgentsManifest` returns the repository agent and the spy was
called. Then run:

```bash
pnpm test -- packages/activities/src/create-activities.test.ts packages/activities/src/resolve-project-config.test.ts
```

Expected: both files pass, with at least the baseline 70 tests plus the new
regressions.

- [ ] **Step 6: Commit the activity fix**

```bash
git add packages/activities/src/create-activities.ts packages/activities/src/create-activities.test.ts
git commit -m "fix(activities): resolve managed project config before repo files"
```

### Task 2: Wire the managed store into production activities

**Files:**

- Modify: `packages/worker/src/main.ts`

- [ ] **Step 1: Pass the existing dependency into `createActivities`**

The worker already constructs `managedProjectDeps` before loading the registry.
Add that exact object to the production activity dependency object:

```ts
const activities: DevCycleActivities & PlatformActivities = createActivities({
  // existing dependencies...
  registry,
  managedProjectDeps,
  globalTiers,
  // remaining dependencies...
});
```

- [ ] **Step 2: Run focused type and activity checks**

Run:

```bash
pnpm --filter @agentops/activities run typecheck
pnpm --filter @agentops/worker run typecheck
pnpm test -- packages/activities/src/create-activities.test.ts packages/activities/src/resolve-project-config.test.ts packages/worker/src/main.test.ts
```

Expected: all commands exit 0; activity tests prove ConfigMap precedence and
worker tests retain their existing live-registry behavior.

- [ ] **Step 3: Commit production wiring**

```bash
git add packages/worker/src/main.ts
git commit -m "fix(worker): pass managed project config store to activities"
```

### Task 3: Verify the complete engine

**Files:** none unless verification exposes a regression.

- [ ] **Step 1: Run required local gates**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:policies-coverage
pnpm build
pnpm e2e
```

Expected: every command exits 0. The known Helm-template Prettier incompatibility
is not part of the required AGENTS.md gate; run targeted formatting on changed
files instead:

```bash
pnpm exec prettier --check \
  packages/activities/src/create-activities.ts \
  packages/activities/src/create-activities.test.ts \
  packages/worker/src/main.ts \
  docs/superpowers/specs/2026-08-03-configmap-agent-manifest-resolution-design.md \
  docs/superpowers/plans/2026-08-03-configmap-agent-manifest-resolution.md
```

- [ ] **Step 2: Inspect the release diff**

```bash
git diff upstream/main --check
git status --short
git log --oneline upstream/main..HEAD
```

Expected: no whitespace errors, a clean worktree, and only the design, plan,
activity fix/tests, and worker wiring commits.

### Task 4: Open, review, and merge the PR

**Files:** none (integration / review).

> Sequential and partly asynchronous — CI and Bugbot run on the remote PR.
> **HARD GATE: Do not merge until ALL Bugbot comments are resolved and CI is
> green.**

- [ ] **Step 1: Sync current upstream main**

```bash
git fetch upstream
git merge upstream/main
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm build && pnpm e2e
```

- [ ] **Step 2: Push and open the PR**

```bash
git status --short
git push -u origin HEAD
gh pr create --repo est1908-agentic-ops/agentops-engine --base main \
  --title "fix(activities): prefer managed project config" --fill
```

- [ ] **Step 3: Request independent code review**

Dispatch a reviewer over `git merge-base upstream/main HEAD..HEAD`. Fix every
Critical and Important finding, commit, and push.

- [ ] **Step 4: Make every CI check green**

```bash
gh pr checks --repo est1908-agentic-ops/agentops-engine --watch
```

On failure, inspect `gh run view --log-failed`, reproduce locally, fix, push,
and re-watch.

- [ ] **Step 5: Wait for Bugbot and resolve every thread**

```bash
gh pr view --repo est1908-agentic-ops/agentops-engine --json reviews,comments
```

If Bugbot has not reviewed, comment `bugbot run`. Verify every finding before
acting, reply to false positives with evidence, fix real findings test-first,
and resolve each addressed review thread through the GitHub GraphQL API.

- [ ] **Step 6: Merge after final gates**

Confirm CI is green, Bugbot has reviewed, no unresolved threads remain, and the
local full suite is green. Then merge with the repository's allowed method:

```bash
gh pr merge --repo est1908-agentic-ops/agentops-engine --squash --delete-branch
```

Expected: PR state is `MERGED`. Confirm the merge commit appears on
`upstream/main`; deployment then proceeds through the immutable engine image
published from main, with no chart `targetRevision` change.
