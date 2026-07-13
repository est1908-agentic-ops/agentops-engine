# Self-heal (`selfHeal` workflow + scheduled trigger) — design

Status: draft v1 · 2026-07-13 · Owner: Artem

## 1. What this is

A scheduled trigger that periodically drives the existing platform agent to find recent workflow failures and open fix PRs — the **M6 "Heal"** capability, built as a thin auto-trigger on top of the `platform` workflow exactly as the platform-agent spec §2 prescribed.

A Temporal Schedule fires every ~30 minutes and starts a thin **`selfHeal`** workflow, which runs a child **`platform`** agent with a fixed self-heal prompt. The platform agent discovers recent failures from inside its own Job (its existing Temporal-REST + Loki toolbelt — "**Option 1**", agent-side discovery, chosen in brainstorming over a TS-side discovery pass), diagnoses them, and proposes fixes, which open PRs through child `devCycle` runs with full CI/review/babysit rigor.

**Interaction model:** fully automated, no human in the loop *to trigger*. A human still merges every PR — self-heal **opens PRs only**. Autonomous merge (gated by a Vision/Architecture document) is **Feature C**, a separate later spec, explicitly out of scope here.

**This is Feature B** of the three-part effort brainstormed 2026-07-13 (A = platform chat, shipped separately; C = auto-merge). It depends on nothing from A — both are independent layers on the unchanged one-shot `platform` workflow.

## 2. Relationship to existing architecture

Reuse top to bottom; two small new pieces (`selfHeal` workflow + schedule-ensure), no new pipeline:

