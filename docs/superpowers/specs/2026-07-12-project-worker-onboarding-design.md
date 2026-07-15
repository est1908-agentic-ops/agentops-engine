# Per-project worker onboarding — repo-sourced, chart + ApplicationSet — design

Status: draft v2 · 2026-07-12 · Owner: Artem
Tracks: follow-on to [#31](https://github.com/est1908-agentic-ops/agentops-engine/issues/31) (SP2/SP-4 line) · Parent: [#30](https://github.com/est1908-agentic-ops/agentops-engine/issues/30)
Builds on: the per-project worker mechanism documented in `docs/authoring-project-workflows.md` and the managed project registry (`docs/superpowers/specs/2026-07-08-managed-project-registry-design.md`, shipped) — the `managed_projects` DB table (repo + credential + config) and the `CONTROL_CRUD_TOKEN`-gated control API.
Historical scope: this note records how a Tier-2 worker was designed to be deployed and onboarded. The current lifecycle authority is `docs/software-lifecycle-vision.md`.

> **v2 change:** the worker spec is **read from the project repo** (a `worker` block in `agents.json`) through the per-project token `managed_projects` already stores — **not** stored in new `managed_projects` columns. This keeps the single source of truth in the git-sourced, PR-reviewed manifest (consistent with the whole custom-agent-workflows model) and needs **no DB schema change**. v1's DB-column approach is superseded.
>
> **v3 change (Option A):** the repo-reading generator endpoint is hosted on the **`gateway`**, not `control`. `control` is deliberately **encrypt-only** (registry design §5: it holds only the public key so a console compromise yields ciphertext it cannot decrypt); reading a repo needs the *private* key, which only `worker`/`gateway`/`cli` hold. The gateway already decrypts project tokens and reads repos, so hosting the endpoint there adds **zero new trust surface**, whereas giving `control` the private key would reopen the browser-facing attack surface the registry design closed. v2's "`control` reads repos" is superseded; §5.2/§6.2/§6.3 below reflect Option A.

## 1. Why

SP2 made Tier-2 real: a project authors a custom Temporal workflow, runs it in its own worker, and delegates privileged work back to the engine. But it shipped the **mechanism** (a per-project worker), not the **onboarding ergonomics**. Today, to ship one custom workflow a developer must touch multiple places, the worst of which is a **hand-authored ArgoCD `Application` + Deployment/values/kustomization in the platform repo (`agentops-platform`)** — a separate infra repo the app developer may not own, registered in the root kustomization, that is a *second, manual declaration of "this project has a worker."* The `docs/project-worker/` reference in this repo underlines the gap: it ships the workflow, `worker.ts`, and `agents.json` but **no deploy manifest** — because there was no clean way to author one.

The custom-agent-workflows model already says config is **git-sourced, PR-reviewed, agent-improvable** (master spec §1) — `agents.json` and `worker.ts` already live in the project repo. So the worker's *deployment* spec belongs there too, not split into a second system. This design makes worker deployment **derive from a `worker` block in the project's `agents.json`**, read by the **gateway** (which already decrypts project tokens and reads repos) via the token the registry already holds, and rendered into the cluster by ArgoCD. The end state: onboarding a Tier-2 worker is **one PR in the project repo** — no DB step, no platform-repo step.

## 2. Scope

**In scope:**
- A generic **`project-worker` Helm chart** (engine repo, OCI-published) that renders one worker Deployment from a small parameter set.
- A single **ArgoCD `ApplicationSet`** (platform repo) that fans out one Application per project worker, staged from a git-file generator (Stage 1, bootstrap) to a **repo-sourced plugin generator** (Stage 2).
- An optional **`worker` block in `AgentsManifestSchema`** (`agents.json`), and a **`gateway` generator endpoint** that reads it from each managed project's repo via `ScmPort.readFile`.
- The **`proj-<project>` task-queue convention** and the invariant tying the worker Deployment to the `agents.json` schedule.

**Out of scope** (explicitly deferred, not forgotten):
- **Building** the worker image — the project's own CI, unchanged from SP2 §5.
- **Provisioning a project's own external secrets** (e.g. a Rollbar token). The `worker` block *references* them by K8s Secret name; creating those Secrets stays a SOPS step in the platform repo (§8). This is the project's *own* credential, a separate and smaller coupling — and most Tier-2 workers that only orchestrate `engineActivities()` + `childDevCycle()` need none.
- **Any `managed_projects` schema change** — v2 needs none; the registry is read, not extended.
- **Per-project Temporal namespace / vcluster / network isolation** — the untrusted-tenant escalation path (SP2 §7.3, §15), still deferred until an untrusted project appears.

## 3. The Temporal model this rests on (recap, not a change)

Confirmed against the code so the design rests on how Temporal actually behaves, not an assumption:

- **One Temporal cluster, one shared namespace per environment** (`dev-agents` / `prod-agents`), configured via `TEMPORAL_NAMESPACE` (`packages/worker/src/main.ts:462`; `charts/engine/values.yaml:80`). The engine ensures the namespace exists (`charts/engine/templates/temporal-namespace-job.yaml`) and registers the `project`/`agentName`/`workflowType` search attributes in it (`packages/worker/src/ensure-search-attributes.ts`).
- **Temporal has no worker registry.** A worker is a process that connects to the namespace and **long-polls a named task queue**, advertising the workflow/activity types compiled into it. "Registration" is not a Temporal concept — it is *"a process is polling queue Q with the code."*
- **Routing is intra-namespace only.** The engine reconciler starts a workflow **by name on a task queue** (`taskQueue = deps.taskQueue ?? ENGINE_QUEUE`, `packages/activities/src/schedule-ops.ts:77`); whatever worker polls that queue runs it. `childDevCycle()` / `engineActivities()` route back to `ENGINE_QUEUE` the same way. All of this only works because engine and project workers share one namespace — which is *why* the namespace stays shared (SP2 §7.1; the per-project-namespace trade-off is settled in §9 below).

So a per-project worker is "registered" purely by **connecting to the shared namespace and polling its own queue**. This design automates the *Deployment* that does that; it changes nothing about Temporal itself.

## 4. The generic `project-worker` chart

A single chart at `charts/project-worker/` in the engine repo, **OCI-published by engine CI exactly like `charts/engine`** (`oci://gitactions.est1908.top/agentic-ops/project-worker`; its chart version bumped by the same `scripts/bump-platform-engine-tags.sh` mechanism). One chart, N releases — one ArgoCD Application per project worker.

It renders a **Deployment** running the project's worker image + a **ServiceAccount** with no special RBAC. Values (all per-release):

| Value | Meaning | Default |
|---|---|---|
| `project` | project slug (identity) | required |
| `image` | the **project-built** worker image ref (`repo:tag` or `repo@digest`) | required |
| `taskQueue` | queue the worker polls | `proj-<project>` (§7) |
| `replicas` | worker replicas | `1` |
| `temporal.address` / `temporal.namespace` / `temporal.tls*` | Temporal connection — the **same shared namespace** the engine uses | from platform values |
| `externalSecretRefs` | list of K8s Secret names to mount as env (the project's *own* externals) | `[]` |
| `otel.endpoint` | OTLP endpoint for the worker's own orchestration spans | from platform values |
| `resources` | requests/limits | small default |

The chart is **agnostic to where its values come from** — the ApplicationSet supplies them (from a git file in Stage 1, from the repo-sourced generator in Stage 2). `project`/`image`/`taskQueue`/`replicas`/`externalSecretRefs`/`resources` map 1:1 to the repo `worker` block (§6.1); `temporal.*` and `otel.*` are cluster-wide platform values shared with the engine app.

**Two version axes, kept distinct** (a common source of confusion, called out deliberately):
- the **chart version** — engine-owned, shared, bumped by engine CI (the *how-to-run*);
- the **image tag** — project-owned, per-project, written by the project's CI into `agents.json` (the *what-to-run*; §6.3).

### 4.1 What the chart deliberately does NOT do

These are engine responsibilities; duplicating them in the project worker would race or diverge:
- **No `temporal-namespace-job`** — the namespace already exists (engine-created); the worker only connects.
- **No search-attribute registration** — the engine registers `project`/`agentName`/`workflowType` in the shared namespace at startup; a workflow started on `proj-<project>` in that same namespace inherits them for free.
- **No engine credentials** — this omission *is* the SP2 §7.1 security boundary. The pod mounts only Temporal connection config + its own `externalSecretRefs`. Agent OAuth and per-project SCM tokens live **only** on the engine's activity workers; the project worker requests privileged work via `engineActivities()`, which the engine executes after the identity check (SP2 §7.2).

## 5. The ArgoCD ApplicationSet

A single `ApplicationSet` at `clusters/ops/project-workers/` in the platform repo, registered **once** in `clusters/ops/kustomization.yaml`. Its template emits an Application per generator element whose source is the OCI `project-worker` chart (the same `oci://gitactions.est1908.top/agentic-ops/…` scheme the engine app uses, `clusters/ops/engine/application.yaml`), with the per-project values supplied **inline** as a helm `valuesObject` templated from the generator element (`{{.project}}`, `{{.image}}`, `{{.taskQueue}}`, …) — so no per-app git values file is needed. Only the **generator** changes between stages; the template is identical.

### 5.1 Stage 1 — git-file generator (bootstrap, de-risks the chart)

The generator reads a single `clusters/ops/project-workers/workers.yaml` in the platform repo:

```yaml
# workers.yaml — throwaway bootstrap list, one entry per Tier-2 worker
- project: acme
  image: gitactions.est1908.top/acme/agentops-worker:<tag>
  # taskQueue omitted -> defaults to proj-acme
```

This ships the generic chart + ApplicationSet and proves the deploy path end-to-end **with no engine/control code**, before building the repo-read path. It is an explicit, short-lived bootstrap — its `workers.yaml` entries migrate into the repo `worker` block when Stage 2 lands (§15).

### 5.2 Stage 2 — repo-sourced plugin generator (the end state)

Swap the git-file generator for an ArgoCD **plugin generator** pointed at the **gateway** endpoint (§6.2). The gateway reads the `worker` block from **each managed project's repo** (via `ScmPort.readFile` with the token in `managed_projects`) and returns one element per project that declares a worker. Onboarding then is **one PR in the project repo** — the `worker` block + the workflow; the project's CI writes the image tag into `agents.json` on release (§6.3). **The platform repo is never touched per project;** it holds only the one-time ApplicationSet + the plugin-generator config (base URL + token Secret).

**Fail-safe (§6.4)** governs what happens when a repo read fails: the generator serves last-good and never prunes a live worker on a transient read error.

## 6. Repo-sourced worker spec & generator endpoint

### 6.1 The `worker` block (`agents.json`)

`AgentsManifestSchema` (`packages/contracts`, `z.strict()`) gains an **optional** `worker` object. Its presence is what marks a project **Tier-2** (a config-only Tier-1 project has `agents` but no `worker`; its agents run on `ENGINE_QUEUE`):

```jsonc
{
  "agents": [
    { "name": "rollbar", "workflow": "rollbarMonitor", "schedule": "continuous" }
    // taskQueue omitted -> defaults to proj-<project> for a project workflow (§7)
  ],
  "worker": {
    "image": "gitactions.est1908.top/acme/agentops-worker:<sha>",  // required if `worker` present
    "taskQueue": "proj-acme",        // optional; default proj-<project>
    "replicas": 1,                        // optional; default 1
    "externalSecrets": ["rollbar-token"]  // optional; K8s Secret names, no values
  }
}
```

```ts
export const ProjectWorkerSchema = z.object({
  image: z.string().min(1),
  taskQueue: z.string().min(1).optional(),
  replicas: z.number().int().positive().default(1),
  externalSecrets: z.array(z.string().min(1)).default([]),
}).strict();
// AgentsManifestSchema += worker: ProjectWorkerSchema.optional()
```

(Pod `resources` are left to the chart's default rather than the manifest — YAGNI until a project needs to tune them; adding a `resources` field later is additive.)

The `worker` block is parsed by the same `parseAgentsManifest` that already parses `agents`, so the worker spec and the schedule spec come from one parse of one file. No secret ever appears in it (only Secret *names*).

### 6.2 Generator endpoint (`packages/gateway`)

The endpoint lives on the **gateway**, not `control` — see the v3 note: `control` is encrypt-only and cannot read repos, but the gateway already holds the private key (`PROJECT_CREDENTIAL_PRIVATE_KEY`) and reads project repos for its webhook flows, so this adds zero new trust surface.

New route **`POST /api/v1/getparams.execute`** (ArgoCD's plugin-generator wire contract) → `{ output: { parameters: [{ project, image, taskQueue, replicas }] } }`, one entry per managed project whose `agents.json` has a `worker` block. Gated by `Authorization: Bearer <ARGOCD_PLUGIN_TOKEN>` (ArgoCD's plugin generator sends this from a Secret); the route 404s when the token is unset (feature off, same posture as the Linear webhook route). A `createProjectWorkerParamsProvider({ managedProjectDeps, buildScm })` (reusing the gateway's existing `loadManagedProjectRegistry` + `buildScm`):
1. lists + resolves each managed project (decrypting its token — the gateway already does this);
2. reads `agents.json` via `ScmPort.readFile`, parses it, and emits a param **only** if it has a `worker` block;
3. defaults `taskQueue` to `proj-<project>` and stringifies `replicas` (ArgoCD params are string-valued).

No secret is ever returned (only image/queue/replicas/project).

### 6.3 Image-tag flow

The project's CI builds/pushes its worker image and **writes the tag into `agents.json`'s `worker.image`** on release (git-write-back), mirroring the engine's own `scripts/bump-platform-engine-tags.sh`. The deployed image is then visible and diffable in the project repo's history next to the code that produced it. A mutable `:latest` tag is rejected — it defeats ArgoCD change detection and auditability.

### 6.4 Read fail-safe

Reading N repos per reconcile introduces a dependency on repo availability. ConfigSync **already** depends on repo reads every reconcile and already has the discipline for this (master §3.2: a failed/malformed read leaves last-good in place, never partial-applies). The generator endpoint reuses it: a per-project read failure **omits nothing** — it serves the last-good entry for that project (short-lived in-memory cache) and never returns an empty/partial list that would make ArgoCD prune a running worker. A project that *removes* its `worker` block (a real, successful read) is the only way a worker is torn down.

## 7. Task-queue convention & the deploy↔schedule invariant

Two facts must agree on a task-queue name, and **neither is a Temporal registration**:

- **(a)** *a process polls queue `Q` with the code* — the **worker Deployment** (`worker.taskQueue`);
- **(b)** *start workflow `W` on queue `Q`* — the **`agents.json` agent `taskQueue`** → ConfigSync → a Schedule/singleton.

Under v2 **both live in the same `agents.json`**, so they align by construction. To make mismatch impossible even when omitted, both default from project identity:

- **Convention:** a Tier-2 project workflow's queue defaults to **`proj-<project>`**.
- **Reconciler default:** the effective queue is `spec.taskQueue ?? (isBuiltin(spec.workflow) ? ENGINE_QUEUE : projQueue(project))` — built-ins (`devCycle`/`whiteboxBugHunt`/`qaProbe`) keep defaulting to `ENGINE_QUEUE` (unchanged from `schedule-ops.ts:77`); a *project* workflow defaults to `proj-<project>`. This is the one behavioral change to queue resolution, and it is additive: absent `taskQueue` for a project workflow used to fall through to `ENGINE_QUEUE`, where no engine worker has the code — i.e. it never worked; now it resolves correctly.
- **`worker.taskQueue` default:** likewise `proj-<project>`.

So for the common case nobody types a queue name anywhere; both sides compute `proj-acme` from the slug. Explicit `taskQueue` is override-only.

**Safety surface (no silent misconfig):** ConfigSync, when it schedules a project (non-built-in) workflow, checks the same manifest for a `worker` block and **surfaces a warning** in reconcile status if there is none — "scheduled `rollbarMonitor` on `proj-acme` but the manifest declares no `worker` to run it." Non-blocking (the worker Application may sync moments later), but it turns the most likely onboarding mistake from a silent pending workflow into a visible signal. Because both live in one file, this check is a pure function of the parsed manifest — no cross-system lookup.

## 8. Project-owned external secrets (the one residual coupling)

A worker that talks to an external source (the canonical Rollbar monitor) needs its *own* secret, mounted via `externalSecrets`. That Secret still has to exist in the cluster, and it is genuinely the project's secret — not engine credentials. For now it is provisioned the same way every other secret is: **SOPS-encrypted in `agentops-platform`**, decrypted into a K8s Secret at deploy time. The `worker` block only references it by name.

Called out, not solved, because: (a) it is a *smaller* coupling than the workload one this design removes; (b) most Tier-2 workers (pure orchestration over `engineActivities()` + `childDevCycle()`) need none — including acme's case as understood today; (c) collapsing it into the repo/DB would mean storing a second class of project secret, reopening a threat surface the registry design deliberately closed. A future pass can extend the registry's X25519 scheme to project-owned externals if the manual SOPS step becomes painful.

## 9. Topology decision (settled, recorded here)

- **Single shared Temporal namespace per environment** — kept. Per-project namespaces would break the Tier-2 delegation model (no cross-namespace `executeChild`/activity routing; `childDevCycle()`/`engineActivities()` on `ENGINE_QUEUE` would need Temporal Nexus or a claim-checked relay), multiply operational overhead (per-namespace create + retention + search-attribute registration), and fragment cross-project visibility. The isolation it buys (a hard boundary against *hostile* in-namespace code) defends a threat trusted, PR-reviewed org projects don't carry; accidental cross-project action is already handled by the credential-delegation binding (SP2 §7.2). The trigger to revisit is an untrusted/client project — the deferred escalation path (SP2 §15).
- **Per-project routing separation via the `proj-<project>` task queue** (§7) gives clean per-project *routing* without paying for per-project *namespace* isolation.
- **K8s namespace:** project workers run in the same `dev-agents` namespace as the engine (matching reality; SP2 §7.1's aspirational `proj` namespace is not required — the security property is *what is mounted*, not namespace separation). The chart parameterizes `temporal.namespace` and the target K8s namespace, so a future split costs nothing at the deployment layer.

## 10. Onboarding runbooks

**Stage 1 (bootstrap, git-file):**
1. Project CI builds & pushes its worker image.
2. Append an entry to `agentops-platform`'s `clusters/ops/project-workers/workers.yaml` (`project`, `image`).
3. Merge → ArgoCD syncs → worker Deployment polls `proj-<project>`.
4. Project `agents.json` references the workflow (queue defaults to `proj-<project>`); ConfigSync starts it.

**Stage 2 (repo-sourced — the end state):**
1. In the **project repo**, one PR: the workflow + `worker.ts` + an `agents.json` with a `worker` block and the agent entries.
2. Project CI builds the image and writes the tag into `agents.json`'s `worker.image` (git-write-back).
3. the gateway's generator reads the block; the ApplicationSet plugin generator deploys the worker on the next reconcile; ConfigSync schedules the agents on `proj-<project>`. **No platform PR, no DB step.**

## 11. Contract & vocabulary changes (summary)

| Change | Location | Why | Deliberate? |
|---|---|---|---|
| `ProjectWorkerSchema`; `AgentsManifestSchema += worker?` | `contracts` (strict) | Repo-sourced worker spec; presence ⇒ Tier-2 (§6.1) | strict-schema change |
| `POST /api/v1/getparams.execute` (reads repos) | `gateway` | ArgoCD plugin-generator source (§6.2) | new route |
| `createProjectWorkerParamsProvider` (reuses `loadManagedProjectRegistry` + `buildScm`) | `gateway` | Read the `worker` block via the registry token, keeping `control` encrypt-only (§6.2) | new |
| Project-workflow queue defaults to `proj-<project>` | reconciler (`policies`/`activities`) | Deploy↔schedule invariant (§7) | behavior (additive) |
| `charts/project-worker/` | engine repo (OCI-published) | Generic worker Deployment (§4) | new chart |
| `clusters/ops/project-workers/` ApplicationSet (+ root kustomization) | `agentops-platform` | Fan-out per worker (§5) | new (one-time) |
| **No `managed_projects` schema change** | — | Registry is read, not extended (v2) | — |

## 12. Decomposition into sub-projects

| # | Sub-project | Delivers |
|---|---|---|
| **SP-a** | **Chart + git-file ApplicationSet** | `charts/project-worker/` (+ render golden test); the ApplicationSet with the Stage-1 git-file generator + `workers.yaml`; `docs/project-worker/` gains its deploy note; docs. Proves the deploy path with **no engine/control code** — Stage-1 projects set an explicit `taskQueue` in `agents.json` (already supported since SP2), so the `proj-<project>` default isn't needed yet. |
| SP-b | Repo-sourced generator + queue convention | `ProjectWorkerSchema` + `AgentsManifestSchema.worker?` (§6.1); the **gateway** `POST /api/v1/getparams.execute` reading repos via `ScmPort` + the read fail-safe (§6.2, §6.4); the `proj-<project>` reconciler default + the deploy↔schedule safety warning (§7, which needs the `worker` block to check against); swap the ApplicationSet to the plugin generator + read-token Secret; Mission Control surface (folds into #30's SP4 line). **Onboarding = one project PR.** |

Order SP-a → SP-b. SP-a de-risks the chart/deploy path independently (no engine/control changes); SP-b makes onboarding repo-sourced and adds the queue-default convenience on a proven surface. (SP-a's `workers.yaml` is an explicit throwaway; its entries migrate into repo `worker` blocks in SP-b — §15.)

## 13. Testing strategy

- **`contracts`:** `ProjectWorkerSchema` tests (image required; `replicas`/`externalSecrets` defaults; `resources` optional; strictness rejects unknown keys); `AgentsManifestSchema` accepts a manifest with and without `worker`.
- **`gateway`:** the params provider unit-tested with a fake registry + fake `ScmPort` — returns only projects whose manifest has a `worker` block, defaults `taskQueue` to `proj-<project>`, exposes no secrets; **fail-safe test** — a transient read error serves last-good and never drops a live worker (and a *successful* read removing the block does drop it); the route: 404 when unconfigured, 401 on a bad bearer token, and the `{ output: { parameters } }` shape on success.
- **`policies`/reconciler:** queue resolution — built-in → `ENGINE_QUEUE`; project workflow, no `taskQueue` → `proj-<project>`; explicit override respected; the "custom workflow scheduled but manifest has no `worker`" warning fires.
- **Chart:** `charts/project-worker/` render golden test (mirrors `charts/engine/tests/render.golden.yaml`): the Deployment polls `proj-<project>` by default, mounts `externalSecrets`, and mounts **no** engine secrets / **no** namespace-job / **no** search-attribute registration.
- **ApplicationSet:** template render for a sample `workers.yaml` (Stage 1) producing a valid Application with the right OCI chart source + inline values.
- **Green bar:** `pnpm lint && pnpm typecheck && pnpm test`; `pnpm e2e` (touches the reconciler queue-resolution change; the gateway repo-read path).

## 14. Definition of done

**SP-a**
- [ ] `charts/project-worker/` renders a worker Deployment + ServiceAccount from the §4 values; render golden test proves the `taskQueue` value is honored, the mounted externals, and the *absence* of engine secrets / namespace-job / SA registration.
- [ ] Engine CI OCI-publishes `project-worker` and bumps its chart version alongside the engine chart.
- [ ] `agentops-platform`: the `project-workers` ApplicationSet (Stage-1 git-file generator) + `workers.yaml` + root-kustomization registration; acme onboarded through it end-to-end (worker polls `proj-acme` via an explicit `taskQueue` in its `agents.json`, its scheduled workflow runs).
- [ ] `docs/project-worker/` gains its onboarding note.
- [ ] `pnpm lint && typecheck && test` green; `pnpm e2e` green.

**SP-b**
- [ ] `ProjectWorkerSchema` + `AgentsManifestSchema.worker?` in `contracts` (+ tests); `docs/project-worker/` gains its `worker` block.
- [ ] Reconciler defaults a project workflow's queue to `proj-<project>` and warns when scheduling a custom workflow whose manifest declares no `worker` — with tests.
- [ ] Gateway `POST /api/v1/getparams.execute` reads `agents.json` via `ScmPort` (token from the registry), returns worker specs, no secrets, bearer-token-gated, with the read fail-safe — all tested. (`control` stays encrypt-only — Option A.)
- [ ] ApplicationSet swapped to the plugin generator + read-token Secret; onboarding a worker via a **project PR only** (no platform PR) verified on dev-agents. *(agentops-platform follow-on PR — can only land after this deploys.)*
- [ ] Mission Control shows the repo-derived worker state. *(Deferred to #30's SP4 line — the generator's consumer is ArgoCD, not the UI; not required for repo-sourced onboarding.)*
- [ ] Specs updated if implementation deviates.

## 15. Open questions

- **`worker` block location** (§6.1) — top-level key in `agents.json` (chosen: one file, one read, presence encodes Tier-2) vs. a sibling `agentops/worker.json`. Lean `agents.json`; revisit only if the two concerns need independent PR ownership.
- **Plugin-generator token** (§5.2) — **resolved:** a dedicated `ARGOCD_PLUGIN_TOKEN` on the gateway (least privilege; the generator only reads), sent as `Authorization: Bearer`. Not `CONTROL_CRUD_TOKEN`.
- **Endpoint host** (§6.2) — **resolved (Option A):** hosted on the `gateway`, which already decrypts project tokens and reads repos. `control` stays encrypt-only; it never gains the private key or an `ScmPort`. (Superseded v2's "control reads repos".)
- **`workers.yaml` → repo migration** (§10, §12) — when SP-b lands, each Stage-1 `workers.yaml` entry becomes a `worker` block in that project's `agents.json`; the platform `workers.yaml` is then deleted. One PR per project; no tooling.
