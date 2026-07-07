# Product-Declared Verify Environment (image + services) — Design

Status: draft · 2026-07-07 · Owner: Artem
Prerequisite for onboarding `broccoli` (first real second product) — see [project-registry-design.md](2026-07-06-project-registry-design.md) for the (already-implemented) registry/credential half of onboarding, which this doc doesn't touch.

## Context

Verify commands (`ProductConfig.fastVerifyCommands`/`fullVerifyCommands`) aren't run by engine code — they're handed to the agent CLI (claude/pi) as part of the `full_verify` prompt (`packages/prompts/templates/full_verify.md`), and the **agent's own bash tool executes them inside the same container that runs the CLI**. Every stage's Job (`context`, `assess`, `design`, `plan`, `implement`, `full_verify`, `review`) is a single container built from `images/agent-runner/Dockerfile` — `node:22-slim` plus the `claude`/`pi` CLI binaries, nothing else (`K8sJobRunner.buildAgentJob`, `packages/backends/src/k8s/k8s-job-runner.ts`).

`broccoli` (already carrying a checked-in `agentops.json`) needs Node ≥24.15, pnpm 10.33 (via corepack), a Postgres instance (pgvector extension) and Redis to run `pnpm worktree-setup`/`pnpm check:fast`/`pnpm test`. None of that exists in the current Job environment: no pnpm at all, wrong Node major version, and no way to attach service containers to a Job. This isn't a broccoli-specific gap — ARCHITECTURE.md §5.8 frames the engine as product-agnostic and `agentops.json` as where products declare what they need; a real second product exposed that this declaration surface is incomplete for anything beyond a bare `node:22` shell command.

## Goal

Let a product declare, in its own `agentops.json`, the container image and sidecar services every one of its stage Jobs runs in — with zero engine code change required per product, matching how verify commands/routing/budgets already work.

## Non-goals

- Building a product's image from a checked-in Dockerfile at task-run time. Ruled out during design: no docker daemon exists inside agent-runner pods, so this would require an in-cluster builder (kaniko/buildkit rootless) plus a build-cache strategy so a multi-minute `pnpm install` layer isn't repeated every task run, plus its own push step — a materially bigger feature than a config extension. Products publish their own pre-built image via their own CI instead (§"Broccoli onboarding" below), the same way `agentops-engine`'s own CI already builds and pushes `worker`/`agent-runner`/`gateway`.
- Per-stage scoping of `image`/`services` (e.g. sidecars only for `full_verify`). Considered and rejected: one uniform environment per product is simpler to reason about, at the accepted cost of every stage's Job paying sidecar startup latency even when that stage doesn't use them.
- Engine-injected CLI binaries via init-container + shared volume for products whose image doesn't extend `agent-runner`. Rejected in favor of a Dockerfile-`FROM` convention (§ Design) — avoids inventing new K8s machinery and avoids cross-image glibc/musl compatibility risk for a Node CLI's compiled pieces.
- Non-registry image sources, persistent storage for sidecars, per-project registries other than the existing self-hosted one.

## Design

### 1. Contract additions — `packages/contracts/src/product-config.ts`

```ts
export const VerifyServiceReadinessSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('exec'), command: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('tcpSocket'), port: z.number().int().positive() }),
]);
export type VerifyServiceReadiness = z.infer<typeof VerifyServiceReadinessSchema>;

export const VerifyServiceSchema = z.object({
  name: z.string().min(1),
  image: z.string().min(1),
  env: z.record(z.string(), z.string()).optional(),
  readiness: VerifyServiceReadinessSchema,
});
export type VerifyService = z.infer<typeof VerifyServiceSchema>;

export const ProductConfigSchema = z.object({
  image: z.string().min(1).optional(),          // new — overrides the backend's default CliSpec image
  services: z.array(VerifyServiceSchema).optional(), // new — sidecars attached to every stage's Job
  fastVerifyCommands: z.array(z.string()).optional(),
  fullVerifyCommands: z.array(z.string()).optional(),
  // ...unchanged (stages, routing, escalation, brakes)
});
```

Both fields are optional and absent by default — every currently-configured product (none yet register either field) keeps today's exact behavior: single container, `spec.image` from the CliSpec, no sidecars. `parseProductConfig`'s existing default-merge logic needs no change beyond the schema addition (neither field has a sensible non-empty default to merge in).

### 2. Threading — `AgentRunRequest`/`BackendRunRequest` (`packages/contracts/src/agent-run.ts`)

