# `product` → `project` Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the `product` vocabulary to `project` everywhere it names "a registered repo + its config" — types, fields, function names, file names, chart values, and living docs — with zero behavioral change, as the prerequisite for the managed-project-registry design.

**Architecture:** This is a pure mechanical rename, not a redesign. One canonical `sed` substitution (defined once below, reused verbatim in every task) handles every code occurrence uniformly: compound identifiers (`ProductConfig` → `ProjectConfig`, which as a substring match also fixes `ProductConfigSchema`, `InvalidProductConfigError`, `parseProductConfig`, `loadProductConfig` for free), the `DEFAULT_PRODUCT_CONFIG` constant, `product-config`/`load-product-config` file-path strings, and the standalone `product` field/variable name (word-boundary safe, so it doesn't touch unrelated substrings). Two files get `git mv`'d before the sed runs. Docs get the same sed pass plus one manual exclusion for a generic (non-concept) use of the English word "product". Sequenced by the dependency graph — `contracts` first, then its consumers — so each task's own package typecheck/tests are green before moving on, even though the *whole-repo* typecheck won't be green until the last code task lands (expected and fine within one PR).

**Tech Stack:** TypeScript (pnpm workspace, vitest, zod), Helm/Go templates, Markdown docs. No new dependencies.

**Source of truth:** `docs/superpowers/specs/2026-07-08-product-to-project-rename-design.md` — every file below was verified against the actual current repo content (not the design doc's original draft, which predated a merge that added more affected files; the design doc's scope table has since been corrected to match).

---

## The canonical rename command

Every task below runs this exact command against its listed files (macOS/BSD `sed`; adjust to `sed -i` without the empty `''` arg on GNU/Linux):

```bash
sed -i '' \
  -e 's/ProductConfig/ProjectConfig/g' \
  -e 's/DEFAULT_PRODUCT_CONFIG/DEFAULT_PROJECT_CONFIG/g' \
  -e 's/product-config/project-config/g' \
  -e 's/\bproduct\b/project/g' \
  -e 's/\bProduct\b/Project/g' \
  -e 's/\bPRODUCT\b/PROJECT/g' \
  <file>
```

Why these six expressions are safe as a blind pass on every file in scope (verified by reading every matching line in the repo before writing this plan):
- `ProductConfig` → `ProjectConfig` is a literal substring match, so it also correctly rewrites `ProductConfigSchema`, `InvalidProductConfigError`, `parseProductConfig`, and `loadProductConfig` (all contain `ProductConfig` as a substring) in the same pass.
- `product-config` (kebab-case) also correctly rewrites `load-product-config` as a substring match — no separate rule needed for that file/import-path rename.
- `\bproduct\b`, `\bProduct\b`, `\bPRODUCT\b` are word-boundary bound, so they rename the standalone field/variable name and any capitalized standalone prose usage (doc headings like "Product-defined triggers") without touching unrelated words.

---

### Task 1: `packages/contracts`

**Files:**
- Rename: `packages/contracts/src/product-config.ts` → `packages/contracts/src/project-config.ts`
- Rename: `packages/contracts/src/product-config.test.ts` → `packages/contracts/src/project-config.test.ts`
- Modify: `packages/contracts/src/project-registry.ts`
- Modify: `packages/contracts/src/project-registry.test.ts`
- Modify: `packages/contracts/src/task-input.ts`
- Modify: `packages/contracts/src/task-input.test.ts`
- Modify: `packages/contracts/src/agent-run.ts` (import path only)
- Modify: `packages/contracts/src/index.ts` (export path only)

- [ ] **Step 1: Rename the two contracts files**

```bash
cd packages/contracts/src
git mv product-config.ts project-config.ts
git mv product-config.test.ts project-config.test.ts
cd ../../..
```

- [ ] **Step 2: Run the canonical sed against every file in this task**

```bash
sed -i '' \
  -e 's/ProductConfig/ProjectConfig/g' \
  -e 's/DEFAULT_PRODUCT_CONFIG/DEFAULT_PROJECT_CONFIG/g' \
  -e 's/product-config/project-config/g' \
  -e 's/\bproduct\b/project/g' \
  -e 's/\bProduct\b/Project/g' \
  -e 's/\bPRODUCT\b/PROJECT/g' \
  packages/contracts/src/project-config.ts \
  packages/contracts/src/project-config.test.ts \
  packages/contracts/src/project-registry.ts \
  packages/contracts/src/project-registry.test.ts \
  packages/contracts/src/task-input.ts \
  packages/contracts/src/task-input.test.ts \
  packages/contracts/src/agent-run.ts \
  packages/contracts/src/index.ts
```

- [ ] **Step 3: Verify `project-registry.ts` reads as expected**

```bash
cat packages/contracts/src/project-registry.ts
```

Expected: `ProjectRegistryEntrySchema` now has a `project: z.string().min(1),` field (was `product:`); `findDuplicate(registry.map((entry) => entry.project))`; error string `` `duplicate project "${duplicateProject}" in project registry` `` (the variable `duplicateProduct` also became `duplicateProject` — confirm it reads consistently, not a mix of old/new).

- [ ] **Step 4: Verify `task-input.ts` reads as expected**

```bash
cat packages/contracts/src/task-input.ts
```

Expected:
```ts
import { z } from 'zod';
import { ProjectConfigSchema } from './project-config';

export const TaskInputSchema = z.object({
  taskId: z.string().min(1),
  project: z.string().min(1),
  repo: z.string().min(1),
  issueRef: z.string().optional(),
  goal: z.string().min(1),
  config: ProjectConfigSchema,
});
export type TaskInput = z.infer<typeof TaskInputSchema>;
```

- [ ] **Step 5: Typecheck this package**

Run: `pnpm --filter @agentops/contracts run typecheck`
Expected: PASS, zero errors (this package has no dependency on anything still using the old names).

- [ ] **Step 6: Run this package's tests**

Run: `pnpm test -- packages/contracts`
Expected: all tests pass. Test *descriptions* mentioning "product" (e.g. `describe('ProductConfigSchema', ...)`) were also renamed by the sed pass — confirm none were left half-renamed by skimming `git diff --stat packages/contracts`.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts
git commit -m "refactor(contracts): rename product to project vocabulary"
```

---

### Task 2: `packages/policies`

**Files:**
- Modify: `packages/policies/src/pre-implement-stages.ts`
- Modify: `packages/policies/src/pre-implement-stages.test.ts`

- [ ] **Step 1: Run the canonical sed**

```bash
sed -i '' \
  -e 's/ProductConfig/ProjectConfig/g' \
  -e 's/DEFAULT_PRODUCT_CONFIG/DEFAULT_PROJECT_CONFIG/g' \
  -e 's/product-config/project-config/g' \
  -e 's/\bproduct\b/project/g' \
  -e 's/\bProduct\b/Project/g' \
  -e 's/\bPRODUCT\b/PROJECT/g' \
  packages/policies/src/pre-implement-stages.ts \
  packages/policies/src/pre-implement-stages.test.ts
```

- [ ] **Step 2: Verify**

```bash
head -3 packages/policies/src/pre-implement-stages.ts
```

Expected: `import type { ProjectConfig, Stage } from '@agentops/contracts';` and `config: ProjectConfig;` in the `PreImplementInput` interface.

- [ ] **Step 3: Typecheck this package**

Run: `pnpm --filter @agentops/policies run typecheck`
Expected: PASS (this package only depends on `@agentops/contracts`, already renamed in Task 1).

- [ ] **Step 4: Run this package's tests**

Run: `pnpm test -- packages/policies`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/policies
git commit -m "refactor(policies): rename product to project vocabulary"
```

---

### Task 3: `packages/activities`

**Files:**
- Rename: `packages/activities/src/load-product-config.ts` → `packages/activities/src/load-project-config.ts`
- Rename: `packages/activities/src/load-product-config.test.ts` → `packages/activities/src/load-project-config.test.ts`
- Modify: `packages/activities/src/load-project-registry.ts`
- Modify: `packages/activities/src/load-project-registry.test.ts`
- Modify: `packages/activities/src/create-activities.ts`
- Modify: `packages/activities/src/create-activities.test.ts`
- Modify: `packages/activities/src/index.ts`

- [ ] **Step 1: Rename the two activities files**

```bash
cd packages/activities/src
git mv load-product-config.ts load-project-config.ts
git mv load-product-config.test.ts load-project-config.test.ts
cd ../../..
```

- [ ] **Step 2: Run the canonical sed**

```bash
sed -i '' \
  -e 's/ProductConfig/ProjectConfig/g' \
  -e 's/DEFAULT_PRODUCT_CONFIG/DEFAULT_PROJECT_CONFIG/g' \
  -e 's/product-config/project-config/g' \
  -e 's/\bproduct\b/project/g' \
  -e 's/\bProduct\b/Project/g' \
  -e 's/\bPRODUCT\b/PROJECT/g' \
  packages/activities/src/load-project-config.ts \
  packages/activities/src/load-project-config.test.ts \
  packages/activities/src/load-project-registry.ts \
  packages/activities/src/load-project-registry.test.ts \
  packages/activities/src/create-activities.ts \
  packages/activities/src/create-activities.test.ts \
  packages/activities/src/index.ts
```

- [ ] **Step 3: Verify `create-activities.ts`'s `resolveRepoConfig` shape**

```bash
grep -n "resolveRepoConfig\|registered\|loadProjectConfig" packages/activities/src/create-activities.ts
```

Expected: the function's return type is `Promise<{ registered: boolean; project: string; config: ProjectConfig }>` (was `product`), the not-registered branch returns `{ registered: false, project: 'default', config: parseProjectConfig({}) }`, and the registered branch returns `{ registered: true, project: entry.project, config }` — importing `loadProjectConfig` from `'./load-project-config'`.

- [ ] **Step 4: Verify `load-project-registry.ts`**

```bash
cat packages/activities/src/load-project-registry.ts
```

Expected:
```ts
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
      throw new Error(`loadProjectRegistry: env var "${entry.tokenEnvVar}" for project "${entry.project}" is not set`);
    }
    return { ...entry, token };
  });
}
```

- [ ] **Step 5: Typecheck this package**

Run: `pnpm --filter @agentops/activities run typecheck`
Expected: PASS.

- [ ] **Step 6: Run this package's tests**

Run: `pnpm test -- packages/activities`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/activities
git commit -m "refactor(activities): rename product to project vocabulary"
```

---

### Task 4: `packages/workflows`

**Files:**
- Modify: `packages/workflows/src/platform-activities-api.ts`
- Modify: `packages/workflows/src/platform.ts`

- [ ] **Step 1: Run the canonical sed**

```bash
sed -i '' \
  -e 's/ProductConfig/ProjectConfig/g' \
  -e 's/DEFAULT_PRODUCT_CONFIG/DEFAULT_PROJECT_CONFIG/g' \
  -e 's/product-config/project-config/g' \
  -e 's/\bproduct\b/project/g' \
  -e 's/\bProduct\b/Project/g' \
  -e 's/\bPRODUCT\b/PROJECT/g' \
  packages/workflows/src/platform-activities-api.ts \
  packages/workflows/src/platform.ts
```

- [ ] **Step 2: Verify**

```bash
grep -n "project\|Project" packages/workflows/src/platform-activities-api.ts packages/workflows/src/platform.ts
```

Expected in `platform-activities-api.ts`: `resolveRepoConfig(repo: string): Promise<{ registered: boolean; project: string; config: ProjectConfig }>;` and the import list includes `ProjectConfig` (not `ProductConfig`).
Expected in `platform.ts`: the comment now reads "This role isn't scoped to one project, so there's no ProjectConfig to route through" and the `TaskInput` construction has `project: resolved.project,` (not `product: resolved.product,`).

- [ ] **Step 3: Confirm the determinism boundary wasn't touched**

This package (`packages/workflows`) may not import I/O — this task only renames a field name in a plain object literal and a comment, no new imports were added. Confirm:

```bash
git diff packages/workflows | grep "^+import\|^+.*require("
```

Expected: no output (no new import statements added by this rename).

- [ ] **Step 4: Typecheck this package**

Run: `pnpm --filter @agentops/workflows run typecheck`
Expected: PASS.

- [ ] **Step 5: Run this package's tests**

Run: `pnpm test -- packages/workflows`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/workflows
git commit -m "refactor(workflows): rename product to project vocabulary"
```

---

### Task 5: `packages/backends`

**Files:**
- Modify: `packages/backends/src/k8s/k8s-job-runner.ts`
- Modify: `packages/backends/src/k8s/k8s-job-runner.test.ts`
- **Explicitly excluded:** `packages/backends/src/claude/claude-backend.ts` — its one match ("that's a **product** decision (what budget?)") is generic English (a product-management decision), not this concept. Do not touch this file.

- [ ] **Step 1: Run the canonical sed on only the two in-scope files**

```bash
sed -i '' \
  -e 's/ProductConfig/ProjectConfig/g' \
  -e 's/DEFAULT_PRODUCT_CONFIG/DEFAULT_PROJECT_CONFIG/g' \
  -e 's/product-config/project-config/g' \
  -e 's/\bproduct\b/project/g' \
  -e 's/\bProduct\b/Project/g' \
  -e 's/\bPRODUCT\b/PROJECT/g' \
  packages/backends/src/k8s/k8s-job-runner.ts \
  packages/backends/src/k8s/k8s-job-runner.test.ts
```

- [ ] **Step 2: Verify only the intended two files changed**

```bash
git status --short packages/backends
```

Expected: exactly `k8s-job-runner.ts` and `k8s-job-runner.test.ts` show as modified — `claude-backend.ts` must NOT appear.

- [ ] **Step 3: Verify the comment/error-message wording**

```bash
grep -n "project" packages/backends/src/k8s/k8s-job-runner.ts
```

Expected: "AGENT_RUNNER_IMAGE, or a project's own agentops.json) never got replaced" and "set a real image via the project's agentops.json" — both read grammatically correct.

- [ ] **Step 4: Typecheck this package**

Run: `pnpm --filter @agentops/backends run typecheck`
Expected: PASS.

- [ ] **Step 5: Run this package's tests**

Run: `pnpm test -- packages/backends`
Expected: all tests pass, including the renamed test description ("refuses to build a Job when the project-supplied image (req.image) is still a placeholder").

- [ ] **Step 6: Commit**

```bash
git add packages/backends
git commit -m "refactor(backends): rename product to project vocabulary (k8s-job-runner only)"
```

---

### Task 6: `packages/control`

**Files:**
- Modify: `packages/control/src/read-registry-repos.test.ts`

(`packages/control/src/read-registry-repos.ts` itself has no `product` reference — it only reads `entry.repo`, confirmed by inspection. Only its test fixtures use the field name.)

- [ ] **Step 1: Run the canonical sed**

```bash
sed -i '' \
  -e 's/ProductConfig/ProjectConfig/g' \
  -e 's/DEFAULT_PRODUCT_CONFIG/DEFAULT_PROJECT_CONFIG/g' \
  -e 's/product-config/project-config/g' \
  -e 's/\bproduct\b/project/g' \
  -e 's/\bProduct\b/Project/g' \
  -e 's/\bPRODUCT\b/PROJECT/g' \
  packages/control/src/read-registry-repos.test.ts
```

- [ ] **Step 2: Verify**

```bash
grep -n "project\|PROJECT" packages/control/src/read-registry-repos.test.ts
```

Expected: fixture entries now read `{ project: 'project-a', repo: 'flair-hr/project-a', trackerType: 'github', tokenEnvVar: 'GITHUB_TOKEN__PROJECT_A' }` (both the field name and the example slug value were renamed — harmless, since the value was always just an illustrative string).

- [ ] **Step 3: Typecheck this package**

Run: `pnpm --filter @agentops/control run typecheck`
Expected: PASS.

- [ ] **Step 4: Run this package's tests**

Run: `pnpm test -- packages/control`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/control
git commit -m "refactor(control): rename product to project vocabulary in test fixtures"
```

---

### Task 7: `packages/cli`

**Files:**
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/main.test.ts`

- [ ] **Step 1: Run the canonical sed**

```bash
sed -i '' \
  -e 's/ProductConfig/ProjectConfig/g' \
  -e 's/DEFAULT_PRODUCT_CONFIG/DEFAULT_PROJECT_CONFIG/g' \
  -e 's/product-config/project-config/g' \
  -e 's/\bproduct\b/project/g' \
  -e 's/\bProduct\b/Project/g' \
  -e 's/\bPRODUCT\b/PROJECT/g' \
  packages/cli/src/main.ts \
  packages/cli/src/main.test.ts
```

- [ ] **Step 2: Verify the CLI flag and usage strings**

```bash
grep -n "project\|usage:" packages/cli/src/main.ts
```

Expected, among others:
```ts
export function resolveProjectEntry(
  registry: ResolvedProjectEntry[],
  project: string,
  repo: string,
): ResolvedProjectEntry {
  const entry = registry.find((candidate) => candidate.repo === repo);
  if (!entry) {
    throw new Error(`no project registered for repo "${repo}" — check the project registry`);
  }
  if (entry.project !== project) {
    throw new Error(`repo "${repo}" is registered under project "${entry.project}", not "${project}" — check --project`);
  }
  return entry;
}
```
And the `start` command's usage string reads `'usage: engine start --goal <text> --repo <owner/repo> [--project <name>] [--issue <owner/repo#N>] [--task-id <id>]'`, with `const { goal, repo, project = 'default', issue } = flags;` above it.

- [ ] **Step 3: Typecheck this package**

Run: `pnpm --filter @agentops/cli run typecheck`
Expected: PASS.

- [ ] **Step 4: Run this package's tests**

Run: `pnpm test -- packages/cli`
Expected: all tests pass, including the renamed test names (e.g. "returns a GithubScmPort for a repo registered under the given project", "throws when the repo is registered under a different project").

- [ ] **Step 5: Commit**

```bash
git add packages/cli
git commit -m "refactor(cli): rename product to project vocabulary, --product flag to --project"
```

---

### Task 8: `packages/gateway`

**Files:**
- Modify: `packages/gateway/src/create-gateway-server.ts`
- Modify: `packages/gateway/src/create-gateway-server.test.ts`
- Modify: `packages/gateway/src/start-dev-cycle.ts`
- Modify: `packages/gateway/src/start-dev-cycle.test.ts`
- Modify: `packages/gateway/src/main.ts`

- [ ] **Step 1: Run the canonical sed**

```bash
sed -i '' \
  -e 's/ProductConfig/ProjectConfig/g' \
  -e 's/DEFAULT_PRODUCT_CONFIG/DEFAULT_PROJECT_CONFIG/g' \
  -e 's/product-config/project-config/g' \
  -e 's/\bproduct\b/project/g' \
  -e 's/\bProduct\b/Project/g' \
  -e 's/\bPRODUCT\b/PROJECT/g' \
  packages/gateway/src/create-gateway-server.ts \
  packages/gateway/src/create-gateway-server.test.ts \
  packages/gateway/src/start-dev-cycle.ts \
  packages/gateway/src/start-dev-cycle.test.ts \
  packages/gateway/src/main.ts
```

- [ ] **Step 2: Verify `start-dev-cycle.ts`'s taskId construction and comment**

```bash
cat packages/gateway/src/start-dev-cycle.ts
```

Expected: `startDevCycleForIssue(client, taskQueue, project, event, config)` (param renamed), `const taskId = \`issue-${project}-${event.issueNumber}\`;`, the `TaskInput` object literal has `project,` (not `product,`), and the comment block above `taskId` reads "Keyed by `project`, not `event.repo`: the registry (parseProjectRegistry) already guarantees project names are unique...".

- [ ] **Step 3: Verify `create-gateway-server.ts`'s call site**

```bash
grep -n "startDevCycleForIssue\|entry.project" packages/gateway/src/create-gateway-server.ts
```

Expected: `const result = await startDevCycleForIssue(deps.client, deps.taskQueue, entry.project, event, config);`.

- [ ] **Step 4: Verify `main.ts`'s log line**

```bash
grep -n "project(s) registered" packages/gateway/src/main.ts
```

Expected: `` `agentops gateway: ${registry.length} project(s) registered: ${registry.map((e) => `${e.project} (${e.repo})`).join(', ')}` ``.

- [ ] **Step 5: Typecheck this package**

Run: `pnpm --filter @agentops/gateway run typecheck`
Expected: PASS.

- [ ] **Step 6: Run this package's tests**

Run: `pnpm test -- packages/gateway`
Expected: all tests pass, including the renamed test ("does not collide across two projects whose repos would collapse to the same slug").

- [ ] **Step 7: Commit**

```bash
git add packages/gateway
git commit -m "refactor(gateway): rename product to project vocabulary"
```

---

### Task 9: `packages/worker`

**Files:**
- Modify: `packages/worker/src/main.ts`
- Modify: `packages/worker/src/main.test.ts`

- [ ] **Step 1: Run the canonical sed**

```bash
sed -i '' \
  -e 's/ProductConfig/ProjectConfig/g' \
  -e 's/DEFAULT_PRODUCT_CONFIG/DEFAULT_PROJECT_CONFIG/g' \
  -e 's/product-config/project-config/g' \
  -e 's/\bproduct\b/project/g' \
  -e 's/\bProduct\b/Project/g' \
  -e 's/\bPRODUCT\b/PROJECT/g' \
  packages/worker/src/main.ts \
  packages/worker/src/main.test.ts
```

- [ ] **Step 2: Verify the LIVE-mode log line**

```bash
grep -n "project(s) registered" packages/worker/src/main.ts
```

Expected:
```ts
      ? `agentops worker: LIVE mode — ${registry.length} project(s) registered: ${registry
          .map((entry) => `${entry.project} (${entry.repo})`)
          .join(', ')} — real GitHub + real agent CLIs, will spend tokens and open real PRs`
```

- [ ] **Step 3: Typecheck this package**

Run: `pnpm --filter @agentops/worker run typecheck`
Expected: PASS. This is the last TypeScript package in the dependency graph — after this task, the **whole-repo** `pnpm typecheck` should also pass for the first time since Task 1 started (verified in Task 11).

- [ ] **Step 4: Run this package's tests**

Run: `pnpm test -- packages/worker`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/worker
git commit -m "refactor(worker): rename product to project vocabulary"
```

---

### Task 10: `charts/engine`

**Files:**
- Modify: `charts/engine/templates/_helpers.tpl`
- Modify: `charts/engine/templates/deployment.yaml`
- Modify: `charts/engine/templates/gateway-deployment.yaml`
- Modify: `charts/engine/values.yaml`

- [ ] **Step 1: Rename the Helm loop variable and comments in `_helpers.tpl`**

```bash
sed -i '' \
  -e 's/\$product/\$project/g' \
  -e 's/\bproduct\b/project/g' \
  -e 's/\bProduct\b/Project/g' \
  charts/engine/templates/_helpers.tpl
```

- [ ] **Step 2: Verify `_helpers.tpl`**

```bash
cat charts/engine/templates/_helpers.tpl
```

Expected:
```
{{/*
Shared PROJECT_REGISTRY_JSON computation — both the worker Deployment and the
gateway Deployment render one GITHUB_TOKEN__<PROJECT> secretKeyRef per
project (the gateway needs a real per-project token to fetch agentops.json
via the GitHub API before starting a devCycle) plus this same
PROJECT_REGISTRY_JSON list of project/repo/tokenEnvVar entries.
*/}}
{{- define "engine.projectRegistryJson" -}}
{{- $registry := list -}}
{{- range $project, $cfg := .Values.projects }}
{{- $registry = append $registry (dict "project" $project "repo" $cfg.repo "trackerType" "github" "tokenEnvVar" (printf "GITHUB_TOKEN__%s" (upper (replace "-" "_" $project)))) }}
{{- end }}
{{- $registry | toJson }}
{{- end -}}
```

Note the `dict "project" $project` key: the JSON key in `PROJECT_REGISTRY_JSON`'s entries must be `"project"` to match `ProjectRegistryEntrySchema`'s renamed field from Task 1 — this is not cosmetic, `parseProjectRegistry` will reject the JSON if this key is still `"product"`.

- [ ] **Step 3: Rename the loop variable in `deployment.yaml` and `gateway-deployment.yaml`**

```bash
sed -i '' -e 's/\$product/\$project/g' charts/engine/templates/deployment.yaml
sed -i '' -e 's/\$product/\$project/g' charts/engine/templates/gateway-deployment.yaml
```

- [ ] **Step 4: Verify both**

```bash
grep -n '\$project' charts/engine/templates/deployment.yaml charts/engine/templates/gateway-deployment.yaml
```

Expected: both show `{{- range $project, $cfg := .Values.projects }}` and `{{ printf "GITHUB_TOKEN__%s" (upper (replace "-" "_" $project)) }}`.

- [ ] **Step 5: Update `values.yaml` comments**

```bash
sed -i '' \
  -e 's/\bproduct\b/project/g' \
  -e 's/\bProduct\b/Project/g' \
  -e 's/<PRODUCT>/<PROJECT>/g' \
  -e 's/product-a/project-a/g' \
  charts/engine/values.yaml
```

- [ ] **Step 6: Verify the comment block reads correctly**

```bash
sed -n '84,96p' charts/engine/values.yaml
```

Expected:
```yaml
# One entry per project. agentops-platform supplies the real list as a values
# override (see docs/superpowers/specs/2026-07-06-project-registry-design.md) —
# this repo ships no real repo names, matching ARCHITECTURE.md §5.8 (the engine
# is project-agnostic). Each entry renders one GITHUB_TOKEN__<PROJECT> env var
# sourced from githubTokenSecretName, plus one row in PROJECT_REGISTRY_JSON.
#
# projects:
#   project-a:
#     repo: flair-hr/project-a
#     githubTokenSecretName: github-token-project-a
projects: {}
```

- [ ] **Step 7: Render the chart and confirm no template errors**

Run: `helm lint charts/engine`
Expected: `0 chart(s) failed`.

Run: `bash charts/engine/tests/run.sh`
Expected: all golden-render assertions pass (this repo's `values.yaml` ships `projects: {}` by default, so the golden output doesn't exercise the renamed loop variable's *output* — but the template must still parse and render without error).

- [ ] **Step 8: Commit**

```bash
git add charts/engine
git commit -m "refactor(chart): rename product to project vocabulary in Helm templates and values"
```

---

### Task 11: Living docs (`ARCHITECTURE.md`, `MILESTONES.md`, `M0-SPEC.md`)

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/MILESTONES.md`
- Modify: `docs/M0-SPEC.md`
- **Not modified:** `AGENTS.md` (zero occurrences — confirmed via `grep -ic product AGENTS.md` returning 0) and every dated file under `docs/superpowers/specs/*.md` / `docs/superpowers/plans/*.md` (historical record, out of scope per the design doc).

- [ ] **Step 1: Run the canonical prose sed on all three docs**

```bash
sed -i '' \
  -e 's/ProductConfig/ProjectConfig/g' \
  -e 's/\bproduct\b/project/g' \
  -e 's/\bProduct\b/Project/g' \
  -e 's/\bPRODUCT\b/PROJECT/g' \
  docs/ARCHITECTURE.md docs/MILESTONES.md docs/M0-SPEC.md
```

- [ ] **Step 2: Revert the one generic (non-concept) usage in `ARCHITECTURE.md`**

Line 5 originally read "An environment where autonomous agents build, verify, and improve a **product** with minimal human involvement" — this is generic English (the software product being built), not the registered-project concept, and the sed pass above incorrectly changed it to "a project". Fix it back:

```bash
grep -n "improve a" docs/ARCHITECTURE.md
```

Expected: line 5 currently reads "...build, verify, and improve a project with minimal human involvement." Manually edit that one line back to "a product":

```bash
sed -i '' '5s/improve a project with/improve a product with/' docs/ARCHITECTURE.md
```

- [ ] **Step 3: Diff-review the full `ARCHITECTURE.md` change for any other generic usage the sed pass may have caught**

```bash
git diff docs/ARCHITECTURE.md
```

Read every changed line. Every other occurrence renamed by this pass refers to the registered-project concept (repo isolation, `agentops.json`, per-project namespaces, the `ProductConfig` type, example paths like `product-a.yaml` → `project-a.yaml`, section headings like "Multi-product topology" → "Multi-project topology" and "Product-defined triggers & jobs" → "Project-defined triggers & jobs") — these are all correct renames, verified during plan-writing by reading each of the 58 original occurrences in context. If a genuinely new generic usage turns up that wasn't in that review, revert just that line the same way as Step 2.

- [ ] **Step 4: Verify `MILESTONES.md` and `M0-SPEC.md`**

```bash
git diff docs/MILESTONES.md docs/M0-SPEC.md
```

Expected: `MILESTONES.md`'s 3 occurrences (all about the project-registry/credential concept) and `M0-SPEC.md`'s 2 occurrences (the `TaskInput`/`ProductConfig` contract description) all read correctly as "project"/"ProjectConfig" — no generic usage in either file (already confirmed during plan-writing).

- [ ] **Step 5: Commit**

```bash
git add docs/ARCHITECTURE.md docs/MILESTONES.md docs/M0-SPEC.md
git commit -m "docs: rename product to project vocabulary in living design docs"
```

---

### Task 12: Full-repo verification

**Files:** none (verification only).

- [ ] **Step 1: Confirm zero remaining code occurrences of the old vocabulary**

```bash
git grep -n "ProductConfig\|DEFAULT_PRODUCT_CONFIG\|InvalidProductConfigError\|parseProductConfig\|loadProductConfig\|product-config\|load-product-config" -- 'packages/*' 'charts/*'
```

Expected: no output. If anything matches, it was missed by an earlier task — go back and fix it there (don't patch it ad hoc in this task; keep the per-package commits accurate).

```bash
git grep -n "\.product\b\|{ product\|product:" -- 'packages/*'
```

Expected: no output (every remaining `product` substring, if any, should only be inside `claude-backend.ts`'s intentionally-excluded comment — verify with the next command).

```bash
git grep -n "\bproduct\b" -- 'packages/*'
```

Expected: exactly one hit — `packages/backends/src/claude/claude-backend.ts`'s "that's a product decision (what budget?)" comment, intentionally excluded in Task 5.

- [ ] **Step 2: Full lint**

Run: `pnpm lint`
Expected: PASS, zero errors.

- [ ] **Step 3: Full typecheck**

Run: `pnpm typecheck`
Expected: PASS, zero errors across all packages — this is the first point since Task 1 where the whole repo typechecks cleanly (each prior task only guaranteed its own package).

- [ ] **Step 4: Full test suite**

Run: `pnpm test`
Expected: PASS, same total test count as on `main` before this rename (renaming doesn't add or remove tests, only their names/fixtures).

- [ ] **Step 5: Policies coverage**

Run: `pnpm test:policies-coverage`
Expected: PASS, coverage percentage unchanged from before this rename (AGENTS.md requires `packages/policies` at 100% branch coverage — confirm this rename didn't regress it).

- [ ] **Step 6: E2E suite**

Run: `pnpm e2e`
Expected: PASS. These tests exercise the full `devCycle` workflow through `TaskInput`/`ProductConfig` (now `ProjectConfig`) — this is the strongest behavioral-equivalence check in the whole plan.

- [ ] **Step 7: Helm chart tests (repeat, now that all tasks have landed)**

Run: `helm lint charts/engine && bash charts/engine/tests/run.sh`
Expected: both green.

- [ ] **Step 8: Confirm the diff is rename-only**

```bash
git diff main --stat
```

Skim the full diff (not just the stat) once more for anything that isn't an identifier, file path, string literal, or comment change — this rename must not have altered any runtime logic (branching, control flow, computed values). If everything above is green and the diff is rename-only, this plan's work is complete.

---

### Task 13: Open the PR, pass CI, and resolve the Bugbot review

**Files:** none (integration / review).

> Sequential and partly asynchronous — CI and Bugbot run on the remote PR.
> **HARD GATE: Do not mark this task complete until ALL Bugbot comments are
> resolved (fixed or replied to) AND CI is green. Check with
> `gh pr view --json reviews,comments` before claiming done.**
>
> Repo-specific note: per [[reference_bugbot_inactive_agentops]], Bugbot has
> historically never responded on this repo's PRs despite retriggers — if
> `gh pr comment --body "bugbot run"` produces no review after a reasonable
> wait, don't block indefinitely on Step 5/6; note in the PR that Bugbot
> didn't respond, consistent with prior PRs here, and proceed once CI is
> green and a subagent code review (Step 3) is clean.
>
> Also note: merging to `main` on this repo auto-builds and pushes 3 Docker
> images and auto-pushes a tag-bump commit directly to `agentops-platform`
> main (no PR gate on that side — see `.github/workflows/ci.yaml`'s
> `bump-platform` job), which ArgoCD then syncs into the live `dev-agents`
> cluster. Expected and fine for a rename-only change, but know it before
> merging, not after.

- [ ] **Step 1: Sync the latest `main`**

```bash
git fetch origin
git merge origin/main
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e && helm lint charts/engine && bash charts/engine/tests/run.sh
```

Resolve conflicts + commit first if any, then fix any fallout from the merge.

- [ ] **Step 2: Push and open the PR**

```bash
git status --short && git rev-parse --abbrev-ref HEAD   # clean tree, on feature branch (not main)
git push -u origin HEAD
gh pr create --repo est1908-agentic-ops/agentops-engine --base main --fill \
  --title "refactor: rename product to project vocabulary"
```

- [ ] **Step 3: Subagent code review**

REQUIRED SUB-SKILL: `requesting-code-review`. Dispatch a code reviewer subagent over the diff (BASE_SHA = merge-base with `main`, HEAD_SHA = HEAD). Fix Critical and Important findings, commit, push, then proceed. Given this is a pure mechanical rename, expect few or no findings — but verify rather than assume.

- [ ] **Step 4: Make every CI check pass**

```bash
gh pr checks --repo est1908-agentic-ops/agentops-engine --watch
```

On failure: `gh run view --repo est1908-agentic-ops/agentops-engine --log-failed`, reproduce locally, fix, commit, push, re-watch. A rename-only PR failing CI almost certainly means a missed occurrence — go back to the relevant task above and fix it there rather than patching ad hoc. Do not proceed while red.

- [ ] **Step 5: Wait for the Bugbot review**

```bash
gh pr view --repo est1908-agentic-ops/agentops-engine --json reviews,comments
gh pr comment --repo est1908-agentic-ops/agentops-engine --body "bugbot run"   # only if it hasn't reviewed yet
```

- [ ] **Step 6: Address each Bugbot comment**

REQUIRED SUB-SKILL: `receiving-code-review`. Verify before acting — reply to false positives; TDD-fix real findings, commit each referencing the finding, push once.

**Then mark each addressed thread resolved** (completion is gated on the unresolved-thread count, not just on having replied/fixed):

```bash
gh api graphql -f query='query($o:String!,$r:String!,$p:Int!){repository(owner:$o,name:$r){pullRequest(number:$p){reviewThreads(first:100){nodes{id isResolved path comments(first:1){nodes{body}}}}}}}' -F o=est1908-agentic-ops -F r=agentops-engine -F p=<number>
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=<thread-id>
```

**After pushing:** return to Step 4 (re-watch CI), then Step 5 (wait for re-review). Loop until Bugbot reports no unresolved comments — or, per the repo-specific note above, it's confirmed non-responsive again.

- [ ] **Step 7: Final verification**

```bash
gh pr checks --repo est1908-agentic-ops/agentops-engine                          # all green
gh pr view --repo est1908-agentic-ops/agentops-engine --json reviews,comments    # no comment left unaddressed
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e && helm lint charts/engine && bash charts/engine/tests/run.sh   # suite green locally
```

Confirm no unresolved review threads remain, then mark this task complete. Do not merge as part of this task — leave the PR open for a final human/operator decision, given the auto-deploy consequence noted above; merging is a separate, explicit action.
