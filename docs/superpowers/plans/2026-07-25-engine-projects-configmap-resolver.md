# Engine: resolve projects from a mounted ConfigMap, not Postgres — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the engine resolve a project's repo/config/token from a mounted `managed-projects` ConfigMap + a shared `GITHUB_TOKEN` secret instead of the Postgres `managed_projects` table, and retire the DB registry, the X25519 credential crypto, the `control` project CRUD, and the gateway ArgoCD plugin route.

**Architecture:** A new `FileManagedProjectStore` reads per-project files from a mounted directory (`/etc/managed-projects/<slug>__project.yaml` + `<slug>__agentops.json`). The resolver reads each project's own token from the K8s Secret named by its `tokenSecret` (via the K8s API — `KubeTokenResolver`) rather than decrypting a per-row blob. (Superseded the earlier single-shared-`GITHUB_TOKEN` idea: per-project by name, RBAC `secrets:get` in `dev-agents`; multiple projects MAY point at one shared Secret.) The platform repo (see the companion Phase-2 plan) owns the files, generates the ConfigMap, and deploys the Tier-2 workers via an ArgoCD ApplicationSet — so the gateway plugin route and `control` CRUD are dead code and get removed.

**Tech Stack:** TypeScript/pnpm monorepo, `node:test`/vitest, Helm chart under `charts/engine`. Adds the `yaml` npm package (engine has no YAML parser today).

Design spec: `../../../../agentops-platform/docs/superpowers/specs/2026-07-24-projects-as-gitops-design.md`.

## Global Constraints

- **This is live-affecting.** The homelab cluster runs this engine. It must land **after** the homelab DB→git migration PR is merged and the three `github-token` secrets exist — never before (no DB fallback; the ConfigMap must be populated first). Coordinate with the Phase-2 platform plan; homelab-first, then template.
- **Determinism boundary:** nothing in `packages/workflows` may do I/O, `Date.now`, `Math.random`, timers, or import from activities/ports/backends. The store/resolver live in `packages/activities` (allowed to do I/O).
- **GitHub-only for now.** The three homelab projects are all `trackerType: 'github'`. The Linear resolution path is retired here, not preserved (no homelab Linear project exists). If Linear returns, re-add it against the ConfigMap the same way.
- **Repo matching uses `normalizeRepo`** (`packages/ports/src/github/parse-ref.ts`) — the file store's `repo` values are full URLs (e.g. `https://github.com/est1908-agentic-ops/agentops-engine`) and must normalize to `owner/repo` for lookup, exactly as the DB store did.

## Shared contract (identical in the Phase-2 platform plan)