Both schemas gain `image: z.string().optional()` and `services: z.array(VerifyServiceSchema).optional()`. `packages/workflows/src/dev-cycle.ts`'s `runStageAgent` (the single call site every stage already funnels through) passes `input.config.image`/`input.config.services` on every `agentActivities.runAgent(...)` call — one change, applies uniformly to all stages per the non-goal above.

### 3. `K8sJobRunner` rendering — `packages/backends/src/k8s/k8s-job-runner.ts`

- Main container: `image: req.image ?? spec.image` (falls back to today's CliSpec-provided default).
- `k8s-types.ts`'s `V1Job` pod spec gains:
  ```ts
  initContainers?: Array<{
    name: string;
    image: string;
    restartPolicy?: 'Always';
    env?: Array<{ name: string; value: string }>;
    readinessProbe?:
      | { exec: { command: string[] } }
      | { tcpSocket: { port: number } };
  }>;
  ```
  and the existing `containers[]` entries gain the same `readinessProbe?` field (unused on the main container for now, included for type symmetry).
- `buildAgentJob` renders each `req.services` entry as an `initContainers` entry with `restartPolicy: 'Always'` — the native-sidecar marker (GA since K8s 1.29) that (a) excludes it from the Job's pod-completion accounting, so a long-running Postgres container never blocks the Job from succeeding/failing on the `agent` container's exit code alone, and (b) makes the kubelet delay starting `agent` until every sidecar's readiness probe passes — no manual "wait for postgres" polling needed inside the agent container, unlike broccoli's own GitHub Actions job which has to poll manually because Actions' `services:` doesn't gate step start on health the same way.
- No volumes/persistence for service sidecars — ephemeral per task run, matching the disposable-test-DB pattern broccoli's own `docker-compose.e2e.yml` already uses (tmpfs, `fsync=off`).
- **Blocking dependency**: confirm the `agentops-platform` k3s cluster is on ≥1.29 before implementing. If it's older, this design needs a fallback (manual wait-for-service polling shipped as part of the verify commands themselves, giving up the "Job succeeds/fails purely on the agent container" guarantee) — worth a one-line `kubectl version` check before writing code.

### 4. Connection strings are the product's problem, not a new engine concept

Sidecars share the pod's network namespace, so they're reachable at `localhost:<port>`. A product's `fullVerifyCommands` strings already fully control their own shell environment (they're arbitrary shell text handed to the agent) — no new "env passthrough" field is needed; the product just writes `DATABASE_URL=postgres://user:pass@localhost:5432/db pnpm test:ci` (or `export`s it) directly in its verify command string, mirroring what it already does for local dev via `docker-compose.yml`.

### 5. CI change — a stable tag for products to extend

`.github/workflows/ci.yaml`'s `build-images` job currently only pushes `agent-runner:${{ github.sha }}` — no floating tag exists for a product's Dockerfile to pin `FROM`. Add a second tag to the same `docker/build-push-action` step:

```yaml
tags: |
  gitactions.est1908.top/agentic-ops/agent-runner:${{ github.sha }}
  gitactions.est1908.top/agentic-ops/agent-runner:latest
```

pushed on every `main` build alongside the sha tag. The engine's own Helm-deployed workers are unaffected — they keep pinning an exact sha via `values.yaml`. Products wanting full reproducibility can pin a specific sha tag instead of `:latest`; accepted risk of `:latest` drift is noted below.

### 6. Broccoli onboarding (concrete illustration, not engine work)

`broccoli/agentops/Dockerfile` (new):
```dockerfile
FROM gitactions.est1908.top/agentic-ops/agent-runner:latest
USER root
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
USER 1000
```

