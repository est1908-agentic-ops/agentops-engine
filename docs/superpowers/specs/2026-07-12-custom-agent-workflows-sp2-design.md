# Custom agent workflows — SP2 (Tier-2: SDK + per-project worker + authorization) — design

Status: draft v1 · 2026-07-12 · Owner: Artem
Tracks: [#31](https://github.com/est1908-agentic-ops/agentops-engine/issues/31) (SP2 row) · Parent: [#30](https://github.com/est1908-agentic-ops/agentops-engine/issues/30)
Builds on: SP1 (`docs/superpowers/specs/2026-07-12-custom-agent-workflows-design.md` §10 row 1, shipped in #34) — `agents.json` manifest, `ConfigSync` reconciler, `createIssue` + `filed_findings`, `whiteboxBugHunt`, the `bughunt` stage, prompt provenance.
Design authority: this doc is the SP2 authority; the master design (`2026-07-12-custom-agent-workflows-design.md`) governs the overall model (Tier ladder §2, topology/authz §4.3, provenance §7). Where this doc specifies §4.3's open question (§12 of the master design), it is the resolution of record.

## 1. Why

SP1 gave projects **Tier 1**: schedule/trigger a *built-in* workflow via a git-committed `agents.json`, tuned by config, on the shared fleet. **Tier 2** is for a project that needs a workflow *shape* no built-in provides (the canonical case: a Rollbar monitor that polls an external source). The Temporal constraint — workflow code is bundled into a worker at startup; you cannot inject project code into the engine's worker without a rebuild, and doing so would break per-project isolation — is resolved by a **per-project workflow worker** that delegates all heavy, credential-holding work back to the engine.

The goal of SP2 is to make Tier 2 real **and safe**: a project authors its own TS workflow, runs it in its own worker/namespace, delegates privileged activities and `devCycle` back to the engine, and is **provably unable to act on another project's repo**. The security crux (master §4.3, open question §12) is resolved here.

## 2. Scope & phasing

SP2 is delivered as **one spec, two implementation phases**:

- **Phase A — engine-side** (all mergeable and e2e-testable in-repo, no packaging):
  1. Formalize the shared **`ENGINE_QUEUE`** constant and extract the **`EngineActivities`** contract (§3).
  2. Register the custom Temporal **search attributes** (`project`/`agentName`/`workflowType`) and fix the reconciler's identity stamping — including the live `repo: ''` gap in `schedule-ops.ts` (§7).
  3. **Identity binding + authorization** enforcement (§7).
  4. **Continuous agents** in the reconciler (§8).
  5. **Project-prompt provenance** in `runAgent` (§9).
  6. The generic **`agent` stage** + routing/timeout wiring (§10).
- **Phase B — packaging & external**:
  7. The **`@agentic-ops/engine-sdk`** package (§4), published to public npm.
  8. An in-repo **reference project worker** + cross-worker e2e + tarball-install check (§5, §13).
  9. The **"author a project workflow" skill** baked into the agent-runner (§11).

Phase A locks the two conventions master §4.3 says to lock now (project-identity binding; shared-namespace-for-trusted default) and ships value with no packaging risk. Phase B is pure packaging on top of a proven engine surface.

## 3. `ENGINE_QUEUE` + `EngineActivities` — the compatibility contract

Today the engine worker polls one hardcoded task queue, `'agentops-devcycle'` (`packages/worker/src/main.ts:429,440`), and `schedule-ops.ts` defaults Schedule actions to the same literal. Despite the name it already runs *everything* — `devCycle`, `platform`, `whiteboxBugHunt`, `configSync`, and all activities — so it is the de-facto engine queue.

### 3.1 `ENGINE_QUEUE`

- A single exported constant **`ENGINE_QUEUE = 'agentops-engine'`** in `@agentops/contracts`, imported by the worker (`main.ts`) and `schedule-ops.ts` (replacing the hardcoded strings) and re-exported through the SDK's `/workflow` entry. Once the SDK is published, the **value** is part of the frozen semver contract — so the rename to `agentops-engine` happens **now**, before the freeze, rather than baking the misleading `devcycle` name into a public package forever.
- **One-time cutover** (dev-only, few live Schedules): during the transition the engine worker registers **two workers** — one on `agentops-engine` (primary) and one on the legacy `agentops-devcycle` — so any already-created Schedule that fires mid-cutover is still served. `ExistingSchedule` gains a `taskQueue` field and `reconcileAgents` compares it, so a Schedule still pointing at the legacy queue is detected as **changed** and re-pointed to `agentops-engine` on the next reconcile (self-healing — the current diff only checks cron/workflow, so this is a required addition). A follow-up removes the legacy worker once all Schedules are reconciled.

### 3.2 `EngineActivities`

- A **types-only** `EngineActivities` interface in `@agentops/contracts` enumerates the delegatable activity surface: `runAgent`, `getIssue`, `commentOnIssue`, `labelIssue`, `createIssue`, `openPr`, `getPrFeedback`, `pushBranch`, the workspace lifecycle activities, `recordStageResult`, `recordRunStats`. (Exact set pinned in the plan by reading `create-activities.ts`.)
- The engine's `createActivities(...)` return type is asserted assignable to `EngineActivities` at compile time (`satisfies EngineActivities`), so the two can't drift.
- **The semver compatibility contract is:** `EngineActivities` signatures + the child-workflow names/shapes (`devCycle` → `DevCycleState`) + `ENGINE_QUEUE`. Projects pin an SDK version and upgrade at their own pace.

## 4. The SDK — `@agentic-ops/engine-sdk`

A thin, secret-free facade published **public on npm** as `@agentic-ops/engine-sdk` (types + workflow-safe helpers only; nothing proprietary; `files: ["dist"]`).

- **Build:** tsup → ESM + CJS + `.d.ts`. Bundles the used bits of `contracts`/`policies` so it is self-contained (no `@agentops/*` runtime deps). `@temporalio/*` are **peer dependencies** — the consumer provides them, so there's exactly one SDK copy in the worker sandbox.
- **`@agentic-ops/engine-sdk/workflow`** (safe inside the Temporal workflow sandbox):
  - the `EngineActivities` types;
  - `engineActivities()` / `engineAgent()` — `proxyActivities` factories bound to `ENGINE_QUEUE` (so the call runs on the engine's activity workers, which hold the credentials);
  - `childDevCycle(input): Promise<DevCycleState>` — wraps `executeChild('devCycle', { taskQueue: ENGINE_QUEUE, ... })`; starts the built-in **by name**, so no engine workflow code is bundled into the project worker;
  - pure parsers (`parseFindings`, `parseVerdict`) re-exported from `policies`.
- **`@agentic-ops/engine-sdk/worker`** (Node side):
  - `createEngineWorker({ taskQueue, namespace, workflowsPath, activities })` — creates a Temporal Worker for the project's own workflows/activities and **installs the identity interceptor** (§7).

The two entry points enforce the sandbox split (workflow-safe vs. Node-only) at the import boundary.

## 5. Per-project worker convention

A Tier-2 project repo holds:

```
agentops/
  workflows/*.ts     # the project's own Temporal workflows (import @agentic-ops/engine-sdk/workflow)
  activities/*.ts    # optional: project-owned activities holding the project's OWN secrets (e.g. rollbarFetch)
  worker.ts          # createEngineWorker({ taskQueue, namespace, workflowsPath, activities })
  agents.json        # manifest entries (schedule/continuous) referencing the project's workflows
```

Project CI builds a worker image; ArgoCD runs it as a normal Deployment (in a shared `proj` namespace) on the project's own task queue. **Adding/changing a project workflow = the project rebuilds its own worker; the engine image is untouched.** Config-only (Tier 1) projects still need no worker of their own.

The **reference implementation** — the §8-of-master Rollbar monitor — lives in-repo at `docs/project-worker/` and doubles as the cross-worker e2e fixture (§13). It exercises: an own `rollbarFetch` activity (its own secret) + a durable cursor + `continueAsNew` (a `"continuous"` agent); per finding, `engineActivities().createIssue({ labels:['bug'], dedupeFingerprint })`; and optional `childDevCycle()`.

## 6. Activity routing & child workflows

- Project workflows call `engineActivities()` / `engineAgent()` → `ENGINE_QUEUE`, so every privileged, credential-holding activity (`runAgent` = K8s Jobs, SCM writes with the per-project token, workspace ops) runs on the engine fleet.
- `childDevCycle()` runs the built-in pipeline on `ENGINE_QUEUE` too.
- The project worker runs only its own orchestration + its own non-engine activities (e.g. `rollbarFetch`) on its own queue.

## 7. Topology & authorization — the crux

In OSS Temporal the **namespace is the only hard trust boundary**: any worker in a namespace can poll any task queue and start/terminate any workflow in it. For SP2's trusted-projects model the real authorization boundary is **not** K8s topology but the **credential-delegation binding** (§7.2) — that guarantee is pure engine-side logic and holds regardless of how the project workers are laid out in the cluster.

### 7.1 Topology (deliberately minimal for SP2)

- **Kubernetes:** the engine fleet runs in its `ops` namespace; project workers run as **normal Deployments in a shared `proj` namespace** on their own task queues. No dedicated per-project namespace and no per-project `NetworkPolicy` are required. The load-bearing constraint is enforced by **what is mounted, not by network policy**: a project worker's Deployment gets *no engine secrets* — only Temporal connection config + the project's own externals. An optional namespace-level `ResourceQuota` / `LimitRange` keeps a runaway worker from starving the cluster. Per-project network micro-segmentation is redundant with §7.2 in the trusted case and premature relative to the threat it addresses, so it moves to the deferred escalation path (§15) alongside vcluster.
- **Temporal:** one namespace per environment (`dev-agents` / `prod-agents`), **shared** by the engine and the org's own (trusted, PR-reviewed) projects. Task-queue routing and cross-worker `executeChild` only work intra-namespace, so a shared namespace is what makes Tier 2 simple. (This shared *Temporal* namespace is load-bearing and stays; the K8s simplification above does not touch it.)

### 7.2 Authorization = capability delegation bound to project identity

Project workers hold **no engine credentials** (agent OAuth and per-project SCM tokens live only on the engine's activity workers). A project worker cannot touch a forge or spawn an agent directly — it can only *request* it via an activity the engine executes. The binding that makes this safe has three parts:

- **Origin (trusted stamp).** The reconciler / Schedule action / trigger — all engine-controlled — stamp the caller's `project` into the workflow **memo**, a `project` **search attribute**, and a deterministic workflow ID at start. The project worker only *runs* the code; it does not choose its own identity. (This also fixes the current `schedule-ops.ts` `args: [{ repo: '' }]` gap: the Schedule action must carry the resolved `repo` and stamp `project`/`agentName`/`workflowType`.)
- **Propagation.** `createEngineWorker` installs a **workflow outbound interceptor** that reads `project` from `workflowInfo().memo` and:
  - attaches it as a **Temporal header** on every activity call (`scheduleActivity`), and
  - sets memo + search-attribute + header on every child (`startChildWorkflowExecution`), so `devCycle` children inherit the identity.

  A header is used because Temporal's **`ActivityInfo` does not carry the calling workflow's memo or search attributes** — the header is the only channel that delivers ambient caller identity into the activity without polluting every activity signature.
- **Enforcement.** The engine's activity worker installs an **inbound interceptor** that exposes the header to a shared guard. Every **repo-touching** activity (`runAgent`, `createIssue`, `openPr`, `pushBranch`, SCM reads, workspace ops) resolves the target repo's `managed_projects` row and asserts the stamped **`project` owns that `repo`** (the registry is 1:1 on `project`/`repo`). On mismatch it throws a non-retryable **`ProjectAuthorizationError`**. The scoped SCM token is fetched **only after** the check passes.

### 7.3 Threat model (stated honestly)

This binding **defends against accidental cross-project action** (a bug in project A's workflow referencing project B's repo is rejected) and gives every privileged op an **auditable project identity** within the *trusted* shared namespace. It does **not** sandbox hostile in-namespace code: a rogue worker in the shared namespace could start a workflow with a forged memo. That is out of scope by design — untrusted / client code gets the **escalation** path (its own Temporal namespace + a vcluster + per-project network isolation, engine reachable only via a narrow claim-checked cross-namespace entrypoint), which master §4.3 **defers** until an untrusted project actually appears. SP2 locks the binding convention and the shared-namespace-for-trusted default; it does not build the escalation or any per-project network isolation.

## 8. Continuous agents in the reconciler

`reconcileAgents` currently **excludes** `continuous` agents (they are filtered out before the Schedule diff). SP2 adds them:

- A second reconcile output — `toStartContinuous` / `toTerminateContinuous` — computed by diffing declared `continuous` agents against the running singletons. **Correction (found 2026-07-13):** listing by workflow-ID prefix `agent:<project>:` alone is unsafe — a Temporal Schedule fires a workflow as `<scheduleId>-workflow-<timestamp>`, which shares that same prefix with a genuine continuous singleton, so an in-flight *scheduled* agent run gets misidentified as an orphaned continuous agent and terminated. `listContinuousAgents` now requires an exact match against the deterministic singleton id (`agent:<project>:<name>`, via the `agentName` search attribute already stamped on every run), not just the prefix.
- **Singleton semantics:** start with the deterministic workflow ID `agent:<project>:<name>`; `WorkflowExecutionAlreadyStarted` ⇒ already running (fine). Removal from the manifest → `terminate`. Identity (memo + search attributes) is stamped exactly as the Schedule action does.
- **Task-queue binding:** a `continuous` Tier-2 workflow runs on the *project's* queue (its code lives only in the project worker), so `AgentSpec` gains an **optional `taskQueue`** field (a deliberate `z.strict()` contract change; defaults to `ENGINE_QUEUE` for built-in workflows, the project's conventional queue otherwise). The reconciler starts the workflow **by name** on that queue — the engine never needs the project's code, exactly like `executeChild`-by-name.
- **Open decision carried from SP1:** reconciler as a durable `ConfigSync` workflow vs. a control-side loop — continuous-agent start/terminate does not change the recommendation (lean workflow); settle in the plan.

## 9. Project-prompt provenance

`runAgent` today emits only `promptSource = builtin:<ref>` (`create-activities.ts:78`). SP2 adds the project-prompt path (master §7): `AgentRunRequest` carries an optional **prompt-source descriptor** (repo + commit SHA — already known at workspace-prepare — + path), and `runAgent` emits

```
promptSource = <repo>@<commitSHA>:agentops/prompts/x.md
```

on `agent_run_stats` and the OTel span. `promptHash` stays `sha256` of the *rendered* prompt. Built-in prompts are unchanged (`builtin:<ref>` / `packages/prompts@<engine-version>`). Every run is then traceable to the exact prompt version that produced it, uniformly across Tier 1 and Tier 2.

## 10. The generic `agent` stage

A stage is the engine's **routing + attribution key**: the workflow selects a step's model with `config.routing[stage]` (`dev-cycle.ts:169`), its timeout with `config.timeouts[stage]`, and every run's cost is attributed by `agent_run_stats.stage` / the `agentops.stage` span attribute. When a Tier-2 project workflow calls `engineAgent().runAgent(...)` for a step that is none of the pipeline/finder stages, it needs a stage or it can't be routed, timed, or attributed cleanly.

SP2 adds the generic **`agent`** stage (master §7's third sanctioned stage addition, after `bughunt` in SP1 and `qa` in SP3):

- `StageSchema += 'agent'`;
- `RoutingSchema += agent?: ModelRef` and `TimeoutsSchema += agent?: StageTimeout` — mirroring exactly how `bughunt` was added to both, so a project can tune the model/effort/timeout of its Tier-2 steps per repo. (Without the routing/timeout entries, `StageSchema` alone would leave every Tier-2 step silently on the fallback model with no per-project control.)

This is the sanctioned "a new stage is a deliberate contract change" (AGENTS.md).

## 11. The "author a project workflow" skill

A baked-in agent-runner skill (the re-homed DSL-authoring request, now aimed at the code-first model) teaching the SDK + per-project-worker pattern end-to-end:

- install `@agentic-ops/engine-sdk`;
- write `agentops/workflows/*.ts` with `engineActivities()` / `engineAgent()` / `childDevCycle()`;
- write `worker.ts` with `createEngineWorker`;
- add the `agents.json` entry (`continuous` or scheduled, with `taskQueue`);
- add the deploy manifest (a normal Deployment in the shared `proj` namespace, mounting only Temporal connection config + the project's own externals — **no engine secrets**).

It points at the in-repo `docs/project-worker/` reference.

## 12. Contract & vocabulary changes (summary)

| Change | Location | Why | Deliberate? |
|---|---|---|---|
| `ENGINE_QUEUE = 'agentops-engine'` | `contracts` | Shared queue constant + wire contract; rename before public freeze (§3.1) | rename + cutover |
| `EngineActivities` interface (types only) | `contracts` | The delegatable surface + semver contract (§3.2) | new |
| `ExistingSchedule.taskQueue` + diff on it | `policies` | Self-healing cutover of legacy-queue Schedules (§3.1) | new field |
| `AgentSpec.taskQueue?` | `contracts` (strict) | Continuous Tier-2 runs on the project queue (§8) | strict-schema change |
| `StageSchema += 'agent'` | `contracts` | Routing/timeout/attribution key for Tier-2 steps (§10) | deliberate stage add |
| `RoutingSchema += agent?`, `TimeoutsSchema += agent?` | `contracts` | Make the `agent` stage routable/tunable (§10) | new |
| `AgentRunRequest +=` prompt-source descriptor | `contracts` | Project-prompt provenance (§9) | new (optional) |
| `ProjectAuthorizationError` | `contracts`/`activities` | Non-retryable authz failure (§7.2) | new |
| Register `project`/`agentName`/`workflowType` search attributes | Worker auto-registers at startup via the operator API (`ensure-search-attributes.ts`); `scripts/register-search-attributes.sh` is a manual fallback | Identity binding + per-agent-instance telemetry (§7, master §7) | code |

## 13. Testing strategy

- **Unit.** `satisfies EngineActivities` compile assertion; interceptor propagation (header set from `workflowInfo().memo`; child inherits memo/search-attr/header); authz guard (repo∈project pass / mismatch → `ProjectAuthorizationError`); `reconcileAgents` continuous diff (start missing / terminate orphaned) and the new `taskQueue` re-point; project-prompt `promptSource` string.
- **e2e (stub backend, `@temporalio/testing`).** The `docs/project-worker` reference worker on its own queue + the engine worker on `ENGINE_QUEUE` in a shared test namespace. Assert: (a) a Tier-2 workflow's `engineActivities().createIssue` and `childDevCycle()` cross worker boundaries correctly; (b) a workflow stamped with a mismatched `project` is rejected with `ProjectAuthorizationError` before any SCM token is used; (c) starting a `continuous` singleton twice is idempotent (`WorkflowExecutionAlreadyStarted`).
- **Package.** `pnpm pack` the SDK → install the tarball into a throwaway consumer → typecheck against **both** entry points (proves bundling, peer-dep resolution, and `.d.ts` correctness — not just the in-workspace path).
- **Publish.** `npm publish --access public` for `@agentic-ops/engine-sdk` (the one outward, irreversible action; performed once the tarball check is green).
- **Green bar.** `pnpm lint && pnpm typecheck && pnpm test`; `pnpm e2e` (touches workflows/policies/activities/backends).

## 14. Definition of done (SP2)

**Phase A**
- [ ] `ENGINE_QUEUE = 'agentops-engine'` in `contracts`; worker + `schedule-ops` use it; dual-queue cutover in place; `ExistingSchedule.taskQueue` diffed so legacy Schedules re-point on reconcile.
- [ ] `EngineActivities` interface in `contracts`; engine `createActivities` asserted `satisfies EngineActivities`.
- [ ] `project`/`agentName`/`workflowType` search attributes registered + stamped by the reconciler/Schedule/trigger; `schedule-ops` `repo: ''` gap fixed.
- [ ] Identity interceptor pair (workflow-outbound header propagation + child memo/SA; engine activity-inbound read) + authz guard on every repo-touching activity → `ProjectAuthorizationError`; scoped token fetched only after the check.
- [ ] `continuous` agents reconciled: singleton start (deterministic ID) / terminate on removal; `AgentSpec.taskQueue?` added (strict).
- [ ] Project-prompt provenance in `runAgent` (`<repo>@<sha>:agentops/prompts/x.md`).
- [ ] `agent` stage added to `StageSchema` + `RoutingSchema` + `TimeoutsSchema`.

**Phase B**
- [ ] `@agentic-ops/engine-sdk` builds with tsup (ESM+CJS+`.d.ts`), dual entry, peer-dep `@temporalio/*`, self-contained; tarball-install typecheck green.
- [ ] `docs/project-worker` reference worker (Rollbar monitor) + cross-worker e2e (delegation, authz-reject, continuous-idempotency) green.
- [ ] `@agentic-ops/engine-sdk` published to public npm.
- [ ] "Author a project workflow" agent-runner skill.
- [ ] `pnpm lint && typecheck && test` green; `pnpm e2e` green; specs updated if implementation deviates.

## 15. Deferred / out of scope

- **vcluster + own-namespace escalation** for untrusted / client code (master §4.3) — built when an untrusted project appears. **This is where per-project K8s network isolation lives** (dedicated `proj-<name>` namespace + `NetworkPolicy` restricting egress to Temporal + declared externals): it defends against hostile/compromised in-cluster code, a threat SP2's trusted model does not carry, and it is redundant with §7.2 for trusted projects.
- **Cross-repo `executeChild`** (`targetRepo`, a PR landing in a different repo than the trigger) → SP3.
- **`qaProbe` + triggers** (Gateway `opened`-with-label fix, `agent:fix`, fix-dedup, `workflowClosed`) → SP3.
- **Mission Control** → SP4.
- **Multi-namespace / per-project Temporal namespaces** — only with the escalation path; the trusted default is one shared namespace per env.
