# Custom agent workflows — SP3 (Triggers: auto-fire + manual run from the console) — design

Status: draft v1 · 2026-07-12 · Owner: Artem
Tracks: [#31](https://github.com/est1908-agentic-ops/agentops-engine/issues/31) (SP3 row) · Parent: [#30](https://github.com/est1908-agentic-ops/agentops-engine/issues/30)
Builds on: SP1 (#34 — manifest + `ConfigSync` reconciler + `whiteboxBugHunt` + `createIssue`/dedup) and SP2 (#37 — `@agentic-ops/engine-sdk`, per-project workers, project-identity authz, continuous agents, search-attribute auto-register).
Design authority: this doc is the SP3 authority; the master design (`2026-07-12-custom-agent-workflows-design.md`) governs the overall model (issue→fix loop §6, dedup §6, observability §7).

## 1. Why

SP1 built the reconciler and the first finder; SP2 made per-project workers safe. But **nothing fires on its own yet**: the `ConfigSync` reconciler is never triggered, agent-filed issues aren't picked up, and there's no way to run an agent on demand. SP3 is the **trigger layer** that turns the built machinery into a running loop, plus a manual **"Run now"** from the control console.

The through-line: *events → workflows*. A repo push reconciles that project's agents; an `agent:fix`-labeled issue becomes a deduped `devCycle` PR; an operator can trigger any scheduled agent immediately from the UI.

## 2. Scope & phasing

SP3 in #31 lists six items. Two are separable and one is infra-blocked, so SP3 delivers a **coherent core** and defers the rest:

**In SP3:**
- **A. `ConfigSync` trigger wiring** (§3) — push-driven + periodic reconcile. *Foundational: without it, SP1/SP2 never run.*
- **B. Issue→fix trigger completion** (§4) — `issues.opened`-with-label fix, `agent:fix` label, fix-dedup, `agent:working` lifecycle.
- **C. Scheduled Tier-2 queue fix** (§5) — Schedules target the agent's own queue, not always `ENGINE_QUEUE`.
- **F. Run from the control UI** (§6) — list `agent:*` Schedules + a gated "Run now" (`schedule.trigger()`), Tier-1 and Tier-2.

**Deferred (not built here):**
- **D. `workflowClosed` → self-heal** — no `self-heal` workflow exists; the semantics (reuse `devCycle` with a synthesized prompt vs. a dedicated workflow) deserve their own spec, tied to the M6 self-healing thread.
- **E. Cross-repo `executeChild` (`targetRepo`)** — orthogonal to triggering (it concerns where a PR lands); separable.
- **`qaProbe` + `qa` stage** — blocked on preview-deploy infra (M7-era) + Playwright/MailPit; can't be built yet.

## 3. A — `ConfigSync` trigger wiring

The `configSync` workflow (SP1) reconciles one project's `agents.json` into Temporal Schedules. SP3 gives it two triggers:

### 3.1 Push-driven (fast path)
The Gateway gains a **`push`** GitHub webhook handler: verify signature → `repo = payload.repository.full_name` → resolve `repo → project` (managed-project store) → start `configSync({ project, repo })` with a deterministic workflow id **`configsync:<project>`**. The default reuse policy dedupes a burst of pushes (a second push while one reconcile is running is dropped; the running reconcile already reads the latest `agents.json` at execution time). Unregistered repo → acknowledged and ignored (same as today's webhooks).

### 3.2 Periodic safety reconcile (drift / missed webhooks)
A **`reconcileAllProjects`** workflow: an activity `listManagedProjects()` returns every registered `{ project, repo }`; the workflow `executeChild('configSync', { project, repo })` per project (bounded concurrency). A **periodic Temporal Schedule** `reconcile:all` (cron `*/15 * * * *`, on `ENGINE_QUEUE`) fires it. The worker **ensures this Schedule at startup** (idempotent create), the same pattern SP2 uses for search-attribute registration — so a fresh environment self-bootstraps the safety net with no manual step.

Push is the fast path; the periodic reconcile catches missed webhooks and out-of-band drift (a manual Temporal-UI edit is overwritten within ~15 min — config remains the source of truth).

## 4. B — Issue→fix trigger completion

**The `opened`-vs-`labeled` bug (master §6).** GitHub fires `issues.opened` (labels included) when an issue is created *with* a label, and does **not** fire `issues.labeled` for those initial labels. The Gateway today (`parseIssueLabeledEvent`) matches only `action === 'labeled'`, so **agent-filed issues (created with their label) are missed.** SP3 generalizes it to `parseIssueTriggerEvent`, matching **both** `opened` and `labeled` when the payload carries the configured trigger label.

**Opt-in trigger label.** Use a distinct **`agent:fix`** label (the project's configured trigger label) — not every human `bug` issue should auto-fix. `whiteboxBugHunt`/finders file issues with this label so the loop closes; humans add it deliberately.

**Fix dedup (master §6).** `startDevCycleForIssue` switches to workflow id **`devcycle:<project>:<issueNumber>`** with **`WorkflowIdReusePolicy.AllowDuplicateFailedOnly`** — Temporal guarantees at-most-one live fix per issue: a *failed* run can retry, a *running/succeeded* one can't be duplicated. (Today it uses `issue-<project>-<N>` + the default reuse policy; this aligns to the design's convention and tightens the retry semantics.)

**Label lifecycle.** `devCycle` stamps **`agent:working`** on the issue at start (via the existing `labelIssue` activity) and **removes** it at PR-open / terminal. Removal needs a new capability: **`TrackerPort.removeLabel`** + an `unlabelIssue` activity (today's port has `label` but no unlabel). Visible state on the issue, and it prevents re-triggering churn.

## 5. C — Scheduled Tier-2 queue fix

SP2's `applyScheduleChanges` hardcodes `ENGINE_QUEUE` for every Schedule action; only continuous-agent *starts* use `spec.taskQueue`. So a **cron Tier-2 agent** (a project workflow on a schedule) would have its Schedule target `ENGINE_QUEUE`, where the project's code isn't registered — the run would never execute. SP3 fixes the Schedule action to target **`spec.taskQueue ?? ENGINE_QUEUE`**, and `ExistingSchedule`/`reconcileAgents` compare the resolved queue so a mis-queued Schedule is re-pointed on the next reconcile. This is what makes the "both tiers" run-from-UI (§6) actually run Tier-2 scheduled agents.

## 6. F — Run scheduled agents from the control UI

The control server already holds a Temporal `Client` and starts/lists workflows (`handleStartDevCycleRun`). SP3 adds a read + a trigger for the reconciled Schedules:

- **`GET /api/agents`** — list Temporal Schedules with id prefix `agent:` via `client.schedule.list()`, projecting `{ scheduleId, project, agentName, workflow, cron, paused, nextRun? }` (project/agentName/workflow from the Schedule memo the reconciler stamped). **Identity-only, ungated** — same class as `/api/devcycle/targets`.
- **`POST /api/agents/:scheduleId/run`** — `client.schedule.getHandle(scheduleId).trigger()` for an immediate out-of-cadence run. **Gated behind the CRUD token** — it spends tokens and acts on a repo, the same risk class as starting a `devCycle` run. Returns 202 on trigger, 404 if the schedule id is unknown.
- **Both tiers, transparently.** `trigger()` fires the Schedule's configured action, which already encodes the target queue (`ENGINE_QUEUE` for built-ins, the project queue for Tier-2 after §5). No tier-specific control logic. (Continuous agents are singletons, not Schedules, so they don't appear here — they're always running; "Run now" applies to cron-scheduled agents only.)
- **UI.** An "Agents" page listing schedules grouped by project — agent name, workflow, cron, paused state, and a **Run now** button (calls the gated endpoint). List + run only in this cut; pause/resume/edit is SP4 Mission Control.

## 7. Contract & vocabulary changes

| Change | Location | Why |
|---|---|---|
| `push` webhook handler + project resolution | `packages/gateway` | Push-driven reconcile (§3.1) |
| `reconcileAllProjects` workflow + `listManagedProjects` activity | `workflows` / `activities` | Periodic reconcile (§3.2) |
| `reconcile:all` Schedule ensured at worker startup | `packages/worker` | Periodic reconcile bootstrap (§3.2) |
| `parseIssueTriggerEvent` (opened + labeled) | `packages/gateway` | `opened` fix (§4) |
| devCycle id `devcycle:<project>:<issueNumber>` + `AllowDuplicateFailedOnly` | `packages/gateway` | Fix dedup (§4) |
| `TrackerPort.removeLabel` + `unlabelIssue` activity; `agent:working` stamp/drop in `devCycle` | `ports` / `activities` / `workflows` | Label lifecycle (§4) |
| Schedule action queue = `spec.taskQueue ?? ENGINE_QUEUE`; `ExistingSchedule.taskQueue` compared | `activities` / `policies` | Tier-2 scheduled (§5) |
| `AgentScheduleSummarySchema`, list + trigger response schemas | `contracts` | Run-from-UI (§6) |
| `GET /api/agents`, `POST /api/agents/:id/run` (gated) | `packages/control` | Run-from-UI (§6) |
| "Agents" page + API client | `packages/ui` | Run-from-UI (§6) |

No new `Stage` values (SP3 adds no agent step; `qa` is deferred with `qaProbe`).

## 8. Testing

- **Gateway (unit):** `opened`+`agent:fix` triggers a fix; `labeled`+`agent:fix` still triggers; other labels/actions ignored; `push` → `configSync` start (deduped on redelivery); unregistered repo acknowledged/ignored.
- **Policy (unit):** reconcile diff re-points a Schedule whose `taskQueue` drifted; continuous vs. scheduled queue resolution.
- **Activities/workflow (unit):** `startDevCycleForIssue` uses `devcycle:<project>:<issueNumber>` + `AllowDuplicateFailedOnly` (running → not restarted, failed → restartable); `devCycle` stamps `agent:working` on start and removes it at PR/terminal (stub tracker); `removeLabel` on the memory + GitHub tracker.
- **Control (unit):** `GET /api/agents` lists `agent:*` schedules from a mocked `ScheduleClient`; `POST …/run` calls `trigger()` and returns 202; 404 for unknown id; **401 without the CRUD token**; list works ungated.
- **e2e (stub backend):** a reconcile creates a Schedule → the control trigger path calls `trigger()` → the workflow starts; an `agent:fix` `opened` webhook drives one deduped `devCycle`.

## 9. Definition of done (SP3)

- [ ] Gateway `push` handler starts `configSync:<project>` (deduped); `reconcileAllProjects` workflow + `listManagedProjects` activity; `reconcile:all` Schedule ensured at worker startup.
- [ ] Gateway matches `opened`+`labeled` for the `agent:fix` trigger label; fix-dedup id `devcycle:<project>:<issueNumber>` + `AllowDuplicateFailedOnly`.
- [ ] `TrackerPort.removeLabel` + `unlabelIssue`; `devCycle` stamps/drops `agent:working`.
- [ ] Schedule action uses `spec.taskQueue ?? ENGINE_QUEUE`; reconcile re-points drifted queues.
- [ ] `GET /api/agents` (ungated) + gated `POST /api/agents/:id/run` (`schedule.trigger()`); contracts added.
- [ ] UI "Agents" page: list schedules per project + "Run now".
- [ ] `pnpm lint && typecheck && test` green; `pnpm e2e` green; specs updated if implementation deviates.

## 10. Deferred / open questions

- **`workflowClosed` → self-heal** — own spec; decide reuse-`devCycle`-with-synthesized-prompt vs. a dedicated `self-heal` workflow (M6 thread).
- **Cross-repo `executeChild` (`targetRepo`)** — own change; a workflow whose PR lands in a different repo than the trigger.
- **`qaProbe` + `qa` stage** — when preview-deploy infra (M7-era) exists.
- **Trigger-label config source** — SP3 keeps the Gateway's existing trigger-label mechanism; per-project label configuration (vs. a single global label) can follow if projects need distinct labels.
- **Live reconcile→Schedule-fire integration test** and **`filed_findings` deploy provisioning** — cross-cutting ops items from #31, still open.
