# agentops-engine

Temporal workflows that turn tracker issues into merge-ready PRs via pluggable agent CLIs (`claude`, `pi`, `codex`, …). Builds images and worker code; deploy state lives in **`agentops-platform`** (GitOps, Helm, secrets).

**Docs:** [ARCHITECTURE.md](docs/ARCHITECTURE.md) · [MILESTONES.md](docs/MILESTONES.md) · [M0-SPEC.md](docs/M0-SPEC.md) · [AGENTS.md](AGENTS.md)

## Develop

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e
```

`pnpm e2e` uses `TestWorkflowEnvironment` — no Temporal server required.

## Run locally

Requires a running Temporal dev server, a Postgres instance, and `agentops.json` in the target repo (or a config registered directly on the project). Projects are registered exclusively in the DB-backed managed project registry (`managed_projects` table) — see [managed-project-registry-design.md](docs/superpowers/specs/2026-07-08-managed-project-registry-design.md) and the [Linear trigger design's DB-only addendum](docs/superpowers/specs/2026-07-09-linear-trigger-design.md). Set up the encryption keypair + DB connection in `.env`:

```
ENGINE_DB_HOST=localhost
PROJECT_CREDENTIAL_PRIVATE_KEY=<base64 PKCS8 DER, from generateManagedProjectKeyPair()>
PROJECT_CREDENTIAL_PUBLIC_KEY=<base64 SPKI DER, same keypair>
CONTROL_CRUD_TOKEN=dev-token
```

Then register a project through `control`'s API (the CLI is a thin HTTP client of it):

```bash
pnpm engine project add --project my-project --repo owner/repo --token ghp_xxx
```

No DB configured at all → DEMO mode (in-memory ports + stub backend, no tokens spent). `--project` must match the registered project for the given `--repo` once one is registered.

```bash
# terminal 1
temporal server start-dev

# terminal 2
pnpm worker

# terminal 3 (control, for the `engine project` commands above)
pnpm --filter @agentops/control run start

# terminal 4
pnpm engine start \
  --issue owner/repo#42 --repo owner/repo --project my-project --goal "..."
```

### Start via GitHub label

Add the **`agentops`** label to an issue on a registered repo to start `devCycle` automatically — no CLI command. The [gateway](packages/gateway/README.md) handles GitHub `issues` / `labeled` webhooks and starts the same workflow as `engine start` (`goal` = issue title). Override the trigger label with `TRIGGER_LABEL` (default `agentops`).

Requires worker + Temporal (above), a project registered via `engine project add`, and the gateway running with `GITHUB_WEBHOOK_SECRET`:

```bash
# terminal 3 (instead of engine start)
GITHUB_WEBHOOK_SECRET=your-shared-secret \
pnpm --filter @agentops/gateway run start
```

Point the repo webhook (Settings → Webhooks) at `POST https://<gateway-host>/webhooks/github` with the same secret, content type `application/json`, and **Issues** events. For local dev, tunnel port 3000 (e.g. `ngrok http 3000`) so GitHub can reach the gateway.

Re-adding the label while a task is running is a no-op; re-labeling after the workflow completes starts a fresh run.

Inspect and signal:

```bash
pnpm engine state <task-id>
pnpm engine signal <task-id> resume
```

**Opens a real PR and spends real tokens** — use a disposable test repo and check routing in `agentops.json` first.

### Start via Linear label

Linear issues start `devCycle` the same way GitHub issues do — by adding a label — but the wiring differs because Linear's webhook payload carries label *IDs* (UUIDs), not names. There is no GitHub-style `TRIGGER_LABEL` default: each Linear-tracked project is configured with its own trigger-label UUID (`linearTriggerLabelId`).

A Linear-tracked project still needs a GitHub repo + token (SCM stays GitHub-only — the PR lands in a GitHub repo regardless of which tracker filed the task). Register one with:

```bash
pnpm engine project add \
  --project my-project \
  --repo owner/repo \
  --token ghp_xxx \
  --tracker-type linear \
  --linear-team-key ENG \
  --linear-trigger-label-id <label-uuid> \
  --linear-token lin_api_xxx
```

- `--tracker-type linear` switches this project off the GitHub webhook path onto the Linear one (immutable once set — changing tracker means `engine project remove` + re-add).
- `--linear-team-key` is the prefix of every issue identifier in the team (`ENG-123` → `ENG`). The gateway routes a webhook to this project by matching it.
- `--linear-trigger-label-id` is the Linear label **UUID**, not its name. Find it once via Linear's GraphQL API (query `teams { labels { nodes { id name } } }`) or the label's settings URL. This is a one-time manual step, the same shape as configuring a webhook secret.
- `--linear-token` is a Linear API key (`lin_api_…`) used to read the issue and post the PR link back as a comment.

