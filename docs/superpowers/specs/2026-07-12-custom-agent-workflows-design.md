# Custom agent workflows — code-first, manifest-scheduled, per-project SDK — design

Status: draft v1 · 2026-07-12 · Owner: Artem
Tracks: [#30](https://github.com/est1908-agentic-ops/agentops-engine/issues/30) ("Custom agent config in the JSON and database") · follow-ons in [#31](https://github.com/est1908-agentic-ops/agentops-engine/issues/31)
Amends: the worker-fleet model (§7). Supersedes: the planned git-based role manifest ("roles as config", M8). The monolithic architecture doc was removed, so this spec is the standalone authority for the model it describes.

## 1. Why

Issue #30 asks for custom agents — "nightly bughunt → PR", "hourly PR review → merge", "QA → issue", "sweep issues → fix", "agents invoke agents" — that can be added and tuned **without an engine code change or redeploy**.

The five use-cases are a small set of generic pipeline *shapes*; the per-project variation is pure config (prompt, schedule, budget, model routing, verify commands), not novel structure. So custom agents are **code-first, git-sourced**:

- **Tier 1** — a project schedules/triggers a **built-in workflow** through a git-committed `agents.json` manifest, tuned via `ProjectConfig`. No project code, runs on the shared fleet.
- **Tier 2** — a project that needs a workflow *shape* no built-in provides authors its own TypeScript workflow using `@agentops/engine-sdk` and runs it in **its own worker**, delegating heavy activities back to the engine.

Both are git-sourced, PR-reviewed, agent-improvable, and require **no engine rebuild**.

## 2. The capability ladder

| Tier | A project gets | Cost to the project | Engine rebuild? |
|---|---|---|---|
| **1. Config manifest** | schedule/trigger a **built-in** workflow (`whiteboxBugHunt`, `qaProbe`) or `devCycle`, tuned via `ProjectConfig` + `agents.json` | none — runs on the shared fleet | never |
| **2. Per-project worker** | **custom workflow structure in TS**, using `@agentops/engine-sdk`; heavy activities delegated to the engine | its own worker image + deploy in its namespace | never (project deploys its own worker) |

All five #30 use-cases are covered by **Tier 1** except a project-specific external source (e.g. Rollbar), which is **Tier 2**. Build Tier 1 first.

## 3. Tier 1 — built-in workflows + `agents.json` manifest + reconciler

**The built-in catalog is exactly three workflows** (`packages/workflows`), each a normal Temporal TS workflow parameterized by project + `ProjectConfig` (resolved via the existing `resolveRepoConfig`):
- `devCycle` — **already exists**: the Issue→PR pipeline (design→plan→implement→verify→review→PR→babysit-to-merge). It also already covers "review a PR to merge-ready" (its `pr_babysit` loop) and "fix an issue" — so no separate PR-sweep or issue-sweep workflow is needed.
- `whiteboxBugHunt({ repo, focus? })` — **new**: read-only agent over the source → structured findings → `createIssue(labels:['bug'])`.
- `qaProbe({ repo, previewUrl })` — **new**: probe agent (Playwright/MailPit against a preview) → `createIssue` per finding.

**The loop, without extra sweep workflows:** the finders (`whiteboxBugHunt`, `qaProbe`) file labeled issues; the **existing M3 Gateway trigger** (issue-labeled → `devCycle`) picks each up and drives it to a merged PR. So "sweep issues → fix" and "PR review → merge" are `devCycle` + the trigger layer, not new built-ins. The new workflows reuse `devCycle`/`platform` patterns (proxies, policies) and record `agent_run_stats` with fixed-enum stages — no new observability plumbing.

**The manifest** — `agents.json` in the project repo (git-sourced, PR-reviewed):

```jsonc
{
  "agents": [
    { "name": "nightly-bughunt", "workflow": "whiteboxBugHunt", "schedule": "0 2 * * *", "input": { "focus": "auth & billing" } },
    { "name": "nightly-qa",      "workflow": "qaProbe",         "schedule": "0 3 * * *", "input": { "previewUrl": "https://staging.acme.lab" } }
  ]
}
```

Validated by a zod `AgentsManifestSchema` in `contracts`. `workflow` must name a registered workflow; `schedule` is cron (or `"continuous"` for a long-running poll workflow). `input` is passed as workflow args, merged with `{ repo, project, config }` the reconciler resolves.

**The reconciler** (`ConfigSync`) — reads each managed project's `agents.json` (via `ScmPort.readFile`, reusing `load-project-config.ts`) on repo push (Gateway) and on a periodic Schedule, then **reconciles** the declared agents into **Temporal Schedules** (`ScheduleClient` create/update/delete). Config *is* the state: removing an entry deletes its Schedule. Each Schedule starts its workflow on the shared fleet queue with `{ repo, project, config, ...input }`.

## 4. Tier 2 — `@agentops/engine-sdk` + per-project worker

For workflows whose *structure* isn't a built-in (e.g. a Rollbar monitor), a project authors TS workflows and runs its own worker. The Temporal constraint (workflow code is bundled into a worker at startup; you cannot inject project code into the engine's worker without a rebuild, and it would break per-project isolation) is resolved by a **per-project workflow worker** that delegates heavy activities back to the engine.