- **Realizes M6 "Heal"** as the platform-agent spec §2 intended: *"when M6 is built, `Heal`'s auto-trigger becomes a thin signal handler that starts a `platform` run with a synthesized prompt … rather than a second, separately engineered diagnosis pipeline."* This spec is scheduled/polling (the user's "run every 30 min") rather than event-driven; the event-driven `workflowClosed` → self-heal hook noted in the custom-agent-workflows SP3 spec stays a possible later refinement.
- **Reuses the one-shot `platform` workflow unchanged** (`packages/workflows/src/platform.ts`) — one `runAgent` call + N `executeChild(devCycle)` for proposed fixes. `platform` is already a recognized built-in workflow (`BUILTIN_WORKFLOWS` in `packages/contracts/src/agents-manifest.ts`). `selfHeal` starts it as a child; nothing about `platform` changes.
- **Clones the `reconcile:all` schedule pattern** (`packages/worker/src/ensure-reconcile-schedule.ts`): a boot-ensured Temporal Schedule created idempotently on every worker start, no manual step. Self-heal's schedule is the same shape at a `*/30` cadence.
- **Not MetaOptimize (M8).** MetaOptimize is a separate future scheduled/config-driven role (platform-agent spec §2). Self-heal is the failure-fixing sweep, not the optimization role — don't conflate.

The only genuinely new content is the self-heal *prompt* and one addition to the `platform-ops` skill (§5): teaching the agent to **enumerate** recent failures (today's skill triages one already-known workflow).

## 3. Trigger & schedule

A boot-ensured Temporal Schedule, mirroring `ensureReconcileSchedule`:

- **Schedule id:** `self-heal`.
- **Spec:** `cron: { cronString: <configurable, default '*/30 * * * *'>, timezone: 'UTC' }`.
- **Action:** `{ type: 'startWorkflow', workflowType: 'selfHeal', args: [], taskQueue: ENGINE_QUEUE, workflowId: 'self-heal' }` — the fixed `workflowId` base makes each run `self-heal-<scheduled-time>`, cleanly distinguishable from manual `platform-<uuid>` runs in Temporal visibility.
- **Overlap policy:** `SKIP`. Combined with the workflow *awaiting* its child `platform` run (§4), this serialises sweeps: if an investigation runs longer than the interval, the next tick is skipped rather than piling up concurrent self-heal sweeps.
- **Ensured on worker boot**, idempotently (swallow `/already exist/i`), in `packages/worker/src/main.ts` next to the existing `ensureReconcileSchedule` call. **Gated by the enable flag (§6):** when enabled, create; when disabled, best-effort delete the schedule so the flag is a true on/off switch.

## 4. The `selfHeal` workflow (`packages/workflows/src/self-heal.ts`)

Deliberately thin — it constructs no state and does no discovery itself:

```ts
export async function selfHeal(): Promise<PlatformAgentResult> {
  const runId = workflowInfo().workflowId;
  return executeChild(platform, {
    workflowId: `${runId}-platform`,
    args: [{ prompt: SELF_HEAL_PROMPT }],
  });
}
```

- Takes **no input** (the Schedule passes `args: []`).
- Starts a child `platform` with the fixed `SELF_HEAL_PROMPT` (§5) and a deterministic child workflowId.
- **Awaits** the child (`executeChild`, not fire-and-forget) so the `overlap: SKIP` policy actually serialises sweeps, and so a self-heal run's Temporal history reflects the investigation it drove.
- **Returns the child's `PlatformAgentResult` verbatim** — no new contract. The result (summary, actionsTaken, childWorkflows = the fix PRs' devCycle runs, skippedFixes) is visible in Temporal's UI for audit; the fix PRs themselves are the durable output.

No new zod contracts are needed for this feature — input is empty, output reuses `PlatformAgentResult`, and `SELF_HEAL_PROMPT` is a constant (see §5).

## 5. The self-heal prompt & `platform-ops` skill addition

**`SELF_HEAL_PROMPT`** — a constant string co-located with the workflow. This is *trigger input* (the equivalent of what a human types into the console prompt box), not an agent-stage template, so a constant is consistent with existing precedent (the console's hardcoded `SUGGESTED_PROMPTS`), not a violation of AGENTS.md's "prompts live in `packages/prompts`" rule (which governs stage templates like `platform.md`). It instructs the agent to:

1. **Enumerate** recent workflow failures/terminations (roughly the last 30 minutes) across the platform and its projects, via the Temporal visibility API.
2. **Diagnose** the genuine ones (ignore transient/expected closes).
3. **Propose fixes** for those with a clear cause — which open PRs via child `devCycle` — **but first check for an already-open PR or branch for that failure and skip duplicates** (the primary dedup mechanism under Option 1).
4. **Exit immediately** with an empty summary if nothing is actionable, to keep quiet cycles cheap.
5. Scope: the `agentops-engine` and `agentops-platform` repos plus registered projects.

**`platform-ops` skill addition** (`images/agent-runner/skills/platform-ops/SKILL.md`) — the one substantive content change. Today the skill triages a *known* workflow (the `debug-devcycle-issue` technique). Self-heal needs the prior step: **listing recent failed/terminated workflows via the Temporal visibility API** (status-filtered query over a recent time window). Add that query recipe to the skill so any `platform`-role Job — self-heal-driven or manual — can find failures, not just triage a given one. Mirror the content into the platform prompt pack per the platform-agent spec §6's dual-copy convention (skill for `claude`, prompt-embedded for backends without skill discovery).

## 6. Configuration

- **`selfHeal.enabled`** — chart value, **default `true`** (enabled by default, per the brainstorming decision). Env `SELF_HEAL_ENABLED` (default `'true'`). When false, the boot logic deletes the schedule.
- **`selfHeal.cron`** — chart value, default `'*/30 * * * *'`. Env `SELF_HEAL_CRON`.
- Wired as env in `charts/engine/templates/deployment.yaml` (the worker deployment) mirroring `temporalAddress`, with the two keys added to `charts/engine/values.yaml`.

## 7. Safety, cost, and dedup (Option-1 characteristics, stated honestly)

- **PRs only, human merges.** Self-heal never merges; every fix goes through a child `devCycle`'s PR + CI + review + babysit gate. No direct push.
- **No new credentials or blast radius** beyond what the `platform` agent already has. `platform`'s existing token brake (`PLATFORM_MAX_TOKENS`) bounds each sweep.
- **Cost when quiet:** because discovery is agent-side (Option 1), every scheduled tick spins up a `platform` Job even when nothing has failed. Mitigated by the prompt's exit-fast rule and `overlap: SKIP`, but not eliminated — this is the accepted cost of the thin design. Operators can widen the cron interval, or disable the flag, per environment.
- **Dedup across cycles:** prompt-instructed (the agent checks for an existing open PR/branch before proposing a fix). This is agent judgment, not a hard guarantee — a persistent failure could in principle draw a second PR if the agent misses the first. Acceptable for v1; a TS-side dedup/seen-store is the natural hardening if duplicates show up in practice.
- **Serialisation:** `overlap: SKIP` + awaited child prevents overlapping sweeps.

## 8. Testing

Per AGENTS.md's definition of done (lint/typecheck/test green; e2e green for workflow changes):

- **`packages/workflows`** — `TestWorkflowEnvironment` test for `selfHeal`: mock/stub the child `platform` and assert it is started with a `PlatformAgentInput` whose `prompt === SELF_HEAL_PROMPT` and that `selfHeal` returns the child's result. (Use the `stub` backend / a child-workflow mock, zero token spend.)
- **`packages/worker`** — unit test for `ensureSelfHealSchedule` mirroring `ensure-reconcile-schedule.test.ts`: enabled → `create` called with `scheduleId: 'self-heal'`, `workflowType: 'selfHeal'`, cron from opts, `overlap: SKIP`, `taskQueue` = engine queue; idempotent when it already exists; disabled → `getHandle('self-heal').delete()` called, and a not-found delete is swallowed.
- **Helm** — extend `charts/engine/tests/render.golden.yaml` for the two new worker env vars (`SELF_HEAL_ENABLED`, `SELF_HEAL_CRON`), matching the existing golden-file convention.
- **No CI test of live schedule creation** — operator-verified in-cluster, same caveat `reconcile:all` already carries.

## 9. Helm / deploy

- `charts/engine/values.yaml`: add a `selfHeal:` block (`enabled: true`, `cron: "*/30 * * * *"`).
- `charts/engine/templates/deployment.yaml`: two env entries on the `worker` container (`SELF_HEAL_ENABLED`, `SELF_HEAL_CRON`), mirroring `TEMPORAL_ADDRESS`.
- No new image, service, ingress, or RBAC — self-heal reuses the worker and the `platform` role's existing Job/RBAC. `agentops-platform`'s values override may set a different cron or disable it per environment.

## 10. Preconditions (tracked, not built here)

- **`agentops-engine` + `agentops-platform` registered as projects** so the platform agent's proposed fixes to the engine/platform repos actually start child `devCycle` runs (`resolveRepoConfig` needs a registered project with SCM credentials). This is the identical precondition the platform-agent spec §9 already flagged; without it, self-heal can still fix *registered project* repos but will report engine/platform fixes as `skippedFixes`.
- **Worker Temporal client** — already wired (`packages/worker/src/main.ts` constructs it for `reconcile:all` schedule ops); no new precondition.

## 11. Non-goals (v1)

- TS-side failure discovery (Option 2) — discovery is agent-side.
- Autonomous auto-merge / the Vision-Architecture gate (Feature C).
- Event-driven trigger on `blocked`/`failed` (the SP3 `workflowClosed` hook) — polling only.
- Dedicated `blocked`-devCycle discovery via the custom `status` search attribute (the agent may still surface these from logs, but no designed TS path).
- One `platform` run per failure — a single sweep per cycle handles all recent failures (the platform agent is built to investigate multiple failures at once).
- A console UI for self-heal — its runs are visible in Temporal by the `self-heal-*` workflowId prefix; a Mission Control surface is later work.
