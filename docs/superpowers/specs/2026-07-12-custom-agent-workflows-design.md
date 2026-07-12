# Custom agent workflows — code-first, manifest-scheduled, per-project SDK — design

Status: draft v2 · 2026-07-12 · Owner: Artem
Tracks: [#30](https://github.com/est1908-agentic-ops/agentops-engine/issues/30) ("Custom agent config in the JSON and database") · follow-ons in [#31](https://github.com/est1908-agentic-ops/agentops-engine/issues/31)
Amends: the worker-fleet model (§9). Supersedes: the planned git-based role manifest ("roles as config", M8). The monolithic architecture doc was removed, so this spec is the standalone authority for the model it describes.

## 1. Why

Issue #30 asks for custom agents — "nightly bughunt → PR", "hourly PR review → merge", "QA → issue", "sweep issues → fix", "agents invoke agents" — that can be added and tuned **without an engine code change or redeploy**.

The five use-cases are a small set of generic pipeline *shapes*; the per-project variation is pure config (prompt, schedule, budget, model routing, verify commands), not novel structure. So custom agents are **code-first, git-sourced**:

- **Tier 1** — a project schedules a **built-in workflow** through a git-committed `agents.json` manifest, tuned via `ProjectConfig`. No project code; runs on the shared fleet.
- **Tier 2** — a project that needs a workflow *shape* no built-in provides authors its own TypeScript workflow using `@agentops/engine-sdk` and runs it in **its own worker**, delegating heavy activities back to the engine.

Both are git-sourced, PR-reviewed, agent-improvable, and require **no engine rebuild**.

## 2. The capability ladder

| Tier | A project gets | Cost to the project | Engine rebuild? |
|---|---|---|---|
| **1. Config manifest** | schedule/trigger a **built-in** workflow (`whiteboxBugHunt`, `qaProbe`) or `devCycle`, tuned via `ProjectConfig` + `agents.json` | none — runs on the shared fleet | never |
| **2. Per-project worker** | **custom workflow structure in TS**, using `@agentops/engine-sdk`; heavy activities delegated to the engine | its own worker image + deploy in its namespace | never (project deploys its own worker) |

All five #30 use-cases are covered by **Tier 1** except a project-specific external source (e.g. Rollbar), which is **Tier 2**. Build Tier 1 first.

## 3. Tier 1 — built-in workflows + `agents.json` manifest + reconciler

### 3.1 The built-in catalog (exactly three workflows)

Each is a normal Temporal TS workflow (`packages/workflows`), parameterized by project + `ProjectConfig` (resolved via the existing `resolveRepoConfig`):
- `devCycle` — **already exists**: Issue→PR (design→plan→implement→verify→review→PR→babysit-to-merge). Its `pr_babysit` loop already covers "review a PR to merge-ready" and it already "fixes an issue" — so no separate PR-sweep or issue-sweep workflow is needed.
- `whiteboxBugHunt({ repo, focus? })` — **new**: read-only agent over the source → structured findings → `createIssue(labels:['bug'])`.
- `qaProbe({ repo, previewUrl })` — **new**: probe agent (Playwright/MailPit against a preview) → `createIssue` per finding.

**The loop, without extra sweep workflows:** the finders file labeled issues; the issue→fix trigger (§6) drives each to a merged `devCycle` PR. The new workflows reuse `devCycle`/`platform` patterns (proxies, policies) — no new orchestration primitives.

### 3.2 The manifest contract — strict

`agents.json` lives in the project repo (git-sourced, PR-reviewed). `AgentsManifestSchema` in `contracts` is `z.strict()` (unknown keys are a hard error, so typos fail fast at reconcile, not silently):

```jsonc
{
  "agents": [
    {
      "name": "nightly-bughunt",        // kebab, DNS-safe: it keys the Schedule ID
      "workflow": "whiteboxBugHunt",     // must resolve to a registered workflow
      "schedule": "0 2 * * *",           // validated cron, OR "continuous"
      "input": { "focus": "auth & billing" },
      "enabled": true,                   // default true; false => Schedule paused, not deleted
      "timezone": "UTC",                 // default UTC
      "overlap": "skip"                  // skip | bufferOne | allow (default skip)
    }
  ]
}
```

Rules the validator enforces:
- `name` matches `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$` and is unique within the project.
- `schedule` is a valid 5-field cron **or** the literal `"continuous"`.
- **Per-workflow `input` validation:** each built-in exports an input zod schema (`whiteboxBugHunt → { focus?: string }`, `qaProbe → { previewUrl: string }`); the validator resolves the named workflow's schema and validates `input` against it. Tier-2 project workflows (whose schema the engine can't know) get pass-through — the project workflow validates its own input.
- A **malformed manifest rejects the entire reconcile for that project** (never partial-apply); the last-good Schedules stay and the error is surfaced (a status/commit-comment on the triggering push). Fail-safe: a project is never left half-reconciled.

