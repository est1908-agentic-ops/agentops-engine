# Platform agent (`platform` workflow) — design

Status: draft v1 · 2026-07-07 · Owner: Artem

## 1. What this is

A new Temporal workflow, registered under workflow type **`platform`** (alongside the existing `devCycle`), that lets a human ask a free-text question or give a free-text task about the platform or any product, and get investigation, diagnosis, cluster/log inspection, and — where warranted — a fix, without picking a specific stage or writing a scripted playbook per question. Examples this needs to handle unchanged from the original ask:

1. "Investigate the last workflow failures and create fixes" (PR in either/both repos).
2. "Check logs. All good, do you see something strange?"
3. "Reflect on agent logs during workflow execution — what can we improve in product or platform/engine?"
4. "Check cluster k8s state, resource info."

**Interaction model:** single-shot, not conversational. One prompt in, one workflow run, ends when the agent is done. Follow-up = start another `platform` run. A multi-turn chat UI is explicitly out of scope for this design (see §8).

**Trigger:** Temporal's native "Start Workflow" UI — workflow type `platform`, input `{"prompt": "..."}`. No new UI is built for v1. The workflow's return value renders as the pretty-printed JSON "Results" panel Temporal UI already shows for any completed workflow, which is sufficient to read `summary`, `actionsTaken`, and `childWorkflows` without any custom frontend.

## 2. Relationship to existing architecture

This is not a wholly new concept — it consolidates pieces already planned or already prototyped:

- **Generalizes `Heal` (M6, ARCHITECTURE.md §6, not yet started).** Same underlying capability (diagnose from Temporal history + logs, fix via PR), but manually triggered with a free-form prompt instead of auto-triggered on `blocked`/`failed`, and not scoped to a single task's failure. **Recommendation:** when M6 is built, `Heal`'s auto-trigger becomes a thin signal handler that starts a `platform` run with a synthesized prompt (e.g. `"diagnose and fix why <workflowId> ended blocked"`), rather than a second, separately engineered diagnosis pipeline. Update `MILESTONES.md`'s M6 entry to reflect this when that work starts.
- **Fulfills the "ad-hoc prompt task" line** already listed under Mission Control's planned Actions (ARCHITECTURE.md §5.10) — this workflow *is* that feature, built now, ahead of Mission Control's UI existing.
- **Reuses `devCycle` entirely for fixes** (§5 below) — no new implement/verify/review/babysit machinery.
- **Does not replace `MetaOptimize`** (M8, scheduled/recurring, config-driven role) — that stays future work; `platform` is the manual/ad-hoc counterpart, not a scheduled one.
- **Supersedes/absorbs `debug-devcycle-issue`** (the existing `.claude/skills/` playbook) — its curl-based Temporal REST + Grafana/Loki technique becomes the core of this workflow's toolbelt (§6), extended with Prometheus queries and read-only kubectl.

This repo (`agentops-engine`) is the only repo touched by this spec: new workflow, contracts, prompt pack, agent-runner image addition, chart RBAC/NetworkPolicy. Two things this design depends on live in `agentops-platform` and are **not** part of this spec's engineering scope (tracked as preconditions, §9):

- Temporal UI/API must sit behind Traefik auth (basic auth or OIDC) before this ships.
- `agentops-engine` and `agentops-platform` need entries in the project registry's `projects` map (already repo-agnostic — no schema change needed, just data) if `platform` is going to be able to start child `devCycle` runs against them.

## 3. Contracts (`packages/contracts`)

