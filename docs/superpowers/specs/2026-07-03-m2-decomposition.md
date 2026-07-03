# M2 — Into the Cluster — Decomposition

Status: draft · 2026-07-03 · Owner: Artem
Milestone: M2 (see [MILESTONES.md](../../MILESTONES.md#m2--into-the-cluster), [ARCHITECTURE.md §5.1/§5.4/§5.9](../../ARCHITECTURE.md))

## Context

M1 proved the pipeline against a real GitHub repo and a real `claude` CLI, spawned locally on the worker host. M2's gate — "M1's scenario runs entirely in-cluster, and a wiped host rebuilds to working state from the two repos" — is a different kind of milestone than M0/M1: it's mostly infrastructure (k3s, ArgoCD, Helm charts, a new K8s Job execution path) split across **two repos** (`agentops-engine` for code/images/charts, `agentops-platform` for cluster state), not TypeScript features in one monorepo.

`agentops-platform` is currently a skeleton: `docs/BOOTSTRAP.md` already has a decided provisioning approach staged (no Ansible/Terraform yet — `bootstrap.sh` + `cloud-init.yaml`, ArgoCD app-of-apps, SOPS/age), but `bootstrap/root-app.yaml` and `.sops.yaml` are placeholders and `clusters/ops/{platform,engine,products}/` are empty. `agentops-engine` has no `images/` or `charts/` directories yet, and `runAgent` today calls `AgentBackend.run()` in-process via `ProcessCliBackend` (local `child_process.spawn`) — ARCHITECTURE.md §5.9 decision #2 already anticipated this needing to become a K8s Job launcher.

Too large for one spec. This doc decomposes M2 into five sub-projects, in the dependency order they should be designed and built, and pins the cross-cutting decisions that every sub-project below must agree with rather than re-deciding independently.

## Sub-projects

1. **[Platform bootstrap](../../../../agentops-platform/docs/superpowers/specs/2026-07-03-platform-bootstrap-design.md)** (`agentops-platform`) — fills in `docs/BOOTSTRAP.md`'s steps 2–4 concretely: age keypair generation, ArgoCD install + KSOPS repo-server patch, `root-app.yaml` completion. No dependency on anything else; builds on the already-decided `bootstrap.sh`/`cloud-init.yaml` approach.
2. **[Platform components](../../../../agentops-platform/docs/superpowers/specs/2026-07-03-platform-components-design.md)** (`agentops-platform`) — ArgoCD Applications + Helm values for step-ca + cert-manager, Technitium, Temporal + Postgres; the `dev-agents` namespace and its NetworkPolicy. Depends on (1) for ArgoCD to exist; manifest authoring itself has no runtime dependency.
3. **[Engine image & chart](2026-07-03-engine-image-and-chart-design.md)** (`agentops-engine`) — `images/worker/`, `images/agent-claude/` Dockerfiles; CI build+push to GHCR; `charts/engine/` Helm chart (worker Deployment, ServiceAccount/RBAC for Job management, workspace PVCs). No dependency on the others — can be built and tested against any k3s cluster.
4. **[K8s Job runner](2026-07-03-k8s-job-runner-design.md)** (`agentops-engine`) — the `runAgent` code change: extracts the per-CLI `buildArgs`/`parseOutput` logic out of `ProcessCliBackend` into a reusable `CliSpec`, adds `K8sJobRunner` (an `AgentBackend` that launches a K8s Job per call). Depends on (3) for the image/PVC contract (names, mount paths) it targets, but is unit-testable with an injected fake K8s client, no cluster required.
5. **[M2 wiring](2026-07-03-m2-wiring-design.md)** (`agentops-engine`) — the integration step: in-cluster mode switch (mirrors M1's `GITHUB_TOKEN`-presence pattern, keyed on `KUBERNETES_SERVICE_HOST`), `TEMPORAL_ADDRESS` pointed in-cluster, the manual runbook that actually exercises the M2 gate. Depends on all four above being done.

Recommended build order: **1 → 3 in parallel with 2 → 4 → 5**. (3) and (2) don't depend on each other and can proceed at the same time; (4) needs (3)'s image/PVC contract decided (not built) before its design is final.

## Cross-cutting decisions (binding on all five sub-projects)

- **Registry & image naming.** `ghcr.io/<org>/agentops-engine/{worker,agent-claude}`, tagged by git SHA. CI (in `agentops-engine`) builds and pushes on merge to `main`; bumping the tag in `agentops-platform`'s `clusters/ops/engine/values.yaml` is a manual PR for M2 (the automated tag-bump bot described in ARCHITECTURE.md §5.8 is not in scope — nothing in M2's gate requires it).
- **In-cluster detection.** `KUBERNETES_SERVICE_HOST` (auto-injected into every pod by Kubernetes) is the signal the worker uses to pick `K8sJobRunner` over `ProcessCliRunner` — no new flag or config field, same reasoning M1's wiring doc used for `GITHUB_TOKEN`: the environment already tells the truth, a flag would just be a second thing to forget.
- **Workspace storage stays a single shared PVC**, mounted at the same path (`/workspace`) by both the worker Deployment and every agent-runner Job pod — this is what makes `WorkspaceManager`'s existing `prepare`/`cleanup` code (M1, unmodified) keep working unchanged when a Job pod (not the worker process itself) is what actually runs `git`-adjacent CLI work inside that directory. RWO/single-node is accepted per ARCHITECTURE.md §9's existing risk note; revisit only if the cluster grows multi-node.
- **Namespace scope for M2 is `dev-agents` only.** Per-product namespaces (§5.7) and the products registry ApplicationSet (§5.8) are not needed yet — M2's gate is one disposable test repo, the same one M1 used. Explicit non-goal, not an oversight.
- **What M2 explicitly excludes:** LiteLLM, the LGTM/Alloy observability stack, MailPit, GlitchTip (all M4+), Gateway/webhooks (M3), a second backend image (`agent-pi`) in-cluster (M2 needs only `claude`, matching M1 wiring's live-mode default), automated GitOps tag-bumping.

## Definition of done

All five sub-projects' specs reviewed and implemented; `pnpm e2e` (memory-mode) unaffected; the M2 wiring runbook executed once end-to-end: a wiped host, following `docs/BOOTSTRAP.md` with no improvisation, reaches a state where `engine start --issue N` against the M1 test repo produces a real merge-ready PR using a K8s Job (not a local process) for every agent CLI invocation.

## Open questions carried forward

- Temporal gRPC frontend exposure outside the cluster (for `engine` CLI use) — M2 wiring proposes `kubectl port-forward` as the pragmatic answer and defers real external exposure to M3's Gateway; flagged there, not re-litigated per sub-project.
- Automated image-tag-bump bot for `agentops-platform` — explicitly deferred, revisit if manual tag bumps become the bottleneck.