### 3.3 The reconciler & Schedule lifecycle (`ConfigSync`)

A `ConfigSync` reconciler reads each managed project's `agents.json` (via `ScmPort.readFile`, reusing `load-project-config.ts`) and reconciles the declared agents into live automation. **Config *is* the state.**

- **Schedule ID = `agent:<project>:<name>`** → reconcile is idempotent (create-or-update by ID).
- **Diff declared vs. actual:** list the project's Schedules by ID prefix; **create** missing, **update** changed (cron/input/workflow/tz/overlap), **delete orphans** (present in Temporal, absent from the manifest). A manual Temporal-UI edit is overwritten on the next reconcile (documented — config is the source of truth).
- **`enabled: false` → `schedule.pause()`** (reversible, keeps history); **removed from manifest → `delete()`**.
- **`overlap` default `skip`** (a long nightly bughunt won't stack); **`catchupWindow` ~1h** (after downtime, don't backfill dozens of missed fires).
- **Each Schedule's action** starts its workflow on the shared fleet queue with args `{ repo, project, config, ...input }` and stamps `project` + `agentName` + `workflowType` (§7).
- **`"continuous"` is not a Schedule** (e.g. a Tier-2 poll workflow like `rollbarMonitor`): the reconciler ensures a single running instance via a deterministic workflow ID `agent:<project>:<name>` (`WorkflowExecutionAlreadyStarted` ⇒ already running, fine); removal from the manifest → terminate. Pairs with Tier 2 → SP2.
- **Reconcile triggers:** project-repo push (Gateway webhook) + a periodic safety reconcile (~15 min) to catch missed webhooks and drift.
- **Open decision:** reconciler as a Temporal `ConfigSync` workflow (durable, replayable) vs. a control-side loop — lean workflow; settle in the plan.

## 4. Tier 2 — `@agentops/engine-sdk` + per-project worker

For workflows whose *structure* isn't a built-in (e.g. a Rollbar monitor), a project authors TS workflows and runs its own worker. The Temporal constraint (workflow code is bundled into a worker at startup; you cannot inject project code into the engine's worker without a rebuild, and it would break per-project isolation) is resolved by a **per-project workflow worker** that delegates heavy activities back to the engine.

### 4.1 The SDK

`@agentops/engine-sdk` (fallback name `@est1908/agentops-engine-sdk` if the `@agentops` npm org is unavailable), a **thin facade** published **public on npmjs** (secret-free: types + workflow-safe helpers only; nothing proprietary; `files: ["dist"]`). Built with tsup (ESM+CJS+`.d.ts`), bundling the used bits of `contracts`/`policies` so it's self-contained; `@temporalio/*` are peer deps. Two entry points enforce the sandbox split:
- `@agentops/engine-sdk/workflow` — safe inside a workflow: the `EngineActivities` types, `engineActivities()`/`engineAgent()` proxy factories (targeting `ENGINE_QUEUE`), typed child wrappers (`childDevCycle(input): Promise<DevCycleState>` via `executeChild('devCycle', …)` — starts by name, no engine code bundled), and pure parsers (`parseFindings`, `parseVerdict`).
- `@agentops/engine-sdk/worker` — Node-side: `createEngineWorker({ taskQueue, namespace, workflowsPath, activities })`.