New file, `packages/contracts/src/platform-agent.ts` — distinct from `TaskInput` (which requires `product`/`repo`/`config: ProductConfig` up front and doesn't fit a prompt that may span multiple repos discovered at runtime):

```ts
export const PlatformAgentInputSchema = z.object({
  prompt: z.string().min(1),
  hintRepos: z.array(z.string()).optional(), // optional steer, doesn't restrict scope
});
export type PlatformAgentInput = z.infer<typeof PlatformAgentInputSchema>;

export const PlatformAgentResultSchema = z.object({
  summary: z.string(),
  actionsTaken: z.array(z.object({
    type: z.enum(['terminate', 'signal']),
    workflowId: z.string(),
    reason: z.string(),
  })).default([]),
  childWorkflows: z.array(z.object({
    workflowId: z.string(),
    repo: z.string(),
    goal: z.string(),
  })).default([]),
});
export type PlatformAgentResult = z.infer<typeof PlatformAgentResultSchema>;
```

The agent's own sentinel-delimited output (parsed by the `runAgent` activity, same convention as `VERDICT:`/`FULL:`) reports `summary`, `actionsTaken`, and `proposedFixes: {repo, goal}[]` — `proposedFixes` is not part of the final result type; the workflow consumes it to start child workflows and replaces it with the real `childWorkflows` (with actual workflow IDs) in the value it returns.

## 4. Orchestration flow (`packages/workflows/src/platform.ts`, function `platform`)

The workflow itself stays thin — one activity call plus N child-workflow starts, no new stage machinery:

1. `platform` workflow starts with `PlatformAgentInput`.
2. Calls the existing `runAgent` activity (same one `devCycle`'s stages use) with the new `platform` role: its own prompt pack (§6), model/backend routing tier, and this role's widened Job permissions (§6). `hintRepos`, if given, is passed through as prompt context only ("start by looking at these repos") — it does not scope or restrict credentials (§6 covers what the Job can actually reach).
3. Inside that one sandboxed session, the agent investigates freely — queries Temporal/Grafana/kubectl, reads read-only clones of whichever repos it needs, and may directly execute safe Temporal actions (terminate/signal) since those happen inside the Job process, not in workflow code (no violation of the determinism boundary — same reasoning as `devCycle`'s implement stage running git/npm inside its Job).
4. The agent finishes with a structured result: `summary`, `actionsTaken` it already performed, and `proposedFixes`.
5. For each proposed fix, the workflow:
   a. Calls an activity to load that repo's `ProductConfig` (`agentops.json`) — reusing the typed config-discovery helper already extracted in `packages/cli/src/load-product-config.ts` rather than duplicating that logic.
   b. Constructs a `TaskInput` (`taskId`, `product`, `repo`, `goal` from the proposed fix, `config`) and calls `executeChild(devCycle, taskInput)` — a native Temporal SDK call, not an activity, staying inside the determinism boundary.
6. Workflow assembles the final `PlatformAgentResult` (`summary` + `actionsTaken` as reported by the agent + real child workflow IDs from step 5) and returns it.

## 5. Fix mechanism: hand off to child `devCycle`

`platform` never writes code or opens a PR itself. When it concludes a fix is needed, it starts a child `devCycle` for that repo with a synthesized goal (the existing "jobs" pattern from ARCHITECTURE.md §6.1 — goal-driven, no tracker issue required, `output: "pr"`). The fix then gets `devCycle`'s full existing rigor for free: `implement → full_verify → review → pr → pr_babysit`, matching the architecture's rule that all fixes — prod incidents included — converge on the same pipeline. This is also why `platform`'s own Job needs no write/push git credentials at all (§6): the only place a commit ever happens is inside a child `devCycle`'s own workspace, using that repo's already-provisioned registry token.

Multiple proposed fixes across multiple repos in a single `platform` run are supported — one child `devCycle` per repo.

## 6. Agent Runner Job customization for the `platform` role

This is the one place this role's Job differs from `devCycle`'s. `devCycle` Jobs are untouched — zero cluster API access, same as today.

- **NetworkPolicy** (new, scoped to this role's Job selector only): egress to the Temporal frontend, Grafana (Loki + Prometheus datasource proxy), forge (read-only clone), LiteLLM/provider endpoints.
- **Credentials injected only into this role's Job:**
  - Temporal REST/CLI access — read (describe, history, list) and the two allowed write actions (terminate, signal) — same host `debug-devcycle-issue` already targets.
  - Grafana basic-auth credentials — same pattern as that skill, extended to also query Prometheus (not just Loki) for cluster/resource state.
  - A scoped **read-only kubeconfig**: new ServiceAccount + ClusterRole granting `get`/`list`/`watch` only — no `exec`/`delete`/`patch`/`create`. Mounted only into this Job.
  - Read-only forge tokens for **every** repo in the project registry (all products + `agentops-engine` + `agentops-platform`, once registered per §9) — not just `hintRepos`, since the point of this role is it may need to investigate any of them and doesn't know which ones in advance. Reuses existing per-repo project-registry tokens (read is a subset of the write scope they already grant; no new token type).
  - **No push/write git credentials** — see §5.
- **New playbook baked into the shared agent-runner image**, `images/agent-runner/skills/platform-ops/SKILL.md` — available in every `platform`-role Job regardless of which repo(s) it clones for read access (unlike `.claude/skills/`, which only exists if `agentops-engine` itself happens to be the checked-out workspace). Covers: the curl-based Temporal REST + Grafana/Loki technique from `debug-devcycle-issue`, extended with Prometheus queries, read-only kubectl usage, and the sentinel-delimited output format (`summary` / `actionsTaken` / `proposedFixes`) instead of writing code directly. `debug-devcycle-issue`'s existing `.claude/skills/` entry can be retired in favor of this once it ships.
  - Because `SKILL.md`/the Skill-tool convention is Claude-Code-specific, the same playbook content is also embedded directly in the `platform` role's prompt pack (next bullet) so backends without a skill-discovery mechanism (`pi`, etc.) still get the instructions — the baked-in `SKILL.md` is a `claude`-backend convenience layer on top, not the only copy.
- **New prompt pack**, `packages/prompts/platform/`, versioned per the existing convention — the role's system framing (what it's allowed to do, the sentinel output format, the toolbelt playbook content per the point above).
- **Model/backend routing**: new routing-config entry for role `platform`, defaulting to the same strong tier `devCycle` uses for `design`/`review` — this is a reasoning-heavy, multi-step-investigation role, not a cheap one.

## 7. Safety and budgets

- Reuses the existing `policies/` brake mechanisms (`maxTokens`, `maxIterations`, wall-clock timeout) — this role gets its own budget profile (likely a higher token ceiling than a single `devCycle` stage, since one investigation session covers what could be several stages' worth of reasoning), enforced by the workflow/activity layer, not by trusting the agent.
- Blast-radius limits, all decided explicitly rather than defaulted into:
  - No k8s writes — read-only kubeconfig only.
  - No direct git push — all code changes go through a child `devCycle`'s own PR + CI + review + babysit gate.
  - Temporal actions limited to terminate/signal (reversible, orchestration-layer only) — no reset, no admin operations, no k8s-level restarts/scaling.
- **Hard precondition:** Temporal UI/API must sit behind Traefik-level auth (basic auth or OIDC, matching the pattern ARCHITECTURE.md §5.10 already plans for Mission Control) before this ships. `platform` is meaningfully more powerful than `devCycle` to hand to anyone who can reach the public "Start Workflow" button — the screenshot's `temporal.agentic-ops.est1908.top` host is a real public DNS name today, not the internal-only `*.lab` zone the rest of the platform uses. This is `agentops-platform` work, tracked as a dependency, not built as part of this spec.

## 8. Testing

Per AGENTS.md's definition of done (lint/typecheck/test green; e2e green for anything touching workflows/policies/activities/backends):

- Unit tests for the `platform` workflow using `TestWorkflowEnvironment` (same pattern already used for `devCycle`'s babysit timers): mock `runAgent`'s result to verify zero proposed fixes → no child workflow started; N proposed fixes → N `executeChild` calls with the correct repo/goal; result assembly is correct.
- `stub`-backend e2e test (same zero-token-spend pattern as `devCycle`'s M0 e2e): a fake investigation session returns a canned sentinel result with one proposed fix; assert a child `devCycle` actually starts with the expected `TaskInput`.
- New RBAC/NetworkPolicy chart resources get a golden-file test, matching the existing `render.golden.yaml` pattern already used for the `claude`/`pi` auth secrets.
- No live-cluster test of the read-only kubeconfig or real Temporal actions in CI — those are operator-verified once deployed, same caveat M2/M5 already carry for real credentials.

## 9. Preconditions (tracked, not built here)

- **Temporal auth** (`agentops-platform`): Traefik IngressRoute middleware (basic auth or forward-auth → OIDC) in front of the Temporal UI/API host. Blocks shipping this feature, not just a nice-to-have.
- **Project registry entries** (`agentops-platform`): `agentops-engine` and `agentops-platform` added to the `projects` map (already repo-agnostic, no code change) so `platform` can start child `devCycle` runs against the platform's own repos, not just product repos.

## 10. Non-goals

- Multi-turn chat / conversational UI — single-shot only (§1).
- A custom trigger UI — Temporal's native Start Workflow UI is sufficient for v1; a nicer interface is Mission Control's job later.
- k8s write actions (restart/scale/delete) — read-only kubeconfig only.
- Auto-triggering — that's `Heal` (M6), built later on top of this workflow (§2).
- `platform` writing code or pushing directly to any branch — all fixes go through a child `devCycle`.
- Solving the Temporal-auth gap itself — flagged as a precondition (§9), implemented in `agentops-platform`.