Then run the gateway with `LINEAR_WEBHOOK_SECRET` set (the route 404s entirely when it's unset — a deployment with no Linear projects needs no new secret):

```bash
GITHUB_WEBHOOK_SECRET=gh-secret \
LINEAR_WEBHOOK_SECRET=lin-secret \
pnpm --filter @agentops/gateway run start
```

In Linear, register a workspace webhook pointing at `POST https://<gateway-host>/webhooks/linear` with the same shared secret. The signature is `Linear-Signature` (raw hex HMAC-SHA256 over the raw body, no `sha256=` prefix) plus a 5-minute freshness window on `webhookTimestamp` — both verified server-side, so set them once and leave them.

Add the trigger label to an issue in the configured team and `devCycle` starts with workflow id `linear-<project>-<identifier>` (`linear-my-project-ENG-123`) — `goal` = issue title. Re-adding the label while running is a no-op; re-labeling after completion starts a fresh run.

Mission Control's create/edit form doesn't yet expose Linear fields — use `engine project add`/`update` until it does.

## Images & chart (M2/M3)

Three images build from this repo:

- `images/engine/Dockerfile` (`--target worker`) — runs the worker via the
  same `tsx src/main.ts` entrypoint used locally (`pnpm worker`); see the
  engine-image-and-chart design doc for why this isn't a compiled
  `node dist/main.js` image.
- `images/agent-runner/Dockerfile` — `git` + every agent backend's CLI
  (`claude`, `pi`) in one shared image (ARCHITECTURE.md §5.4: both are thin
  `npm install -g` wrappers with no conflicting deps, so one pinned image
  covers all backends instead of one per backend), with a placeholder
  `step-ca-root.crt` baked in. **Before building this image for a real
  cluster**, replace `images/agent-runner/step-ca-root.crt` with the real
  root CA certificate exported from step-ca (see agentops-platform's
  platform-components design doc for the export command) — the placeholder
  lets the image build today but issues no real trust to internal services.
- `images/engine/Dockerfile` (`--target gateway`) — the M3 webhook receiver ([design doc](docs/superpowers/specs/2026-07-06-gateway-design.md)), same plain `node:22-slim` + pnpm shape as the worker image, no CLI installs.

CI builds all three on every push/PR and pushes immutable tags to the self-hosted
registry on merge to `main`:

`gitactions.est1908.top/agentic-ops/{worker,agent-runner,gateway}:<git-sha>`

A follow-up CI job commits that same `<git-sha>` into
`agentops-platform`'s `clusters/ops/engine/values.yaml` (and pins the chart
`targetRevision` in `application.yaml`). Argo CD auto-sync then rolls the dev
cluster — no manual platform PR and no `kubectl rollout restart`.

Requires repo secret **`PLATFORM_PAT`**: a fine-grained personal access token
scoped to only `est1908-agentic-ops/agentops-platform` with **Contents:
Read and write** permission (store it only in GitHub Actions secrets, never
in code).

`charts/engine/` is the Helm chart for the worker Deployment (RBAC to manage
agent-runner Jobs, the `workspace-tasks`/`workspace-cache` PVCs). It ships no
real image tag or registry — `agentops-platform` supplies those as a values
override. Render it locally with:

```bash
helm template engine charts/engine --namespace dev-agents
```

## In-cluster runbook (M2 gate)

After `agentops-platform` bootstrap and ArgoCD sync (see that repo's `docs/BOOTSTRAP.md`):

1. Confirm ArgoCD Applications are `Healthy` / `Synced`.
2. Port-forward Temporal from your laptop (no external gRPC ingress in M2):

```bash
kubectl port-forward svc/temporal-frontend 7233:7233 -n temporal &
TEMPORAL_ADDRESS=localhost:7233 TEMPORAL_NAMESPACE=dev-agents pnpm --filter @agentops/cli engine start \
  --issue owner/repo#42 --repo owner/repo --project my-project --goal "..."
```

3. Watch agent invocations run as Jobs, not local processes:

```bash
kubectl get jobs -n dev-agents -w
```

4. Verify the PR reaches merge-ready with green CI (same M1 test repo).

5. Re-run M1's brake/escalation test (`maxTokens` deliberately low) in-cluster.

6. Wipe the host (or reprovision the disposable VM) and repeat from step 1 — this is the literal M2 gate.

External Temporal access for automation (Gateway webhooks) is M3, not deferred by accident.

## Layout

`packages/{contracts,ports,backends,policies,workflows,activities,worker,cli}` — workflows are deterministic policy; activities are all I/O. See [ARCHITECTURE.md §5.9](docs/ARCHITECTURE.md) for the full tree.