`broccoli/agentops.json` (extends what's already checked in):
```json
{
  "image": "gitactions.est1908.top/broccoli/agentops:latest",
  "fastVerifyCommands": ["pnpm worktree-setup", "pnpm check:fast"],
  "fullVerifyCommands": [
    "export DATABASE_URL=postgres://broccoli:broccoli@localhost:5432/broccoli_test REDIS_URL=redis://localhost:6379 && pnpm test:ci"
  ],
  "services": [
    {
      "name": "postgres",
      "image": "pgvector/pgvector:pg18",
      "env": { "POSTGRES_USER": "broccoli", "POSTGRES_PASSWORD": "broccoli", "POSTGRES_DB": "broccoli_test" },
      "readiness": { "type": "exec", "command": ["pg_isready", "-U", "broccoli"] }
    },
    { "name": "redis", "image": "redis:7-alpine", "readiness": { "type": "exec", "command": ["redis-cli", "ping"] } }
  ]
}
```
(`routing`/`escalation`/`brakes` unchanged from broccoli's existing file.) Note the `fullVerifyCommands` fix from bare `pnpm test` to `pnpm test:ci` with connection env vars set — the existing file's `pnpm test` doesn't point at any sidecar.

`broccoli/.github/workflows/publish-images.yml` gains one more matrix entry, pushing to the *internal* registry rather than `ghcr.io` (so the cluster's existing `registry-credentials` pull secret already covers it, instead of needing a second pull secret for a second registry):
```yaml
- image: agentops
  dockerfile: agentops/Dockerfile
  registry: gitactions.est1908.top/broccoli
```
(mechanically: a second `docker/login-action` + tag-computation step targeting `gitactions.est1908.top`, reusing the `REGISTRY_USERNAME`/`REGISTRY_PASSWORD` secrets pattern `agentops-engine`'s own CI already uses.)

Registering broccoli in the project registry itself (GitHub token, `projects.broccoli` entry in `agentops-platform`) is the existing, already-implemented [project-registry-design.md](2026-07-06-project-registry-design.md) runbook — unaffected by this doc.

## Testing strategy

- `VerifyServiceSchema`/`ProductConfigSchema`: pure unit tests. Valid service array parses; missing `readiness` discriminant throws; both new fields absent → parses identically to today's config (regression-proofs backward compatibility for every product not using this).
- `buildAgentJob` (existing test file): asserts `req.image` overrides `spec.image` when present, falls back to `spec.image` when absent; asserts `req.services` renders as `initContainers` with `restartPolicy: 'Always'` and the correct `readinessProbe` shape per readiness type (`exec` vs `tcpSocket`); asserts no `services` → no `initContainers` key at all (not an empty array — keeps the rendered Job diff-clean for every product not using this).
- No new `pnpm e2e` scenario — native-sidecar readiness gating is K8s-API-server behavior, not something `TestWorkflowEnvironment`/the stub backend can exercise. The real proof is a manual verify-live run once broccoli is registered: confirm a Job pod only starts the `agent` container after postgres/redis report ready, and that a deliberately-broken readiness command (e.g. wrong `-U` user) keeps the Job pending rather than false-succeeding.

## Named risks

- **K8s version dependency**: native sidecars require ≥1.29. **Confirmed 2026-07-07** against the real cluster (`kubectl version` → `Server Version: v1.36.2+k3s1`) — well past the requirement.
- **`:latest` drift**: a product's next image build silently picks up whatever `agent-runner` shipped most recently, with no breaking-change protection. Accepted (same trust model as any `FROM node:latest`); products wanting reproducibility can pin a sha tag instead.
- **Startup latency on every stage**: the uniform (not per-stage) model means `context`/`assess`/`design`/`plan`/`review` Jobs also pay sidecar pull+start+readiness cost even though they never touch a database. Explicitly accepted for simplicity.
- **Registry mismatch**: a product image pushed to a registry other than `gitactions.est1908.top` needs its own `imagePullSecretName` wiring not covered by this design — broccoli's onboarding must target the internal registry, not repurpose its existing `ghcr.io` images.

## Package/file summary

- **Changed:** `packages/contracts/src/product-config.ts` (`image`, `services`, `VerifyServiceSchema`) + tests.
- **Changed:** `packages/contracts/src/agent-run.ts` (`image`, `services` on `AgentRunRequestSchema`/`BackendRunRequestSchema`) + tests.
- **Changed:** `packages/workflows/src/dev-cycle.ts` (`runStageAgent` passes both fields through) + tests.
- **Changed:** `packages/backends/src/k8s/k8s-job-runner.ts` (`buildAgentJob` image override + sidecar rendering) + tests.
- **Changed:** `packages/backends/src/k8s/k8s-types.ts` (`initContainers`, `readinessProbe` on `V1Job`).
- **Changed:** `.github/workflows/ci.yaml` (`agent-runner:latest` tag).
- **Changed (in `broccoli`, out of this repo):** `agentops/Dockerfile` (new), `agentops.json` (extended), `.github/workflows/publish-images.yml` (new matrix entry).

## Open questions carried forward

- ~~Exact k3s cluster version — blocking confirmation before implementation (§3).~~ Resolved 2026-07-07: `v1.36.2+k3s1`, clear to proceed.
- Whether `agent-runner:latest` should eventually become a deliberately-bumped version tag instead of a floating one, once more than one product depends on it — not required for the first product.
