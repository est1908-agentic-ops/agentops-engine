# gateway

Small HTTP service: GitHub and Linear webhook receiver → `startWorkflow(devCycle)`. Design: [docs/superpowers/specs/2026-07-06-gateway-design.md](../../docs/superpowers/specs/2026-07-06-gateway-design.md). The Linear trigger route was retired and has since been re-added against the ConfigMap store (see [docs/superpowers/specs/issue-agentic-ops-engine-169-design.md](../../docs/superpowers/specs/issue-agentic-ops-engine-169-design.md)).

## What it does

- `POST /webhooks/github` — verifies the GitHub HMAC signature (`X-Hub-Signature-256`), and for an `issues` event with `action: labeled` where the label matches `TRIGGER_LABEL` (default `agentops`), resolves the repo to a registered project (`FileManagedProjectStore`, reading the `managed-projects` ConfigMap mounted at `MANAGED_PROJECTS_DIR`), reads that project's GitHub token from the K8s Secret its `tokenSecret` field names (`KubeTokenResolver`), loads that repo's `agentops.json`, and starts `devCycle` with a deterministic workflow id (`issue-<owner>-<repo>-<number>`) so a redelivered or duplicate label event is a no-op, not a second overlapping task. Every other event/action/label is acknowledged (204) and ignored — not an error.
- `POST /webhooks/linear` — (enabled only when `LINEAR_WEBHOOK_SECRET` is set) verifies the Linear HMAC signature (`Linear-Signature`), and for an `Issue` create or update event, resolves the Linear team key to a registered project by `linearTeamKey` from the `managed-projects` ConfigMap. A project with `linearTriggerLabelId` starts `devCycle` when that label is freshly applied; a project without it remains usable through the Linear tracker but acknowledges webhook events without starting tasks. Duplicate and unrelated events are acknowledged and ignored.
- `GET /healthz` — liveness/readiness.

Projects are registered by adding a `<slug>__project.yaml` (+ optional `<slug>__agentops.json`) entry to the `managed-projects` ConfigMap in the platform repo (`clusters/ops/projects/<slug>/` there), not by editing this service's config or calling an API — the console's old `/api/projects` write CRUD was retired. See [docs/superpowers/plans/2026-07-25-engine-projects-configmap-resolver.md](../../docs/superpowers/plans/2026-07-25-engine-projects-configmap-resolver.md).

## Configuration (env vars)

| Var | Required | Purpose |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | yes | HMAC secret configured on each registered repo's webhook (Settings → Webhooks) |
| `LINEAR_WEBHOOK_SECRET` | no | HMAC secret for Linear webhooks; when unset, `/webhooks/linear` returns 404 (Linear disabled) |
| `TEMPORAL_ADDRESS` | no (default `localhost:7233`) | Temporal frontend to start workflows against |
| `MANAGED_PROJECTS_DIR` | no (default `/etc/managed-projects`) | Directory mounted from the `managed-projects` ConfigMap; read once at boot by `FileManagedProjectStore` |
| `AGENT_NAMESPACE` | no (default `dev-agents`) | Namespace `KubeTokenResolver` reads each project's `tokenSecret` → `GITHUB_TOKEN` and `linearTokenSecret` → `LINEAR_API_TOKEN` values from |
| `TRIGGER_LABEL` | no (default `agentops`) | Which issue label starts a task (GitHub only) |
| `PORT` | no (default `3000`) | HTTP listen port |

## Not yet wired

Getting a webhook delivery from GitHub to this service at all requires it to be reachable from the public internet — a real DNS name + a real (Let's Encrypt, not the internal step-ca CA) TLS certificate, distinct from the `*.lab`-style internal-only services elsewhere in this stack. `charts/engine`'s `gateway` Deployment/Service are ClusterIP-only; the public-facing Ingress/cert is a deliberate open decision for `agentops-platform`, not an oversight — see the design doc's "Open questions."