The **compatibility contract** (semver'd): `EngineActivities` signatures, child-workflow names/shapes, and `ENGINE_QUEUE`. Projects pin a version and upgrade at their own pace. Public-on-npm means no auth/cross-org friction (GitHub Packages npm requires a token even for public packages and its CI `GITHUB_TOKEN` can't read another org's packages — rejected for that reason); the facade is secret-free, so public visibility costs nothing.

### 4.2 The per-project worker

The project repo holds `agentops/workflows/*.ts`, a `worker.ts` entrypoint (`createEngineWorker` on the project's own queue in the project's namespace), optional project-owned activities (e.g. `rollbarFetch`, holding the project's *own* external secret), and `agents.json`. Project CI builds a worker image; ArgoCD runs it in the project namespace. **Adding/changing a project workflow = the project rebuilds its own worker; the engine image is untouched.**

Project workflows call `engineActivities()` (proxies to `ENGINE_QUEUE`), so all privileged, credential-holding activities (`runAgent` = K8s Jobs, SCM writes with the per-project token, workspace ops) run on the engine's fleet; `executeChild('devCycle', { taskQueue: ENGINE_QUEUE })` runs the built-in pipeline there too. The project worker stays pure orchestration + its own non-engine integrations.

### 4.3 Topology & authorization

In OSS Temporal the **namespace is the only trust boundary** — any worker in a namespace can poll any task queue and start/terminate any workflow in it. So topology *is* the authorization model.

- **Kubernetes:** the engine fleet (activity workers + built-in workflow workers) runs in an `ops` namespace; each project worker runs in its own `proj-<name>` namespace with a locked-down NetworkPolicy (egress = the Temporal frontend + the project's *own* declared externals only; no cluster API, no other projects) and a ResourceQuota.
- **Temporal:** one namespace per environment (`dev-agents`/`prod-agents`), **shared** by the engine and the org's own (trusted, PR-reviewed) projects to start — task-queue routing and cross-worker `executeChild` only work intra-namespace, so shared is what makes Tier 2 simple.
- **Authorization = capability delegation bound to project identity** (this is the security crux, not Temporal ACLs):
  - Project workers hold **no engine credentials** (agent OAuth, per-project SCM tokens live only on engine activity workers). A project worker cannot touch a forge or spawn an agent directly — only *request* it via an activity the engine executes.
  - Every privileged engine op is **bound to a project identity stamped at start time** (the `project` search-attribute/memo the reconciler/Schedule sets, propagated to children) and **validated against `managed_projects`** (the target repo must belong to the caller's project) before the engine uses the scoped token — so a project workflow can't act on another project's repo even in a shared namespace.
- **Escalation for untrusted / client code:** its own Temporal namespace + a vcluster, with the engine reachable only through a narrow, claim-checked cross-namespace entrypoint. **Deferred** — built when an untrusted project actually appears.

Almost all of §4.3 is **SP2**; the two conventions to lock now are the **`project`-identity binding (memo/search-attribute + registry validation)** and the **shared-namespace-for-trusted-projects** default.

## 5. Shared activities & prompts (engine-side, added once)

One new engine activity is needed by the finders, added once and reusable by every project (via `TrackerPort` + `create-activities.ts`):
- `createIssue({ repo, title, body, labels, dedupeFingerprint? })` — **new**; today's ports have `getIssue`/`commentOnIssue`/`labelIssue`/`openPr` but no create. `dedupeFingerprint` drives the finding-dedup in §6.

Prompts (`whitebox-bughunt.md`, `investigate-rollbar.md`, …) live in the project repo (`agentops/prompts/`), resolved by the agent-runner — no code change to add a prompt. Their provenance is recorded per run (§7).

## 6. The issue→fix loop & idempotent deduplication

The finders file labeled issues; each becomes a merged `devCycle` PR. Two independent dedup layers make the loop safe under webhook retries, double schedules, and reconcile re-runs.

**The trigger path (and a bug to fix):** GitHub fires `issues.opened` (labels included) when an issue is created *with* a label — it does **not** fire `issues.labeled` for those initial labels. The current Gateway listens only for `labeled`, so **agent-filed issues would be missed.** The Gateway must also handle `issues.opened` carrying the configured trigger label. Use a distinct **opt-in trigger label** (e.g. `agent:fix`) the project configures — not every human `bug` issue should auto-fix.

**Finding dedup (don't re-file the same bug nightly):** a Postgres projection `filed_findings(project, fingerprint, issue_ref, status, first_seen, last_seen)`. `createIssue` checks it before creating; a repeat fingerprint updates `last_seen` and (optionally) comments "still present" instead of filing a duplicate. Fingerprint is per-finder — a normalized stack signature (Rollbar), or file+rule+symbol (whitebox). A projection beats GitHub-search for reliability, and Postgres projections already exist.

**Fix dedup (one `devCycle` per issue):** start `devCycle` with a **deterministic workflow ID `devcycle:<project>:<issueNumber>`** and `WorkflowIdReusePolicy: AllowDuplicateFailedOnly` — Temporal guarantees at-most-one live fix per issue; a *failed* run can retry, a running/succeeded one can't be duplicated.

**Label lifecycle:** `devCycle` stamps `agent:working` on start and drops it on PR/done — visible state on the issue, and it prevents re-triggering.

**SP1:** `createIssue` + the `filed_findings` projection + the fingerprint scheme (needed by `whiteboxBugHunt`). The Gateway `opened`-vs-`labeled` fix and the fix-dedup wiring are the **trigger** side → SP3, but the `devcycle:<project>:<issueNumber>` ID convention is locked now.

## 7. Observability & prompt provenance

The engine `runAgent` activity is the single choke point that stamps telemetry — so the model stays uniform across Tier 1 and Tier 2 (a Tier-2 project workflow still calls the engine's `runAgent`, so its runs are stamped consistently and trustworthily).

- **Search attributes:** add **`agentName`** (the manifest entry, e.g. `nightly-bughunt`) and **`workflowType`** alongside the existing `project`/`stage`/`status`/`backend`, stamped by the reconciler/Schedule. Lets you slice "all runs / total cost of the nightly-bughunt agent."
- **Stages, deliberately extended:** `whiteboxBugHunt`/`qaProbe` don't fit `devCycle`'s stages, and `platform` is already precedent for a workflow-specific stage. So extend `StageSchema` (`packages/contracts`) with **`bughunt`** and **`qa`**, plus a generic **`agent`** step for Tier-2 project steps — so model routing (per-stage) and telemetry line up. This is the sanctioned "a new stage is a deliberate contract change" (AGENTS.md).
- **`agent_run_stats`:** add `project` + `workflowType` (+ `agentName` via memo) so cost dashboards slice per agent *instance*, not just per task.
- **Prompt provenance (reproducibility):** `runAgent` records, per run — `promptRef`, **`promptHash`** (sha256 of the *rendered* prompt), and **`promptSource`**: `packages/prompts@<engine-version>` for built-in prompts, or `<repo>@<commitSHA>:agentops/prompts/x.md` for project prompts (the worktree commit SHA is already known at workspace-prepare). The same attributes go on the agent's OTel span (Tempo). Every run is then traceable to the exact prompt version that produced it, and a quality regression can be pinned to a prompt change.

**SP1:** the `bughunt` stage + `project`/`workflowType`/`promptHash`/`promptSource` on stats & spans (needed by `whiteboxBugHunt`); the `agentName` search attribute (pairs with the reconciler). `qa` stage → SP3 with `qaProbe`.

## 8. Worked examples

Condensed; full versions were validated during design.
- **Tier 1 — nightly whitebox bughunt:** `agents.json` entry `{ workflow: "whiteboxBugHunt", schedule: "0 2 * * *" }` files `bug`-labeled issues (deduped by fingerprint); the trigger turns each into a `devCycle` PR. No project code.
- **Tier 1 — nightly QA:** `{ workflow: "qaProbe", schedule: "0 3 * * *", input: { previewUrl } }` files issues per finding; same fix loop. No project code.
- **Tier 2 — Rollbar monitor:** project `rollbarMonitor` workflow: its own `rollbarFetch` activity (its token) + durable cursor + `continueAsNew` (a `"continuous"` agent); per finding, `engineAgent().runAgent(investigate)` in a workspace, then `engine.createIssue(labels:['bug'], dedupeFingerprint)`. Deployed by the project; engine untouched.

## 9. Architecture impact

- **Worker fleet model (changed by this spec):** "one worker fleet serves all repos" becomes "**one shared fleet runs the engine activities + built-in workflows; projects may additionally run their own workflow workers**." Config-only (Tier 1) projects need no worker of their own.
- **Supersedes the planned git `RoleManifest`:** a "role/custom agent" is an `agents.json` entry (Tier 1) or a project workflow (Tier 2), not an engine-repo manifest.
- This spec is the authority for that model; there is no separate architecture doc to keep in sync (it was removed).

## 10. Decomposition into sub-projects

| # | Sub-project | Delivers |
|---|---|---|
| **1** | **Tier 1: manifest + reconciler + `whiteboxBugHunt`** | `AgentsManifestSchema` (§3.2, strict, per-workflow input validation); the `ConfigSync` reconciler (§3.3, create/update/delete/pause Temporal Schedules); the `createIssue` activity + `filed_findings` dedup projection (§6); the `bughunt` stage + provenance/search-attr telemetry (§7); the `whiteboxBugHunt` built-in. Gate in §11. |
| 2 | Tier 2: SDK + per-project worker + authz | Publish `@agentops/engine-sdk` (§4.1); reference per-project worker + task-queue routing + `createEngineWorker` (§4.2); the topology + project-identity-binding authz (§4.3); `"continuous"` agents in the reconciler. |
| 3 | `qaProbe` + triggers | `qaProbe` (+ `qa` stage; needs preview deploys + Playwright/MailPit); the Gateway `opened`-with-label fix + `agent:fix` trigger + fix-dedup wiring (§6); a `workflowClosed` trigger kind (self-heal auto-start on a `devCycle` ending `blocked`/`failed`). |
| 4 | Mission Control | View/manage the `agents.json`-derived agents, their Schedules, and their runs. |

Recommended order **1 → 2 → 3 → 4**; SP1 delivers most of #30 with least risk and no packaging work.

## 11. Definition of done (SP1, the first plan)

- `AgentsManifestSchema` in `contracts` (+ tests: strictness, cron/`"continuous"`, per-workflow input validation, name pattern/uniqueness).
- `createIssue` in `TrackerPort` + `create-activities` with fingerprint dedup against the `filed_findings` projection (+ tests).
- `StageSchema` extended with `bughunt`; `runAgent` stamps `promptHash`/`promptSource`/`project`/`workflowType` on `agent_run_stats` and the OTel span (+ tests).
- `whiteboxBugHunt` workflow exported from `packages/workflows` (auto-registered via `workflowsPath`), routed by config, filing deduped `bug`-labeled issues.
- `ConfigSync` reconciler: reads `agents.json` via `ScmPort`, validates it, diffs against existing Temporal Schedules, applies create/update/delete/pause; malformed manifest rejects the whole reconcile.
- e2e (stub backend): a manifest with a scheduled `whiteboxBugHunt` reconciles to a Temporal Schedule; triggering that Schedule runs the workflow, which files a `bug`-labeled issue via `createIssue`; a second run with the same fingerprint does **not** file a duplicate. (The issue → `devCycle` fix loop is the Gateway trigger side, exercised in SP3.)
- `pnpm lint && pnpm typecheck && pnpm test` green; `pnpm e2e` green.
- CLAUDE.md/AGENTS.md already name `docs/superpowers/specs/` as the design authority — no separate architecture doc to update.

## 12. Open questions

- **Reconciler as workflow vs. service** (§3.3) — lean Temporal `ConfigSync` workflow; settle in the plan.
- **Fingerprint scheme per finder** (§6) — the exact normalization for `whiteboxBugHunt` findings; pin in the plan.
- **`project`-identity propagation** (§4.3) — how the `project` memo/search-attribute is carried into `executeChild` children and validated in the engine activity; specify in SP2.
- **Cross-repo `executeChild`** (a workflow whose PR lands in a different repo than the trigger, via a `targetRepo`) — SP3.
