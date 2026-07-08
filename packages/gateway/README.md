# gateway

Small HTTP service: GitHub webhook receiver → `startWorkflow(devCycle)`. Design: [docs/superpowers/specs/2026-07-06-gateway-design.md](../../docs/superpowers/specs/2026-07-06-gateway-design.md).

## What it does

- `POST /webhooks/github` — verifies the GitHub HMAC signature (`X-Hub-Signature-256`), and for an `issues` event with `action: labeled` where the label matches `TRIGGER_LABEL` (default `agentops`), resolves the repo to a registered project (`PROJECT_REGISTRY_JSON`, same registry the worker uses), loads that repo's `agentops.json`, and starts `devCycle` with a deterministic workflow id (`issue-<owner>-<repo>-<number>`) so a redelivered or duplicate label event is a no-op, not a second overlapping task. Every other event/action/label is acknowledged (204) and ignored — not an error.
- `GET /healthz` — liveness/readiness.

## Configuration (env vars)

| Var | Required | Purpose |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | yes | HMAC secret configured on each registered repo's webhook (Settings → Webhooks) |
| `TEMPORAL_ADDRESS` | no (default `localhost:7233`) | Temporal frontend to start workflows against |
| `PROJECT_REGISTRY_JSON` + `GITHUB_TOKEN__<PROJECT>` | no (empty registry → every webhook is acknowledged and ignored) | Same project registry the worker consumes |
| `TRIGGER_LABEL` | no (default `agentops`) | Which issue label starts a task |
| `PORT` | no (default `3000`) | HTTP listen port |

## Not yet wired

Getting a webhook delivery from GitHub to this service at all requires it to be reachable from the public internet — a real DNS name + a real (Let's Encrypt, not the internal step-ca CA) TLS certificate, distinct from the `*.lab`-style internal-only services elsewhere in this stack. `charts/engine`'s `gateway` Deployment/Service are ClusterIP-only; the public-facing Ingress/cert is a deliberate open decision for `agentops-platform`, not an oversight — see the design doc's "Open questions."
