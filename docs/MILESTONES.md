# Milestones

Build order for the platform. Source of truth for *why* each milestone exists: [ARCHITECTURE.md](ARCHITECTURE.md) §8/§8.1. This file tracks *what* and *status*. Every milestone ships something runnable; infra arrives only when the thing it supports exists.

Phase mapping: M0–M3 = Phase 1 (autonomous dev cycle), M4–M5 harden it, M6 = Phase 2 (self-healing), M7 = Phase 3 (recurrent quality), M8 = Phase 4 (custom roles), M9 = Phase 5 (budget analytics).

## M0 — Walking skeleton (MVP, no cluster) — done

Full spec: [M0-SPEC.md](M0-SPEC.md). Engine monorepo scaffold; `contracts`, `policies` (repair loop, brakes, verdict parsing — unit-tested), `workflows/devCycle`, stub backend, in-memory ports. Temporal dev server. No k8s, no real repo, zero token spend.

- [x] pnpm monorepo scaffold + CI (lint, typecheck, test)
- [x] `contracts` v0 schemas
- [x] `policies` with unit tests encoding ARCHITECTURE.md §2 semantics
- [x] `ports` interfaces + memory adapters; `backends` interface + stub
- [x] `devCycle` workflow: stages, repair loop, brakes, signals, babysit
- [x] e2e: fake issue → fake merge-ready PR, incl. forced repair round + tripped brake

**Done when:** one command runs an e2e where a fake issue becomes a fake PR through all stages, including a forced repair-loop iteration and a tripped brake.

## M1 — First real PR (still local) — done

`claude` backend (CLI spawn, usage + sentinel parsing), GitHub ports, worktree activities, `agentops.json` config loading, admin CLI trigger.

**Done when:** a real issue on a test repo becomes a real PR with green CI via `engine start --issue N`; brakes and escalation verified against the live backend.

## M2 — Into the cluster — infra shipped, gate not yet run — ⬅ CURRENT

k3s + ArgoCD + SOPS/age bootstrap (see `agentops-platform`); Technitium + step-ca; Temporal & Postgres via Helm; worker Deployment; agent-runner image; `runAgent` switches to K8s Jobs (heartbeat, cancel-kills-Job, NetworkPolicy).

**Done when:** M1's scenario runs entirely in-cluster, and a wiped host rebuilds to working state from the two repos.

