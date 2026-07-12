# Per-project worker onboarding — DB-driven, chart + ApplicationSet — design

Status: draft v1 · 2026-07-12 · Owner: Artem
Tracks: follow-on to [#31](https://github.com/est1908-agentic-ops/agentops-engine/issues/31) (SP2/SP-4 line) · Parent: [#30](https://github.com/est1908-agentic-ops/agentops-engine/issues/30)
Builds on: SP2 (`docs/superpowers/specs/2026-07-12-custom-agent-workflows-sp2-design.md`, shipped in #37) — the per-project worker mechanism, `ENGINE_QUEUE`, `AgentSpec.taskQueue`, identity binding; and the managed project registry (`docs/superpowers/specs/2026-07-08-managed-project-registry-design.md`, shipped) — the `managed_projects` DB table, encrypt-only `control`, the `CONTROL_CRUD_TOKEN`-gated CRUD API.
Design authority: this doc governs *how a Tier-2 worker is deployed and onboarded*. It does not change the Tier ladder, the delegation/authorization model (SP2 §7), or the Temporal topology — it fills the gap SP2 left open (§15 named the *mechanism*; onboarding *ergonomics* were unaddressed).

## 1. Why

SP2 made Tier-2 real: a project authors a custom Temporal workflow, runs it in its own worker, and delegates privileged work back to the engine. But it shipped the **mechanism** (a per-project worker), not the **onboarding ergonomics**. Today, to ship one custom workflow a developer must touch **three** places:

1. **the project repo** — the workflow code + `worker.ts` + `agents.json` (correct; this is where custom logic belongs);
2. **the `managed_projects` DB row** — credentials + config (correct; the registry design deliberately moved this off the platform repo so *"a repo can be fully onboarded without ever being touched"*);
3. **the platform repo (`agentops-platform`)** — a hand-authored ArgoCD `Application` + Deployment/values/kustomization, registered in the root kustomization, **in a separate infra repo the app developer may not own.**

Step 3 is the wart. It is a *second, manual declaration* of "this project has a worker" that is **redundant with the DB row that already says the project exists**, lives in the wrong repo, and requires a platform PR + ArgoCD sync per project. The `examples/project-worker/` reference in this repo underlines the gap: it ships the workflow, `worker.ts`, and `agents.json` but **no deploy manifest** — because there was no clean way to author one.

This design makes worker deployment **derive from the registry** so onboarding a Tier-2 worker is, in the end state, *a field on the project's DB row* — no per-project platform edit at all — while keeping ArgoCD as the owner of what runs in the cluster (drift detection, rollback, audit intact).

## 2. Scope

**In scope:**
- A generic **`project-worker` Helm chart** (engine repo, OCI-published) that renders one worker Deployment from a small parameter set.
- A single **ArgoCD `ApplicationSet`** (platform repo) that fans out one Application per project worker, staged from a git-file generator (Stage 1) to a DB-backed plugin generator (Stage 2).
- Additive **`managed_projects`** columns (`worker_image`, `worker_task_queue`, `worker_enabled`) + the matching `contracts`/CRUD-API/CLI surface.
- The **`proj-<project>` task-queue convention** and the invariant that ties the worker Deployment to the `agents.json` schedule.

**Out of scope** (explicitly deferred, not forgotten):
- **Building** the worker image — the project's own CI, unchanged from SP2 §5.
- **Provisioning a project's own external secrets** (e.g. a Rollbar token). The chart *references* them by K8s Secret name; creating those Secrets stays a SOPS step in the platform repo for now (§8). This is the project's *own* credential, a separate and smaller coupling — and most Tier-2 workers that only orchestrate `engineActivities()` + `childDevCycle()` need none.
- **Per-project Temporal namespace / vcluster / network isolation** — the untrusted-tenant escalation path (SP2 §7.3, §15), still deferred until an untrusted project appears.
- **Non-additive DB migrations** — the registry's `ADD COLUMN IF NOT EXISTS` policy (managed-project-registry §4.1) covers everything here.

## 3. The Temporal model this rests on (recap, not a change)

Confirmed against the code so the design rests on how Temporal actually behaves, not an assumption:

- **One Temporal cluster, one shared namespace per environment** (`dev-agents` / `prod-agents`), configured via `TEMPORAL_NAMESPACE` (`packages/worker/src/main.ts:462`; `charts/engine/values.yaml:80`). The engine ensures the namespace exists (`charts/engine/templates/temporal-namespace-job.yaml`) and registers the `project`/`agentName`/`workflowType` search attributes in it (`packages/worker/src/ensure-search-attributes.ts`).
- **Temporal has no worker registry.** A worker is a process that connects to the namespace and **long-polls a named task queue**, advertising the workflow/activity types compiled into it. "Registration" is not a Temporal concept — it is *"a process is polling queue Q with the code."*
- **Routing is intra-namespace only.** The engine reconciler starts a workflow **by name on a task queue** (`taskQueue = deps.taskQueue ?? ENGINE_QUEUE`, `packages/activities/src/schedule-ops.ts:77`); whatever worker polls that queue runs it. `childDevCycle()` / `engineActivities()` route back to `ENGINE_QUEUE` the same way. All of this only works because engine and project workers share one namespace — which is *why* the namespace stays shared (SP2 §7.1; the per-project-namespace trade-off is settled there and in §9 below).

So a per-project worker is "registered" purely by **connecting to the shared namespace and polling its own queue**. This design automates the *Deployment* that does that; it changes nothing about Temporal itself.

## 4. The generic `project-worker` chart

A single chart at `charts/project-worker/` in the engine repo, **OCI-published by engine CI exactly like `charts/engine`** (`oci://gitactions.est1908.top/agentic-ops/project-worker`; its chart version bumped by the same `scripts/bump-platform-engine-tags.sh` mechanism that bumps the engine chart). One chart, N releases — one ArgoCD Application per project worker.

It renders:
- a **Deployment** running the project's worker image, and
- a **ServiceAccount** with no special RBAC.

Values (all per-release):

| Value | Meaning | Default |
|---|---|---|
| `project` | project slug (identity) | required |
| `image` | the **project-built** worker image ref (`repo:tag` or `repo@digest`) | required |
| `taskQueue` | queue the worker polls | `proj-<project>` (§7) |
| `replicas` | worker replicas | `1` |
| `temporal.address` / `temporal.namespace` / `temporal.tls*` | Temporal connection — the **same shared namespace** the engine uses | from platform values |
| `externalSecretRefs` | list of K8s Secret names to mount as env (the project's *own* externals, e.g. a Rollbar token) | `[]` |
| `otel.endpoint` | OTLP endpoint for the worker's own orchestration spans | from platform values |
| `resources` | requests/limits | sane small default |

**Two version axes, kept distinct** (a common source of confusion, called out deliberately):
- the **chart version** — engine-owned, shared, bumped by engine CI (the *how-to-run*);
- the **image tag** — project-owned, per-project, built by the project's CI (the *what-to-run*).

### 4.1 What the chart deliberately does NOT do

These are engine responsibilities; duplicating them in the project worker would race or diverge:
- **No `temporal-namespace-job`** — the namespace already exists (engine-created); the worker only connects.
- **No search-attribute registration** — the engine registers `project`/`agentName`/`workflowType` in the shared namespace at startup; a workflow started on `proj-<project>` in that same namespace inherits them for free.
- **No engine credentials** — this omission *is* the SP2 §7.1 security boundary. The pod mounts only Temporal connection config + its own `externalSecretRefs`. Agent OAuth and per-project SCM tokens live **only** on the engine's activity workers; the project worker requests privileged work via `engineActivities()`, which the engine executes after the identity check (SP2 §7.2).

## 5. The ArgoCD ApplicationSet

A single `ApplicationSet` at `clusters/ops/project-workers/` in the platform repo, registered **once** in `clusters/ops/kustomization.yaml`. Its template emits an Application per generator element whose source is the OCI `project-worker` chart (the same `oci://gitactions.est1908.top/agentic-ops/…` scheme the engine app uses, `clusters/ops/engine/application.yaml`), with the per-project values supplied **inline** as a helm `valuesObject` templated from the generator element (`{{.project}}`, `{{.image}}`, `{{.taskQueue}}`, …) — so no per-app git values file is needed. Only the **generator** changes between stages; the template is identical.

### 5.1 Stage 1 — git-file generator (ships first, fully GitOps)

The generator reads a single `clusters/ops/project-workers/workers.yaml`:

```yaml
# workers.yaml — one entry per Tier-2 project worker
- project: broccoli
  image: gitactions.est1908.top/broccoli/agentops-worker:<tag>
  # taskQueue omitted -> defaults to proj-broccoli
```

Onboarding a worker = **append ~3 lines** + merge; ArgoCD syncs the new Application. This kills the "hand-write a whole app directory + register it in the root kustomization" cost while staying 100% GitOps — the worker list is in git, diffable, revertable. It is the low-risk 90% win with almost no new machinery.

### 5.2 Stage 2 — plugin generator (DB-driven, zero platform touch)

Swap the git-file generator for an ArgoCD **plugin generator** pointed at a new `control` endpoint (§6.3) that returns one element per `managed_projects` row with a non-null `worker_image`. Onboarding then becomes **`engine project update --worker-image repo:tag`** (or a Mission Control action) — the platform repo is **never touched per project**; it holds only the one-time ApplicationSet.

The plugin generator needs a Secret in the `argocd` namespace with the control base URL + a read token (the existing `CONTROL_CRUD_TOKEN`, or a dedicated read-only token — pinned in the plan). The endpoint returns **no secrets** — only `project`/`image`/`taskQueue`/`enabled`.

**Net platform-repo footprint after Stage 2:** one ApplicationSet, authored once. Per-project: nothing.

## 6. Data model & control surface

### 6.1 `managed_projects` columns (additive)

Appended to the registry's `ensureSchema()` per the `ADD COLUMN IF NOT EXISTS` policy (managed-project-registry §4.1):

```sql
ALTER TABLE managed_projects ADD COLUMN IF NOT EXISTS worker_image TEXT;        -- null => config-only (Tier 1), no worker
ALTER TABLE managed_projects ADD COLUMN IF NOT EXISTS worker_task_queue TEXT;   -- null => default proj-<project>
ALTER TABLE managed_projects ADD COLUMN IF NOT EXISTS worker_enabled BOOLEAN NOT NULL DEFAULT true; -- pause without dropping the row
```

`worker_image IS NULL` is the discriminator between a config-only Tier-1 project and one that runs a Tier-2 worker. `worker_enabled=false` lets you stop a worker (generator drops it → ArgoCD prunes the Deployment) without losing its config.

### 6.2 Contracts (`packages/contracts`)

Extend `ManagedProjectSchema` and `UpsertManagedProjectRequestSchema` with an optional, nullable `worker` sub-object (never carries secrets):

```ts
export const ProjectWorkerSchema = z.object({
  image: z.string().min(1),
  taskQueue: z.string().min(1).optional(),  // default proj-<project> at resolution time
  enabled: z.boolean().default(true),
});
// ManagedProjectSchema += worker: ProjectWorkerSchema.nullable()
// UpsertManagedProjectRequestSchema += worker: ProjectWorkerSchema.nullable().optional()
```

### 6.3 Control API (`packages/control`)

- The existing CRUD routes (`GET/POST/PUT/DELETE /api/projects`) round-trip the new `worker` field (no token, ever — same as today).
- **New generator route** (Stage 2): `GET /api/argocd/project-workers` → `[{ project, image, taskQueue, enabled }]` for every row with `worker_image` set, shaped for the ApplicationSet plugin generator. `CONTROL_CRUD_TOKEN`-gated (via `X-Control-Crud-Token`, as the CRUD routes already are). No decryption, no secrets — safe for `control`'s encrypt-only posture.

### 6.4 CLI (`packages/cli`)

`engine project add|update` gain `--worker-image`, `--worker-task-queue`, `--worker-enabled/--no-worker-enabled`. `engine project show`/`list` display the worker fields. Thin HTTP clients of the routes above, consistent with the registry design.

## 7. Task-queue convention & the deploy↔schedule invariant

Two facts must agree on a task-queue name, and **neither is a Temporal registration**:

- **(a)** *a process polls queue `Q` with the code* — the **Deployment** (`worker_task_queue`);
- **(b)** *start workflow `W` on queue `Q`* — the **`agents.json` `taskQueue`** → ConfigSync → a Schedule/singleton.

If they disagree, the reconciler starts a workflow on a queue nobody polls and it sits pending. To make mismatch **impossible by default**, both derive the queue from project identity:

- **Convention:** a Tier-2 project workflow's queue defaults to **`proj-<project>`**.
- **Reconciler default:** the effective queue is `spec.taskQueue ?? (isBuiltin(spec.workflow) ? ENGINE_QUEUE : projQueue(project))` — built-ins (`devCycle`/`whiteboxBugHunt`/`qaProbe`) keep defaulting to `ENGINE_QUEUE` (unchanged from `schedule-ops.ts:77`); a *project* workflow defaults to `proj-<project>`. This is the one behavioral change to queue resolution, and it is additive (absent `taskQueue` for a project workflow used to fall through to `ENGINE_QUEUE`, where no engine worker has the code — i.e. it never worked; now it resolves correctly).
- **`worker_task_queue` default:** likewise `proj-<project>`.

So for the common case nobody types a queue name anywhere; both sides compute `proj-broccoli` from the slug. Explicit `taskQueue` / `worker_task_queue` is override-only (kept for the rare multi-queue project).

**Safety surface (no silent misconfig):** ConfigSync, when it schedules a project workflow onto `proj-<project>`, checks whether a worker is registered for that project (`worker_image` set / `worker_enabled`) and **surfaces a warning** in reconcile status if not — "scheduled `rollbarMonitor` on `proj-broccoli` but no enabled broccoli worker is registered." Non-blocking (the worker may come up moments later), but it turns the most likely onboarding mistake from a silent pending workflow into a visible signal.

## 8. Project-owned external secrets (the one residual coupling)

A worker that talks to an external source (the canonical Rollbar monitor) needs its *own* secret, mounted via `externalSecretRefs`. That Secret still has to exist in the cluster, and it is genuinely the project's secret — not engine credentials. For now it is provisioned the same way every other secret is: **SOPS-encrypted in `agentops-platform`** (`secrets/…`, `.sops.yaml`), decrypted into a K8s Secret at deploy time. The chart only references it by name.

This is called out, not solved, because: (a) it is a *smaller* coupling than the workload one this design removes; (b) most Tier-2 workers (pure orchestration over `engineActivities()` + `childDevCycle()`) need no external secret at all — including broccoli's case as understood today; (c) collapsing it into the DB would mean `control` storing a second class of project secret, which reopens the encrypt-only threat surface the registry design deliberately closed. A future pass can extend the registry's existing X25519 scheme to project-owned externals if the manual SOPS step becomes painful.

## 9. Topology decision (settled, recorded here)

- **Single shared Temporal namespace per environment** — kept. Per-project namespaces would break the Tier-2 delegation model (no cross-namespace `executeChild`/activity routing; `childDevCycle()`/`engineActivities()` on `ENGINE_QUEUE` would need Temporal Nexus or a claim-checked relay), multiply operational overhead (per-namespace create + retention + search-attribute registration), and fragment cross-project visibility. The isolation it buys (hard boundary against *hostile* in-namespace code) defends a threat that trusted, PR-reviewed org projects don't carry; accidental cross-project action is already handled by the credential-delegation binding (SP2 §7.2). The trigger to revisit is an untrusted/client project — the deferred escalation path (SP2 §15).
- **Per-project routing separation via the `proj-<project>` task queue** (§7) gives clean per-project *routing* without paying for per-project *namespace* isolation.
- **K8s namespace:** project workers run in the same `dev-agents` namespace as the engine (matching reality; SP2 §7.1's aspirational `proj` namespace is not required — the security property is *what is mounted*, not namespace separation). The chart parameterizes `temporal.namespace` and the target K8s namespace, so a future split costs nothing at the deployment layer.

## 10. Onboarding runbooks

**Stage 1 (git-file):**
1. Project CI builds & pushes its worker image (unchanged).
2. Append an entry to `agentops-platform`'s `clusters/ops/project-workers/workers.yaml` (`project`, `image`; queue defaults).
3. Merge → ArgoCD syncs → worker Deployment polls `proj-<project>`.
4. Project `agents.json` references the workflow (queue defaults to `proj-<project>`); ConfigSync starts it on that queue.

**Stage 2 (DB-driven):**
1. Project CI builds & pushes its worker image.
2. `engine project update --repo owner/broccoli --worker-image <repo:tag>` (or Mission Control).
3. ApplicationSet plugin generator picks it up on the next reconcile → worker Deployment up. **No platform PR.**
4. `agents.json` as above.

## 11. Contract & vocabulary changes (summary)

| Change | Location | Why | Deliberate? |
|---|---|---|---|
| `worker_image` / `worker_task_queue` / `worker_enabled` columns | `managed_projects` (`activities`) | Registry knows which projects run a worker (§6.1) | additive DDL |
| `ProjectWorkerSchema`; `ManagedProject`/`Upsert…` gain `worker?` | `contracts` | Typed worker descriptor, secret-free (§6.2) | new (optional/nullable) |
| `GET /api/argocd/project-workers` | `control` | ApplicationSet plugin-generator source (§6.3) | new route |
| `--worker-image`/`--worker-task-queue`/`--worker-enabled` | `cli` | Set the worker fields (§6.4) | new flags |
| Project-workflow queue defaults to `proj-<project>` | reconciler (`policies`/`activities`) | Deploy↔schedule invariant (§7) | behavior (additive) |
| `charts/project-worker/` | engine repo (OCI-published) | Generic worker Deployment (§4) | new chart |
| `clusters/ops/project-workers/` ApplicationSet (+ root kustomization) | `agentops-platform` | Fan-out per worker (§5) | new (one-time) |

## 12. Decomposition into sub-projects

| # | Sub-project | Delivers |
|---|---|---|
| **SP-a** | **Chart + git-file ApplicationSet + registry worker fields** | `charts/project-worker/` (+ render golden test); the `worker_*` columns + `ProjectWorkerSchema` + CRUD round-trip + CLI flags; the `proj-<project>` reconciler default + the deploy↔schedule safety warning (§7); the ApplicationSet with the Stage-1 git-file generator + `workers.yaml`; `examples/project-worker/` gains its deploy entry; docs. **The 90% win, fully GitOps.** |
| SP-b | DB-driven plugin generator | `GET /api/argocd/project-workers` in `control`; swap the ApplicationSet to the plugin generator + the read-token Secret; Mission Control surface for the worker fields (folds into the SP4 Mission Control line of #30). **Zero platform touch per project.** |

Order SP-a → SP-b. SP-a is independently valuable and low-risk; SP-b is pure ergonomics on a proven surface.

## 13. Testing strategy

- **`contracts`:** schema tests for `ProjectWorkerSchema` and the extended `ManagedProject`/`Upsert…` (worker present/absent/null; `enabled` default).
- **`activities`:** `PostgresManagedProjectStore` round-trips the worker fields; `ensureSchema()` is idempotent with the new `ADD COLUMN IF NOT EXISTS` lines.
- **`policies`/reconciler:** queue resolution — built-in → `ENGINE_QUEUE`; project workflow, no `taskQueue` → `proj-<project>`; explicit override respected; the "no worker registered for `proj-<project>`" warning fires.
- **`control`:** the generator route returns only rows with `worker_image` set, shaped for the plugin generator, no secrets; auth gate (401 without the token).
- **`cli`:** the new flags reach the CRUD payload.
- **Chart:** `charts/project-worker/` render golden test (mirrors `charts/engine/tests/render.golden.yaml`): asserts the Deployment polls `proj-<project>` by default, mounts `externalSecretRefs`, and mounts **no** engine secrets / **no** namespace-job / **no** search-attribute registration.
- **ApplicationSet:** template render for a sample `workers.yaml` (Stage 1) producing a valid Application with the right OCI chart source + values.
- **Green bar:** `pnpm lint && pnpm typecheck && pnpm test`; `pnpm e2e` (touches activities; reconciler queue-resolution change).

## 14. Definition of done

**SP-a**
- [ ] `charts/project-worker/` renders a worker Deployment + ServiceAccount from the §4 values; render golden test proves the queue default, the mounted externals, and the *absence* of engine secrets / namespace-job / SA registration.
- [ ] Engine CI OCI-publishes `project-worker` and bumps its chart version alongside the engine chart.
- [ ] `worker_image`/`worker_task_queue`/`worker_enabled` columns; `ProjectWorkerSchema`; CRUD round-trip; CLI flags — all with tests.
- [ ] Reconciler defaults a project workflow's queue to `proj-<project>` and warns when scheduling onto a `proj-<project>` with no registered/enabled worker — with tests.
- [ ] `agentops-platform`: the `project-workers` ApplicationSet (Stage-1 git-file generator) + `workers.yaml` + root-kustomization registration; broccoli onboarded through it end-to-end (worker polls `proj-broccoli`, its scheduled workflow runs).
- [ ] `examples/project-worker/` documents the onboarding entry.
- [ ] `pnpm lint && typecheck && test` green; `pnpm e2e` green.

**SP-b**
- [ ] `GET /api/argocd/project-workers` in `control` (token-gated, secret-free) + tests.
- [ ] ApplicationSet swapped to the plugin generator + the read-token Secret; onboarding a worker via `engine project update --worker-image …` requires **no** platform PR (verified on dev-agents).
- [ ] Mission Control shows/edits the worker fields.
- [ ] Specs updated if implementation deviates.

## 15. Open questions

- **Plugin-generator token** (§5.2) — reuse `CONTROL_CRUD_TOKEN` or mint a dedicated read-only token? Lean dedicated read-only (least privilege; the generator only reads). Settle in the SP-b plan.
- **Image-tag flow at Stage 2** (§10) — does the project CI call `engine project update --worker-image` on release, or is the tag set once and updated by digest/`:latest`+rollout? Lean explicit `update` on release (auditable, matches the engine's own explicit tag-bump ethos). Pin in the SP-b plan.
- **`workers.yaml` → DB migration** — when SP-b lands, the Stage-1 `workers.yaml` entries migrate into `managed_projects.worker_image`. One `engine project update` per existing worker; no tooling. Note it in the SP-b plan.
