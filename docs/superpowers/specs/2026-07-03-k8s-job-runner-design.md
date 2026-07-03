# K8s Job Runner — Design

Status: draft · 2026-07-03 · Owner: Artem
Milestone: M2 — sub-project position TBD (`2026-07-03-m2-decomposition.md` doesn't exist yet; this doc doesn't assume a slot in that list).

## Context

ARCHITECTURE.md §5.4 ("Agent Runner") already decides the shape of this: an activity `runAgent(stage, backend, model, prompt, workspaceRef)` launches a K8s Job from a per-backend image (`agent-claude`, `agent-cursor`, `agent-pi`, `agent-codex`). Jobs run non-root, in a dedicated namespace, with a `NetworkPolicy` restricting egress to forge/LiteLLM/provider endpoints — and, load-bearing for this doc, **no cluster API access**.

`agentops-platform`'s `platform-components-design.md` already references this doc by name (`k8s-job-runner-design.md`) for the `dev-agents` namespace Jobs launch into, but it didn't exist yet — this fills that gap for one specific slice: how a **verify-stage** Job gets the backing services (Postgres, Redis, etc.) a product's own test suite needs.

Verified against a real product repo (`broccoli`): its `test:e2e:backend`/`test:e2e:frontend` targets are already infrastructure-agnostic — they only need `TEST_DATABASE_URL`/`REDIS_URL`-style env vars pointing at *some* reachable Postgres/Redis. `docker-compose.e2e.yml` (local dev) and GitHub Actions' `services:` key (that repo's own CI) are just two different ways of feeding the same env vars to the same test code. A verify-stage Job can't reuse either mechanism directly — it has no Docker daemon and, per §5.4, no cluster API access to provision anything itself. Granting either (a Docker socket/DinD sidecar, or k8s permissions to create resources) would undo the isolation §5.4 exists to provide — the same trade-off already rejected for where the GitHub Actions self-hosted runner lives (see `agentops-platform`'s `docs/BOOTSTRAP.md`, "Decisions already made").

## Goal

A verify-stage Job launched by `runAgent` for a product whose `agentops.json` declares `verify.services` ends up with those services running as sidecar containers in the same pod, reachable at `localhost`, healthy before the product's own verify command runs — with zero changes to the product's test code and zero cluster-API access granted to the Job itself.

## Non-goals

- Migrating any product off `docker-compose` for local developer workflows — untouched; this doc only concerns what happens inside a K8s Job.
- Ephemeral per-run namespaces or any k8s resource creation initiated by the Job or its container — rejected in favor of static sidecars-in-pod specifically so the Job needs no cluster-mutation RBAC (§5.4's boundary stays intact).
- Multi-node scheduling or cross-pod service discovery for these sidecars — single-node k3s per ARCHITECTURE.md §5.1; sidecars share the pod's network namespace, so no `Service`/DNS entry is needed.
- Non-verify-stage Jobs (context/plan/build/review) — they don't run product test suites; `verify.services` is read only when launching a verify-stage Job.
- Parallel test sharding within one Job — one Job gets one set of sidecars; fan-out, if ever needed, is a separate Job per shard, out of scope here.

## Design

### `ProductConfig` schema addition (`packages/contracts`)

`agentops.json`'s `verify` section (already holding fast/full verify commands per §5.8) gains a `services` array:

```jsonc
"verify": {
  "fast": "pnpm test:scripts",
  "full": "pnpm test:ci",
  "services": [
    {
      "name": "postgres",
      "image": "pgvector/pgvector:pg18",
      "env": { "POSTGRES_USER": "broccoli", "POSTGRES_PASSWORD": "broccoli", "POSTGRES_DB": "broccoli_test" },
      "readyCheck": { "type": "exec", "command": ["pg_isready", "-U", "broccoli", "-d", "broccoli_test"] },
      "envTemplate": { "TEST_DATABASE_URL": "postgres://broccoli:broccoli@localhost:5432/broccoli_test" }
    },
    {
      "name": "redis",
      "image": "redis:7-alpine",
      "readyCheck": { "type": "exec", "command": ["redis-cli", "ping"] },
      "envTemplate": { "REDIS_URL": "redis://localhost:6379" }
    }
  ]
}
```

Zod-validated alongside the rest of `ProductConfig`. `readyCheck` supports `exec` (command run inside the sidecar) and `tcp` (bare port-open check) — the two cover every service surveyed so far (`broccoli`'s Postgres and Redis both already define exec-style healthchecks in `docker-compose.e2e.yml`, so this is a restatement of facts the product already knows, not new knowledge it has to learn).

### `runAgent` activity changes (`packages/activities`)

When the requested stage is a verify stage:

1. Load `agentops.json` from the already-checked-out workspace (the activity already reads this file for verify commands; `services` is just more of the same file).
2. For each declared service, append a container to the Job's pod template with that `image` and `env`. Readiness is **not** enforced via k8s `livenessProbe`/`startupProbe` — it's enforced by the in-image `wait-for-services` step below, so a slow-starting sidecar never gets killed and restarted mid-Job by k8s's own probe machinery.
3. Submit the Job via the activity's own `ServiceAccount` (already scoped to create Jobs in the product's namespace per §5.7) — the Job's own `ServiceAccount` is unchanged from today's no-permissions default.
4. If any declared image (or the `agent-<backend>` image itself) is on GHCR, the Job's `imagePullSecrets` references a SOPS-encrypted GHCR credential (new secret, `agentops-platform`'s `secrets/registry/`). Public images — every service surveyed so far (`postgres`, `redis`) — need no secret.