**Status (2026-07-06):** all 8 ArgoCD Applications `Synced`/`Healthy` on a rebuilt host — the infra half of the gate holds. The actual gate (a real issue → real in-cluster PR) has **not** been executed yet. Remaining before it can run: (1) a way to invoke `engine start --issue <N>` against the in-cluster Temporal (README's port-forward runbook is written but unexercised), (2) real `GITHUB_TOKEN`/z.ai `ANTHROPIC_AUTH_TOKEN` values in place of today's placeholders, (3) confirm the agent-runner Job pod actually receives the `claude-credentials` secret's env vars. None of these are new engineering — they're the last mile of an already-built path.

**Hardening (2026-07-06, implementation in progress):** M1/M2 shipped with a single global `GITHUB_TOKEN` shared by every project/repo the worker fleet ever touches — a problem as soon as a second real project needs its own least-privilege credential. A **project registry** (per-project GitHub tokens, chart-driven) replaces it; see [project-registry-design.md](superpowers/specs/2026-07-06-project-registry-design.md) for the engine-side design and the runbook for onboarding a new repo/project. The registry's *data* and each project's SOPS-encrypted secret live in `agentops-platform`, not here — see that repo's [forge-project-secrets-design.md](https://github.com/flair-hr/agentops-platform/blob/main/docs/superpowers/specs/2026-07-06-forge-project-secrets-design.md) for how a per-project token is encrypted, wired through KSOPS, and materialized into the cluster. **Not on the critical path for a single project** — one shared token is fine until project #2 shows up; this is a prerequisite for M5's "two repos" done-when criterion, not for M2's gate.

**Also (2026-07-06):** the single-image consolidation for agent-CLI backends (`images/agent-claude/` → `images/agent-runner/`, both `claude` and `pi` in one image) landed, and `pi` now runs as a real K8s Job in-cluster instead of falling back to a local process (it previously would have failed silently in that mode). Each backend has its own auth secret (`CLAUDE_AUTH_SECRET_NAME`/`PI_AUTH_SECRET_NAME`) — no longer sharing one.

## M3 — Hands-off loop → Phase 1 gate

Gateway webhooks (issue labeled → DevCycle; PR/CI events → signals); `pr_babysit` durable timers; `blocked`/`clarify`/`resume`; feedback-hash dedupe.

**Done when:** label an issue, do nothing else — PR reaches merge-ready, including addressing a human review comment.

**Status (2026-07-06):** the issue-labeled → `devCycle` webhook trigger is implemented (`packages/gateway`, [design doc](superpowers/specs/2026-07-06-gateway-design.md)) — signature verification, event filtering, registry-based config loading, idempotent workflow start, chart Deployment/Service, CI image build. `pr_babysit`/`blocked`/`clarify`/`resume`/feedback-hash dedupe were already done since M0 (poll-based, not webhook-pushed — accepted per ARCHITECTURE.md §5.3, PR/CI event webhooks are an optional future responsiveness improvement, not required for this gate). **Not yet done:** the gateway isn't reachable from GitHub's real webhook delivery — that needs a public DNS name + a real (Let's Encrypt) TLS cert, a decision spanning `agentops-platform` that hasn't been made (see the design doc's "Open questions"). Until that's resolved, this milestone's actual gate ("label an issue, do nothing else") can't be exercised for real — the code is ready, the exposure isn't.

**Status (2026-07-09):** a second tracker is wired into the same Gateway — labeling a Linear issue with a project's configured trigger label (a label UUID, not name; Linear's webhook payload never carries the name) now starts `devCycle` the same way GitHub's issue-labeled path does ([design doc](superpowers/specs/2026-07-09-linear-trigger-design.md)). `trackerType` in the project registry is a discriminated union (`github` | `linear`) instead of a hardcoded literal; `TrackerPort` dispatch (`packages/ports`) routes by the ref's own shape (GitHub `owner/repo#N` vs. `linear:TEAMKEY-N`) rather than always assuming a GitHub-shaped ref. Linear-tracked projects are static-registry-only — the Postgres-backed managed-project registry stays GitHub-only for now. Same public-exposure gap as the GitHub route applies to `/webhooks/linear` too.

## M4 — See everything, control everything

Alloy + LGTM; OTel spans from workers and runner Jobs; `agent_run_stats` projection; Grafana dashboards; MailPit. **Mission Control v0** (React): board, start/resume/clarify/stop, run detail with live logs.

**Done when:** trace → logs → workflow history walkable for any task without kubectl; cost of last PR is a Grafana panel; a task can be started, watched, and rescued from `blocked` in the browser.

## M5 — Multi-backend & budget enforcement

`pi` + `cursor` backends; LiteLLM (virtual keys, hard caps); per-stage model routing + escalation from config; subscription rate-window awareness. Per-project GitHub credentials (project registry, M2 hardening above) already make running two repos side by side safe; this milestone is what makes them route to different models too.

**Done when:** two repos run different stage/model routing; a deliberately low budget trips the brake with a clear reason.

**Status (2026-07-07):** decomposed into 4 sub-projects ([decomposition doc](superpowers/specs/2026-07-07-m5-decomposition.md)) — per-stage routing and escalation turned out to already be fully wired since M0; the actual gap was that nothing routed through LiteLLM. (1) LiteLLM gateway deployed in `agentops-platform` — [PR #20](https://github.com/flair-hr/agentops-platform/pull/20), not yet merged/synced to a live cluster. (2) `litellm` backend, (3) budget-exceeded → `blocked` wiring + e2e proof of both gate halves, (4) subscription rate-window awareness — all three implemented, tested, and committed on `agentops-engine`'s `thundering-area` branch — [PR #14](https://github.com/flair-hr/agentops-engine/pull/14), not yet merged. **Not yet done:** both PRs need review/merge; a real `ZAI_API_KEY` and a live in-cluster call are operator steps (DEPLOY.md Phase 8.1) not exercised from this sandbox. `cursor` backend is an explicit non-goal for now, deferred pending an automation-ToS check (ARCHITECTURE.md §9/§10).

## M6 — Self-healing → Phase 2 gate

`Heal` workflow auto-starts on `blocked`/`failed`; GlitchTip → `ProdErrorTriage` → auto-filed issue → DevCycle with incident profile.

**Done when:** an injected agent failure and an injected prod exception each end in a merged fix or a well-reasoned human escalation.

**Status (2026-07-07):** the manually-triggered `platform` workflow ([design](superpowers/specs/2026-07-07-platform-agent-design.md), [plan](superpowers/plans/2026-07-07-platform-agent.md)) generalizes this milestone's diagnosis-and-fix capability — same "read Temporal history + logs, fix via a devCycle PR" shape, just prompted by a human instead of auto-triggered. When this milestone starts, `Heal`'s auto-trigger should be a thin signal handler that starts a `platform` run with a synthesized prompt on `blocked`/`failed`, not a second diagnosis pipeline built from scratch.

## M7 — Recurrent quality → Phase 3 gate

Schedules: `BugHunt`, `SecurityReview` (Semgrep/Trivy + agent), `EvalRun`; preview deploys (`pr-N.app.lab`); `QASquad` + `ProductProbe` (Playwright + MailPit API); `ConfigSync` + project-defined triggers & jobs (ARCHITECTURE.md §6.1).

**Done when:** recurring flows file issues that flow through the pipeline unattended; ≥1 such fix merges per week.

## M8 — Roles as config → Phase 4 gate

`RoleManifest` loading (workflow + prompt pack + tools + budget); serving roles (`kind: service`, ARCHITECTURE.md §6.3); `MetaOptimize` as first pure-config role.

**Done when:** a new role goes from manifest PR to first useful output with zero engine code changes.

## M9 — Budget intelligence → Phase 5 gate

`BudgetReport` schedule; spend/speed dashboards per project×role×model; routing recommendations backed by `EvalRun` scores.

**Done when:** one routing recommendation is accepted and shows measured savings at equal quality.