- **On disk** (platform repo) `clusters/ops/projects/<slug>/`: `project.yaml` (`project`, `repo`, `tokenSecret`), optional `agentops.json` (verbatim `ProjectConfig`; omit → engine reads it from the repo), optional `worker.yaml` (ApplicationSet-only; the engine ignores it). `<slug>` = `slugifyProject(project)`.
- **ConfigMap `managed-projects`** (namespace `dev-agents`): keys are flattened `<slug>__project.yaml` and `<slug>__agentops.json` (double underscore — slugs are `[a-z0-9-]`, so `__` is an unambiguous separator; ConfigMap keys can't contain `/`). Mounted **read-only at `/etc/managed-projects`** into the worker and gateway. `worker.yaml` is NOT in this ConfigMap.
- **Token** (per-project, K8s-API read): each project's `tokenSecret` names a K8s Secret (key `GITHUB_TOKEN`) that the engine reads via the K8s API (`KubeTokenResolver`; worker+gateway need RBAC `secrets:get` in `dev-agents`). Multiple projects may point `tokenSecret` at the same Secret — homelab uses one shared `github-token` (a classic PAT owned by `est1908`, `repo` scope) for all three.

## File Structure

- Create `packages/activities/src/file-managed-project-store.ts` — the ConfigMap-dir-backed store.
- Create `packages/contracts/src/managed-project-store.ts` — the `ManagedProjectStore` read interface (extracted from the methods consumers actually call).
- Modify `packages/activities/src/resolve-managed-projects.ts` — deps carry a token, not a private key; drop decrypt + Linear.
- Modify `packages/worker/src/main.ts`, `packages/gateway/src/main.ts`, `packages/cli/src/main.ts` — build `FileManagedProjectStore` + read `GITHUB_TOKEN`.
- Modify `charts/engine/templates/deployment.yaml`, `charts/engine/templates/gateway-deployment.yaml`, `charts/engine/values.yaml` — mount the ConfigMap, inject `GITHUB_TOKEN`, drop crypto/CRUD/plugin knobs.
- Delete `packages/activities/src/postgres-managed-project-store.ts`, `packages/activities/src/credential-crypto.ts`, `packages/gateway/src/argocd-project-workers.ts`; remove the CRUD handlers from `packages/control/src/create-control-server.ts`; remove the write side of `packages/contracts/src/managed-project.ts`.

---

### Task 1: `ManagedProjectStore` interface + `FileManagedProjectStore`

**Files:** Create `packages/contracts/src/managed-project-store.ts`, `packages/activities/src/file-managed-project-store.ts`, test `packages/activities/src/file-managed-project-store.test.ts`. Add `"yaml": "^2"` to `packages/activities/package.json`.

**Interfaces:**
- Produces:
  ```ts
  // packages/contracts/src/managed-project-store.ts
  export interface ManagedProjectStore {
    get(repo: string): Promise<ManagedProject | null>;
    getByProject(project: string): Promise<ManagedProject | null>;
    list(): Promise<ManagedProject[]>;
  }
  ```
  (`getByLinearTeamKey` is intentionally omitted — Linear is retired here.) `ManagedProject` reuses the existing `github` variant of `ManagedProjectSchema` minus `credentialSet` semantics (`credentialSet` is always `true` — the token is mounted, not per-row).

- [ ] **Step 1: Write the failing test** — a temp dir with `demo__project.yaml` (`project: Demo App\nrepo: https://github.com/acme/demo\ntokenSecret: github-token`) and `demo__agentops.json` (`{"autoMerge":"all"}`). Assert `store.get('acme/demo')` returns `{ project: 'Demo App', repo: 'acme/demo', config: { autoMerge: 'all', ... }, trackerType: 'github' }`; `store.get('https://github.com/acme/demo')` returns the same (normalizeRepo); `store.list()` has length 1; a project with no `__agentops.json` yields `config: null`.
- [ ] **Step 2: Run it — fails** (module absent).
- [ ] **Step 3: Implement `FileManagedProjectStore`:**
  ```ts
  import { readdir, readFile } from 'node:fs/promises';
  import { parse as parseYaml } from 'yaml';
  import { normalizeRepo } from '@agentops/ports';
  import { ProjectConfigSchema } from '@agentops/contracts';
  // constructor(dir: string). On first call, read dir once:
  //   group files by slug (split filename on '__'); parse <slug>__project.yaml (yaml)
  //   -> {project, repo, tokenSecret}; parse <slug>__agentops.json (json) -> config or null.
  // Build Map keyed by normalizeRepo(repo). get()/getByProject()/list() read the map.
  // Validate config with ProjectConfigSchema; a parse/validation error throws with the slug named.
  ```
- [ ] **Step 4: Run it — passes.**
- [ ] **Step 5: Commit** `feat(activities): FileManagedProjectStore reads managed-projects ConfigMap dir`.

---

### Task 2: Rework the resolver — token from env, no decrypt, no Linear

**Files:** Modify `packages/activities/src/resolve-managed-projects.ts`, `packages/activities/src/resolve-project-config.ts` (deps type only); test `packages/activities/src/resolve-managed-projects.test.ts`.

**Interfaces:**
- Consumes Task 1's `ManagedProjectStore`.
- Produces:
  ```ts
  export interface ManagedProjectRegistryDeps {
    store: ManagedProjectStore;   // was PostgresManagedProjectStore
    token: string;                // was privateKey; the shared GITHUB_TOKEN
  }
  // resolveManagedProjectEntry(deps, repo) and loadManagedProjectRegistry(deps) keep their signatures.
  // resolveManagedProjectEntryByLinearTeamKey is DELETED.
  ```

- [ ] **Step 1: Update the test** — `resolveOne` with a `FileManagedProjectStore` fixture + `token: 'ghp_x'` returns `{ trackerType: 'github', project, repo: normalizeRepo(repo), token: 'ghp_x' }`; DB-miss (`store.get` → null) returns `null`; `loadManagedProjectRegistry` maps `store.list()` through `resolveOne`. Remove the decrypt/Linear test cases.
- [ ] **Step 2: Run — fails** (deps shape changed).
- [ ] **Step 3: Implement** — delete the `decryptForManagedProject` import + calls; `resolveOne` returns `deps.token` directly; delete `resolveManagedProjectEntryByLinearTeamKey` and the linear branch. In `resolve-project-config.ts`, change the deps type to `ManagedProjectRegistryDeps` (only `store.get(repo).config` is used; unchanged behavior).
- [ ] **Step 4: Run — passes.**
- [ ] **Step 5: Commit** `refactor(activities): resolve project token from shared env, drop X25519 + Linear`.

---

### Task 3: Wire the file store into worker / gateway / cli

**Files:** Modify `packages/worker/src/main.ts`, `packages/gateway/src/main.ts`, `packages/cli/src/main.ts`. Tests: the existing boot tests for each (adjust mocks).

**Interfaces:** Consumes Tasks 1–2. Each service builds deps as:
```ts
function buildManagedProjectDeps(): ManagedProjectRegistryDeps | undefined {
  const dir = process.env.MANAGED_PROJECTS_DIR ?? '/etc/managed-projects';
  const token = process.env.GITHUB_TOKEN;
  if (!token) return undefined;
  return { store: new FileManagedProjectStore(dir), token };
}
```

- [ ] **Step 1: Update worker** — replace `buildManagedProjectDeps(pool)` (the `PROJECT_CREDENTIAL_PRIVATE_KEY` + pool version, `main.ts:96-102`) with the above; keep `await deps.store` usage; `loadManagedProjectRegistry(deps)` at boot is unchanged. The `enginePool` stays (run-stats still use it) but no longer feeds the project store.
- [ ] **Step 2: Update gateway** (`main.ts:24-38`) and **cli** (`main.ts:~90`) the same way; delete `PROJECT_CREDENTIAL_PRIVATE_KEY` reads.
- [ ] **Step 3: Run each package's tests + `pnpm typecheck`** — expect green (fix mock deps that referenced the old shape).
- [ ] **Step 4: Commit** `feat(worker,gateway,cli): build project registry from the mounted ConfigMap`.

---

### Task 4: Engine chart — mount ConfigMap, inject GITHUB_TOKEN, drop dead knobs

**Files:** Modify `charts/engine/templates/deployment.yaml`, `charts/engine/templates/gateway-deployment.yaml`, `charts/engine/values.yaml`.

- [ ] **Step 1: values.yaml** — add `githubTokenSecretName: github-token` is already present; add `managedProjectsConfigMapName: managed-projects`. Remove `projectCredentialPrivateKeySecretName`, `projectCredentialPublicKey`, `projectCrudTokenSecretName`, and `gateway.argocdPluginTokenSecretName`. Keep `engineDb.*` (run-stats still use it).
- [ ] **Step 2: worker + gateway deployments** — in each, remove the `PROJECT_CREDENTIAL_PRIVATE_KEY` env block; add:
  ```yaml
  - name: GITHUB_TOKEN
    valueFrom: { secretKeyRef: { name: {{ .Values.githubTokenSecretName }}, key: GITHUB_TOKEN } }
  - name: MANAGED_PROJECTS_DIR
    value: /etc/managed-projects
  ```
  and a volume + mount:
  ```yaml
  volumeMounts:
    - name: managed-projects
      mountPath: /etc/managed-projects
      readOnly: true
  volumes:
    - name: managed-projects
      configMap: { name: {{ .Values.managedProjectsConfigMapName }} }
  ```
  In the gateway template also remove the `ARGOCD_PLUGIN_TOKEN` env block.
- [ ] **Step 3: Render check** — `helm template charts/engine --set githubTokenSecretName=github-token` succeeds; the worker+gateway pods mount `managed-projects` and have `GITHUB_TOKEN`; no `PROJECT_CREDENTIAL_*` / `ARGOCD_PLUGIN_TOKEN` remain.
- [ ] **Step 4: Commit** `feat(chart): mount managed-projects ConfigMap + GITHUB_TOKEN; drop crypto/plugin knobs`.

---

### Task 5: Retire the DB registry, crypto, gateway plugin route, and control CRUD

**Files:** Delete `packages/activities/src/postgres-managed-project-store.ts` (+ test), `packages/activities/src/credential-crypto.ts` (+ test), `packages/gateway/src/argocd-project-workers.ts` (+ test). Modify `packages/gateway/src/create-gateway-server.ts` (remove the `POST /api/v1/getparams.execute` route + `argocdParams`/`argocdPluginToken` deps), `packages/gateway/src/main.ts` (remove `createProjectWorkerParamsProvider` wiring). Modify `packages/control/src/create-control-server.ts` (remove the five `/api/projects` handlers + `isProjectCrudEnabled`/`authorizeProjectCrud` + `projectCredentialPublicKey`/`projectCrudAuthToken` deps) and `packages/control/src/main.ts` (remove `buildManagedProjectStore` + `PROJECT_CREDENTIAL_PUBLIC_KEY`). Trim `packages/contracts/src/managed-project.ts` to the read shape (delete `UpsertManagedProjectRequestSchema`, the Linear variant if unused) and delete `packages/contracts/src/control-projects-api.ts` if now unreferenced.

- [x] **Step 1: Delete the files** listed above and remove their imports/wiring. Keep `control`'s read-only `GET /api/projects` + `/api/registry/repos` but repoint them at a `FileManagedProjectStore` (read-only; console stays a viewer per the spec).
  - Deviation from the plan as written: `projectCrudAuthToken` (`CONTROL_CRUD_TOKEN`, chart value `projectCrudTokenSecretName`) was **kept**, not removed. It was originally added for the managed-project CRUD, but a later security fix (issue #154, commit `caa9561`) reused it to gate `POST /api/platform/runs` and `POST /api/devcycle/runs` too, on top of its existing use for `/api/platform/chats/*`, `PUT /api/tiers`, `PUT /api/settings/self-heal`, and `POST /api/agents/:id/run`. It is also live-configured today in `agentops-platform`'s engine values (`projectCrudTokenSecretName: control-crud-token` + `secrets/engine/control-crud-token.enc.yaml`). Removing it (as this step originally specified) would have silently 401-locked every one of those unrelated mutating routes with no way to reconfigure them. Only the project-CRUD-specific gating (`isProjectCrudEnabled`, `authorizeProjectCrud`) and `projectCredentialPublicKey`/`PROJECT_CREDENTIAL_PUBLIC_KEY` (X25519-only, genuinely dead) were removed; the remaining call sites were consolidated onto the pre-existing `authorizeControlToken`. `/api/projects` GETs themselves are now unauthenticated (no token, no 503) since they expose nothing sensitive.
- [x] **Step 2: `pnpm -r typecheck && pnpm -r test`** — fix every dangling reference until green. Delete tests asserting removed behavior (CRUD 409s, decrypt round-trip, getparams route).
- [x] **Step 3: Commit** `refactor: retire DB project registry, X25519 crypto, control CRUD`. (The gateway ArgoCD plugin route was already retired in an earlier commit on this branch.)
- [ ] **Step 4 (doc, not code): drop the table** — add a line to the engine's deploy notes / the platform `DEPLOY.md`: after cutover verifies healthy, `DROP TABLE managed_projects;` in `agentops_engine` (manual, once). Not scripted against the live cluster. **Still open** — this is a manual one-time operator action against the live `agentops_engine` database in `agentops-platform-homelab`, to be done (and checked off) only after confirming this cutover is deployed and `kubectl get applications -n argocd` / the control console's `/api/projects` reads healthy from the ConfigMap. Do not run it preemptively.

## Self-Review

- **Spec coverage:** resolver swap (Tasks 1–3), chart mount + token (Task 4), retirement of crypto/CRUD/plugin/DB (Task 5), DB drop (Task 5 step 4). Linear explicitly retired (Global Constraints). Config fallback to in-repo `agentops.json` preserved (Task 2 keeps `resolveProjectConfig`'s fallback).
- **Type consistency:** `ManagedProjectRegistryDeps` = `{ store: ManagedProjectStore; token: string }` used identically in Tasks 2–3; `ManagedProjectStore` methods (`get`/`getByProject`/`list`) match Task 1's interface and the file store.
- **Placeholder scan:** exact env names (`GITHUB_TOKEN`, `MANAGED_PROJECTS_DIR`), mount path (`/etc/managed-projects`), key convention (`<slug>__<file>`) are concrete and match the Phase-2 plan's contract.
- **Ordering hazard:** Task 5 must not land before the ConfigMap is populated on the live cluster (Global Constraints) — the whole plan is gated behind the merged homelab migration + `github-token` secret.