### `wait-for-services` (baked into every `agent-<backend>` image, `images/`)

A small, generic, product-agnostic entrypoint step: before exec'ing the product's declared verify command, read the same `verify.services` block and poll each `readyCheck` against `localhost` on a short interval, up to a timeout. A product declaring no `verify.services` (or omitting the field) skips this step entirely — no sidecars, no polling, straight to the verify command, unchanged from today's behavior (starting value: 60s — a guess, not yet measured against real sidecar cold-start times on the target VPS; see Named risks). On timeout, the stage fails with a distinct sentinel (`INFRA_TIMEOUT`) rather than a generic test failure, so `Heal` can treat "infra never came up" differently from "the agent's change broke a test."

### Env var injection

Each service's `envTemplate` is merged into the verify container's environment before the verify command runs — this is how the product's existing test code (which already just reads whatever env var names it chose) gets connected, with zero code changes on the product side. Values are static (`localhost:<fixed-port>`) because, unlike local dev — where `broccoli`'s `scripts/e2e/isolation.mjs` allocates random ports so multiple worktrees can run concurrently — a single-purpose Job pod has no concurrent-instance problem to solve. The in-cluster path is simpler than the local one it's replacing, not just different.

## Testing strategy

- Unit tests (`packages/contracts`, `packages/activities`) for the schema and the service→sidecar-container mapping function — pure, no cluster needed.
- Golden-file test: a representative `agentops.json` (modeled on `broccoli`'s real `docker-compose.e2e.yml` services) → expected Job pod spec JSON, matching the golden-file convention used elsewhere in this doc tree (engine image & chart design).
- Integration: one real verify-stage Job run against the `dev-agents` namespace on the M2 dry-run cluster, confirming sidecars start, `wait-for-services` passes, and the product's actual verify command succeeds — folded into the M2 wiring end-to-end runbook, the same way `platform-components-design.md` folds its own `NetworkPolicy` validation into that runbook.

## Named risks

- **`agentops.json`'s `verify.services` and the product's own `docker-compose.e2e.yml` are two sources of truth for the same facts.** Accepted as the cost of declaring services explicitly rather than having the engine parse compose YAML (keeps the engine format-agnostic, and the product/engine contract explicit). A CI lint in the product repo diffing the two lists is a reasonable follow-up; not required for this doc's gate.
- **Sidecars-in-pod is static per Job.** Fine for one-Job-per-verify-run (today's model, one test repo per BOOTSTRAP.md's M2 gate); if parallel test sharding is ever needed, each shard needs its own Job and its own sidecar set — duplicated startup cost per shard, not a shared instance. Revisit only if sharding becomes real.
- **`wait-for-services`'s 60s timeout is unmeasured.** Needs a real number from the M2 dry-run against actual VPS hardware before being treated as more than a placeholder default.

## Package/file summary

- **Changed (`agentops-engine`):** `packages/contracts` (`ProductConfig.verify.services` schema), `packages/activities` (`runAgent`'s Job pod-spec builder), `images/agent-<backend>/*` (new `wait-for-services` entrypoint step).
- **Changed (product repos, e.g. `broccoli`):** `agentops.json` gains `verify.services` — data only, no product code changes.
- **New (`agentops-platform`):** `secrets/registry/` — SOPS-encrypted GHCR pull credential, referenced by engine-namespace Job specs.

## Open questions carried forward

- Real `wait-for-services` timeout value — needs measurement during the M2 dry-run, not decided here.
- Whether an `INFRA_TIMEOUT` sentinel routes to `Heal` differently than an ordinary test failure — a `policies/` decision, out of this doc's scope.
- No lint yet enforces `agentops.json`/`docker-compose.e2e.yml` consistency — noted as a reasonable follow-up, not required for M2.
