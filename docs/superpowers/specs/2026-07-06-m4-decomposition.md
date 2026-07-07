# M4 — See Everything, Control Everything — Decomposition

Status: draft · 2026-07-06 · Owner: Artem
Milestone: M4 (see [MILESTONES.md](../../MILESTONES.md#m4--see-everything-control-everything), [ARCHITECTURE.md §5.6/§5.9/§5.10/§8.1](../../ARCHITECTURE.md))

## Context

M4's gate — "trace → logs → workflow history walkable for any task without kubectl; cost of last PR is a Grafana panel; a task can be started, watched, and rescued from `blocked` in the browser" — bundles infrastructure (Alloy + LGTM, MailPit), code instrumentation (OTel spans, a real `agent_run_stats` store), and a from-scratch product (Mission Control v0: React SPA + BFF). Like M2, this spans two repos and is too large for one spec.

Current state going in: `@opentelemetry/api` is only a transitive dependency pulled in by the Temporal SDK — no spans are emitted anywhere yet. `packages/activities/src/stats-store.ts` is an in-memory `Map`; nothing writes to Postgres. `packages/ui` is a placeholder README. None of M4 exists yet.

**Risk carried in from M2/M3:** M2's status note records that the actual gate — a real issue producing a real in-cluster PR — has not been executed yet, only the infra half. M4's OTel spans and `agent_run_stats` rows are only meaningful once a real run happens in-cluster; designing/building M4's pieces doesn't require that gate to have run, but *validating* sub-projects 2–4 against real data does. Not a blocker to decomposing or building M4, but flagged so it isn't mistaken for done when a dashboard is empty.

This doc decomposes M4 into five sub-projects, in the dependency order they should be built, and pins the cross-cutting decisions every sub-project below must agree with rather than re-deciding independently.

## Sub-projects

1. **Platform observability stack** (`agentops-platform`) — ArgoCD Applications + Helm values for Alloy (single OTLP ingestion point), Prometheus, Loki, Tempo, Grafana; MailPit deployment bundled in (small, no code dependency, nothing consumes it until M7's QASquad/ProductProbe — explicit non-goal to wire it up now). No dependency on anything else — buildable and testable against the existing k3s cluster from M2.
2. **OTel instrumentation** (`agentops-engine`) — spans from the worker and agent-runner Jobs: stage span → CLI span → LLM-call spans (OpenLLMetry/OTel-standard per ARCHITECTURE.md §5.6), OTLP export. Depends on (1) for the OTLP endpoint contract (address, port) to target — not on (1) being fully deployed; exportable to a local collector or console exporter during development, same pattern M2's K8s Job runner used for not needing a live cluster to build against.
3. **`agent_run_stats` Postgres projection** (`agentops-engine`, + a DB entry in `agentops-platform`) — replaces `packages/activities/src/stats-store.ts`'s in-memory store with a real Postgres-backed one, in a separate DB on the existing Temporal Postgres instance (ARCHITECTURE.md §5.2). Independent of (1) and (2) — the write-path activity (`recordRunStats`) and its `RunStatsSchema` contract already exist; this is a storage-backend swap.
4. **Grafana dashboards** (`agentops-platform`) — active tasks, cost per PR, tok/s by backend/model, as dashboard-as-code. Depends on (1)+(2)+(3) actually emitting data to build and validate panels against.
5. **Mission Control v0** (`agentops-engine`, `packages/ui`: React SPA + small BFF) — board (Temporal visibility search), actions (start/resume/clarify/stop through existing engine APIs), run detail (stage timeline + token/cost per stage, live Loki-tailed agent output). Board and actions need only Temporal (already exists since M0/M1); live-log-tail needs (2); cost-per-stage needs (3). The largest single piece — likely to need its own sub-decomposition (BFF API vs. frontend) when it's designed in detail.

Recommended build order: **1 → 2 → 3 → 4 → 5**. (3) has no hard dependency on (1)/(2) and could run in parallel with either; it's sequenced third here only because a single implementer benefits from "make the data real" (2 and 3) before "build views on top of it" (4 and 5).

## Cross-cutting decisions (binding on all five sub-projects)

- **Tech choices already fixed by ARCHITECTURE.md §5.6/§5.9/§5.10** — not re-litigated per sub-project: Alloy as the single OTLP ingestion point (nothing ships logs/traces directly to a backend); OTel-standard instrumentation so backends stay swappable; Postgres as projection-only storage (no event bus, no task DB); Mission Control as a client of the same engine APIs agents use, not a second control path; single-user basic auth/OIDC to start, behind Traefik + step-ca.
- **`agent_run_stats` reuses the existing Temporal Postgres instance, separate DB** — no new stateful service to provision.
- **MailPit ships in M4 but stays unused until M7** — explicit non-goal, matching how M2's decomposition doc deferred MailPit itself to "M4+".
- **Mission Control's live updates are read-only streams (SSE, or WebSocket only if a bidirectional need shows up later)**; actions (start/resume/clarify/stop) stay plain request/response through existing engine APIs — only the log tail and run-detail view are streamed.
- **Repo/workspace note:** sub-projects 1 and 4 land in `agentops-platform`, not this repo. `agentops-platform`'s working checkout may be mid-flight on an unrelated branch at the time any given sub-project starts — each platform-side sub-project gets its own branch off `main` there, the same isolation this repo uses per unit of work.

## Definition of done

All five sub-projects' specs reviewed and implemented; for any finished task, trace → logs → workflow history is walkable without `kubectl`; the cost of the last merged PR is a Grafana panel; a task can be started, watched live, and rescued from `blocked` entirely from the browser (Mission Control v0).

## Open questions carried forward

- **DB client library** for sub-project 3 — nothing in the repo today (no `pg`/Kysely/Drizzle dependency); deferred to that sub-project's own design.
- **SSE vs. WebSocket** for sub-project 5's live log tail — deferred to that sub-project's own design; default assumption above is SSE unless a concrete bidirectional need appears.
- **Mission Control sub-decomposition** (BFF vs. frontend as separate designs) — deferred until sub-project 5 is reached; not needed to unblock 1–4.
