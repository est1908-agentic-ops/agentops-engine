# gateway

Small HTTP service: GitHub/Linear webhook receiver → `startWorkflow(devCycle)`. Design: [docs/superpowers/specs/2026-07-06-gateway-design.md](../../docs/superpowers/specs/2026-07-06-gateway-design.md), [Linear trigger design](../../docs/superpowers/specs/2026-07-09-linear-trigger-design.md).

## What it does

- `POST /webhooks/github` — verifies the GitHub HMAC signature (`X-Hub-Signature-256`), and for an `issues` event with `action: labeled` where the label matches `TRIGGER_LABEL` (default `agentops`), resolves the repo to a registered project in the DB-backed managed project registry (`managed_projects` table), loads that repo's `agentops.json`, and starts `devCycle` with a deterministic workflow id (`issue-<owner>-<repo>-<number>`) so a redelivered or duplicate label event is a no-op, not a second overlapping task. Every other event/action/label is acknowledged (204) and ignored — not an error.
- `POST /webhooks/linear` — verifies the Linear HMAC signature (`Linear-Signature`, no `sha256=` prefix) and a webhook-timestamp freshness window, and for an `Issue` `create`/`update` event whose `labelIds` include the *project's* `linearTriggerLabelId` (a label UUID, not name — Linear's webhook payload never carries label names), resolves the issue's team key (`ENG-123` → `ENG`) to a registered `trackerType: 'linear'` project in the same managed project registry, loads that project's `agentops.json` from its GitHub repo, and starts `devCycle` with workflow id `linear-<project>-<identifier>`. 404s entirely (no route) when `LINEAR_WEBHOOK_SECRET` is unset — a deployment with no Linear-tracked projects needs no new secret.
- `GET /healthz` — liveness/readiness.

Projects are registered via `engine project add` (a thin client of `packages/control`'s `/api/projects`), not by editing this service's config — see the [Linear trigger design's DB-only addendum](../../docs/superpowers/specs/2026-07-09-linear-trigger-design.md) and [managed-project-registry-design.md](../../docs/superpowers/specs/2026-07-08-managed-project-registry-design.md).

## Configuration (env vars)

| Var | Required | Purpose |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | yes | HMAC secret configured on each registered repo's webhook (Settings → Webhooks) |
| `TEMPORAL_ADDRESS` | no (default `localhost:7233`) | Temporal frontend to start workflows against |
| `ENGINE_DB_HOST`/`PORT`/`NAME`/`USER`/`PASSWORD` + `PROJECT_CREDENTIAL_PRIVATE_KEY` | effectively required (unset → every webhook is acknowledged and ignored, nothing is registered anywhere) | Managed project registry DB connection + credential decryption key |
| `TRIGGER_LABEL` | no (default `agentops`) | Which issue label starts a task (GitHub only) |
| `LINEAR_WEBHOOK_SECRET` | no (unset → `/webhooks/linear` 404s) | HMAC secret configured on the Linear workspace's webhook |
| `PORT` | no (default `3000`) | HTTP listen port |

Linear-tracked managed projects additionally carry `linearTeamKey` and `linearTriggerLabelId` (a label UUID — find it via Linear's GraphQL API or the label's settings URL, not a name), set via `engine project add --tracker-type linear --linear-team-key ... --linear-trigger-label-id ... --linear-token ...`.

## Not yet wired

Getting a webhook delivery from GitHub to this service at all requires it to be reachable from the public internet — a real DNS name + a real (Let's Encrypt, not the internal step-ca CA) TLS certificate, distinct from the `*.lab`-style internal-only services elsewhere in this stack. `charts/engine`'s `gateway` Deployment/Service are ClusterIP-only; the public-facing Ingress/cert is a deliberate open decision for `agentops-platform`, not an oversight — see the design doc's "Open questions."
