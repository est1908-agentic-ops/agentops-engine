# Milestones

Build order for the platform. Source of truth for *why* each milestone exists: [ARCHITECTURE.md](ARCHITECTURE.md) §8/§8.1. This file tracks *what* and *status*. Every milestone ships something runnable; infra arrives only when the thing it supports exists.

Phase mapping: M0–M3 = Phase 1 (autonomous dev cycle), M4–M5 harden it, M6 = Phase 2 (self-healing), M7 = Phase 3 (recurrent quality), M8 = Phase 4 (custom roles), M9 = Phase 5 (budget analytics).

## M0 — Walking skeleton (MVP, no cluster) — ⬅ CURRENT

Full spec: [M0-SPEC.md](M0-SPEC.md). Engine monorepo scaffold; `contracts`, `policies` (repair loop, brakes, verdict parsing — unit-tested), `workflows/devCycle`, stub backend, in-memory ports. Temporal dev server. No k8s, no real repo, zero token spend.

- [ ] pnpm monorepo scaffold + CI (lint, typecheck, test)
- [ ] `contracts` v0 schemas
- [ ] `policies` with unit tests encoding ARCHITECTURE.md §2 semantics
- [ ] `ports` interfaces + memory adapters; `backends` interface + stub
- [ ] `devCycle` workflow: stages, repair loop, brakes, signals, babysit
- [ ] e2e: fake issue → fake merge-ready PR, incl. forced repair round + tripped brake

**Done when:** one command runs an e2e where a fake issue becomes a fake PR through all stages, including a forced repair-loop iteration and a tripped brake.

## M1 — First real PR (still local)

`claude` backend (CLI spawn, usage + sentinel parsing), GitHub ports, worktree activities, `agentops.json` config loading, admin CLI trigger.

**Done when:** a real issue on a test repo becomes a real PR with green CI via `engine start --issue N`; brakes and escalation verified against the live backend.

## M2 — Into the cluster

k3s + ArgoCD + SOPS/age bootstrap (see `agentops-platform`); Technitium + step-ca; Temporal & Postgres via Helm; worker Deployment; agent-runner image; `runAgent` switches to K8s Jobs (heartbeat, cancel-kills-Job, NetworkPolicy).

**Done when:** M1's scenario runs entirely in-cluster, and a wiped host rebuilds to working state from the two repos.

## M3 — Hands-off loop → Phase 1 gate

Gateway webhooks (issue labeled → DevCycle; PR/CI events → signals); `pr_babysit` durable timers; `blocked`/`clarify`/`resume`; feedback-hash dedupe.

**Done when:** label an issue, do nothing else — PR reaches merge-ready, including addressing a human review comment.

## M4 — See everything, control everything

Alloy + LGTM; OTel spans from workers and runner Jobs; `agent_run_stats` projection; Grafana dashboards; MailPit. **Mission Control v0** (React): board, start/resume/clarify/stop, run detail with live logs.

**Done when:** trace → logs → workflow history walkable for any task without kubectl; cost of last PR is a Grafana panel; a task can be started, watched, and rescued from `blocked` in the browser.

## M5 — Multi-backend & budget enforcement

`pi` + `cursor` backends; LiteLLM (virtual keys, hard caps); per-stage model routing + escalation from config; subscription rate-window awareness.

**Done when:** two repos run different stage/model routing; a deliberately low budget trips the brake with a clear reason.

## M6 — Self-healing → Phase 2 gate

`Heal` workflow auto-starts on `blocked`/`failed`; GlitchTip → `ProdErrorTriage` → auto-filed issue → DevCycle with incident profile.

**Done when:** an injected agent failure and an injected prod exception each end in a merged fix or a well-reasoned human escalation.

## M7 — Recurrent quality → Phase 3 gate

Schedules: `BugHunt`, `SecurityReview` (Semgrep/Trivy + agent), `EvalRun`; preview deploys (`pr-N.app.lab`); `QASquad` + `ProductProbe` (Playwright + MailPit API); `ConfigSync` + product-defined triggers & jobs (ARCHITECTURE.md §6.1).

**Done when:** recurring flows file issues that flow through the pipeline unattended; ≥1 such fix merges per week.

## M8 — Roles as config → Phase 4 gate

`RoleManifest` loading (workflow + prompt pack + tools + budget); serving roles (`kind: service`, ARCHITECTURE.md §6.3); `MetaOptimize` as first pure-config role.

**Done when:** a new role goes from manifest PR to first useful output with zero engine code changes.

## M9 — Budget intelligence → Phase 5 gate

`BudgetReport` schedule; spend/speed dashboards per product×role×model; routing recommendations backed by `EvalRun` scores.

**Done when:** one routing recommendation is accepted and shows measured savings at equal quality.