**The SDK** — `@agentops/engine-sdk` (fallback name `@est1908/agentops-engine-sdk` if the `@agentops` npm org is unavailable), a **thin facade** published **public on npmjs** (secret-free: types + workflow-safe helpers only; nothing proprietary; `files: ["dist"]`). Built with tsup (ESM+CJS+`.d.ts`), bundling the used bits of `contracts`/`policies` so it's self-contained; `@temporalio/*` are peer deps. Two entry points enforce the sandbox split:
- `@agentops/engine-sdk/workflow` — safe inside a workflow: the `EngineActivities` types, `engineActivities()`/`engineAgent()` proxy factories (targeting `ENGINE_QUEUE`), typed child wrappers (`childDevCycle(input): Promise<DevCycleState>` via `executeChild('devCycle', …)` — starts by name, no engine code bundled), and pure parsers (`parseFindings`, `parseVerdict`).
- `@agentops/engine-sdk/worker` — Node-side: `createEngineWorker({ taskQueue, namespace, workflowsPath, activities })`.

The **compatibility contract** (semver'd): `EngineActivities` signatures, child-workflow names/shapes, and `ENGINE_QUEUE`. Projects pin a version and upgrade at their own pace. Public-on-npm means no auth/cross-org friction (GitHub Packages npm requires a token even for public packages and the CI `GITHUB_TOKEN` can't read another org's packages — rejected for that reason); the facade is secret-free, so public visibility costs nothing.

**The per-project worker** — the project repo holds `agentops/workflows/*.ts`, a `worker.ts` entrypoint (`createEngineWorker` on the project's own queue in the project's namespace), optional project-owned activities (e.g. `rollbarFetch`, holding the project's *own* external secret), and `agents.json`. Project CI builds a worker image; ArgoCD runs it in the project namespace. **Adding/changing a project workflow = the project rebuilds its own worker; the engine image is untouched.**

**Activity routing** — project workflows call `engineActivities()` which proxies to `ENGINE_QUEUE`, so all privileged, credential-holding activities (`runAgent` = K8s Jobs, SCM writes with the per-project token, workspace ops) run on the engine's fleet. `executeChild('devCycle', { taskQueue: ENGINE_QUEUE })` runs the built-in pipeline on the engine's fleet. The project worker stays pure orchestration + its own non-engine integrations.

## 5. Shared activities & prompts (engine-side, added once)

One new engine activity is needed by the finders above, added once and reusable by every project (via `TrackerPort` + `create-activities.ts`):
- `createIssue({ repo, title, body, labels, dedupeFingerprint? })` — **new**; today's ports have `getIssue`/`commentOnIssue`/`labelIssue`/`openPr` but no create. `dedupeFingerprint` collapses repeat findings into one issue.

(No `listIssues`/`listOpenPrs`/`mergePr` — those were only for the dropped sweep workflows; `devCycle` + the Gateway trigger handle fix-and-merge.)

Prompts (`whitebox-bughunt.md`, `investigate-rollbar.md`, …) live in the project repo (`agentops/prompts/`), resolved by the agent-runner — no code change to add a prompt.

## 6. Worked examples

Condensed; full versions were validated during design.
- **Tier 1 — nightly whitebox bughunt:** `agents.json` entry `{ workflow: "whiteboxBugHunt", schedule: "0 2 * * *" }` files `bug`-labeled issues; the Gateway trigger turns each into a `devCycle` PR. No project code.
- **Tier 1 — nightly QA:** `{ workflow: "qaProbe", schedule: "0 3 * * *", input: { previewUrl } }` files issues per finding; same fix loop. No project code.
- **Tier 2 — Rollbar monitor:** project `rollbarMonitor` workflow: its own `rollbarFetch` activity (its token) + durable cursor + `continueAsNew`; per finding, `engineAgent().runAgent(investigate)` in a workspace, then `engine.createIssue(labels:['bug'], dedupeFingerprint)`. Deployed by the project; engine untouched.

## 7. Architecture impact

- **Worker fleet model (changed by this spec):** "one worker fleet serves all repos" becomes "**one shared fleet runs the engine activities + built-in workflows; projects may additionally run their own workflow workers**." Config-only (Tier 1) projects need no worker of their own.
- **Supersedes the planned git `RoleManifest`:** a "role/custom agent" is an `agents.json` entry (Tier 1) or a project workflow (Tier 2), not an engine-repo manifest.
- This spec is the authority for that model; there is no separate architecture doc to keep in sync (it was removed).

## 8. Decomposition into sub-projects

| # | Sub-project | Delivers |
|---|---|---|
| **1** | **Tier 1: manifest + reconciler + `whiteboxBugHunt`** | `AgentsManifestSchema` (contracts); the `ConfigSync` reconciler (reads `agents.json`, creates/updates/deletes Temporal Schedules); the `createIssue` activity; the `whiteboxBugHunt` built-in. Gate: an `agents.json` entry, once reconciled, runs `whiteboxBugHunt` on schedule and files a `bug`-labeled issue via `createIssue` — proven e2e on the stub backend. (`qaProbe` waits for preview infra; it's SP3.) |
| 2 | Tier 2: SDK + per-project worker | Publish `@agentops/engine-sdk` (public npmjs, tsup, `/workflow`+`/worker`); a reference per-project worker + task-queue routing; `createEngineWorker`. Gate: a project-repo workflow runs in its own worker and delegates activities + a child `devCycle` to the shared fleet. |
| 3 | `qaProbe` + triggers | `qaProbe` (needs preview deploys + Playwright/MailPit, M7); webhook/label + a `workflowClosed` trigger kind (self-heal auto-start on a `devCycle` ending `blocked`/`failed`). |
| 4 | Mission Control | View/manage `agents.json`-derived agents, their Schedules, and runs. |

Recommended order **1 → 2 → 3 → 4**; SP1 delivers most of #30 with least risk and no packaging work.

## 9. Definition of done (SP1, the first plan)

- `AgentsManifestSchema` in `contracts` (+ tests); `createIssue` in `TrackerPort` + `create-activities` (+ tests).
- `whiteboxBugHunt` workflow exported from `packages/workflows` (auto-registered via `workflowsPath`).
- `ConfigSync` reconciler: reads `agents.json` via `ScmPort`, diffs against existing Temporal Schedules, applies create/update/delete.
- e2e (stub backend): a manifest with a scheduled `whiteboxBugHunt` reconciles to a Temporal Schedule; triggering that Schedule runs the workflow, which files a `bug`-labeled issue via `createIssue`. (The filed issue → `devCycle` fix loop is the existing M3 Gateway trigger, exercised separately.)
- `pnpm lint && pnpm typecheck && pnpm test` green; `pnpm e2e` green.
- CLAUDE.md/AGENTS.md already name `docs/superpowers/specs/` as the design authority — no separate architecture doc to update.

## 10. Open questions

- **Reconciler as workflow vs. service.** A Temporal `ConfigSync` workflow (durable, replayable) vs. a control-side loop. Lean workflow; settle in the plan.
- **`agents.json` location + trigger to reconcile.** On Gateway push webhook and/or a periodic Schedule; pin in SP1's plan.
- **Finding dedup.** `whiteboxBugHunt` must not re-file the same bug nightly; `createIssue`'s `dedupeFingerprint` (search existing open issues by fingerprint before creating) is the mechanism — pin the fingerprint scheme in the plan.
- **Cross-repo `executeChild`** (a workflow whose PR lands in a different repo than the trigger, via a `targetRepo`) — SP3.
