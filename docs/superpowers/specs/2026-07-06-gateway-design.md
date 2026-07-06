# Gateway — Design

Status: implemented (first cut) · 2026-07-06 · Owner: Artem
Milestone: M3. Depends on [project-registry-design.md](2026-07-06-project-registry-design.md) — gateway resolves product/repo from the same registry the worker consumes.

## Context

`packages/gateway` was a placeholder since M0 ("built in M3", per its README). M3's stated gate is "label an issue, do nothing else — the PR reaches merge-ready" — today that step is a human running `engine start --issue N` from a laptop with the repo cloned. This doc covers replacing that manual step with a real webhook receiver.

## Goal

Labeling a GitHub issue with a configured trigger label starts `devCycle` automatically, with no human running a CLI command.

## Non-goals

- **PR/CI event webhooks** (the other half of ARCHITECTURE.md §5.3's Gateway description — "forge PR events → signal the owning workflow"). `pr_babysit`'s durable-timer poll against `getPrFeedback` already works today without any webhook (built in M0, exercised by the e2e suite) — ARCHITECTURE.md itself frames the event-push version as replacing polling for responsiveness, with polling as an accepted fallback, not as something M3's gate requires. Skipped here; a real future improvement, not a gap in this pass.
- **Public internet exposure** (real DNS + a real, publicly-trusted TLS certificate). This is a genuine, unresolved decision spanning `agentops-platform` — see "Open questions."
- **Non-GitHub trackers** (Linear/Gitea webhooks) — matches every other GitHub-only decision in this stack so far.
- **GlitchTip/Alertmanager → `ProdErrorTriage`** — a different trigger type named in ARCHITECTURE.md §5.3, unrelated to the issue-labeled path; M6 territory.

## Design

### Framework: none

Two routes, JSON parsing, and HMAC verification is little enough code that a framework dependency isn't justified — `node:http` directly, matching ARCHITECTURE.md §5.3's "~200 lines" sizing for the whole service.

### Signature verification (`verify-signature.ts`)

GitHub signs webhook deliveries with `X-Hub-Signature-256: sha256=<hmac-sha256-hex>` over the **raw request body** — verification must happen before `JSON.parse`, against the exact bytes received, or a re-serialized payload won't reproduce the same signature. Compared with `crypto.timingSafeEqual` (after confirming equal length, which `timingSafeEqual` itself requires) to avoid leaking the correct signature one byte at a time via response-time differences.

### Event filtering (`parse-issue-labeled.ts`)

A repo's webhook can be subscribed to far more event types than this gateway acts on. Only `X-GitHub-Event: issues` with `payload.action === 'labeled'` and `payload.label.name === TRIGGER_LABEL` (env var, default `agentops`) produces an event; everything else returns `null` and the handler acknowledges (204) without acting — not an error, since GitHub will retry on non-2xx and there's nothing wrong with a webhook delivery for an event this gateway simply doesn't care about.

### Config loading (`load-task-config.ts`)

`TaskInput.config` must be populated before `devCycle` starts (config loading is a client-side step today, not a workflow activity — see [agentops-config-loading-design.md](2026-07-03-agentops-config-loading-design.md)), which means gateway needs the **same `agentops.json`-fetch capability the CLI's `cmdStart` already has**: a `GithubScmPort` built from the resolved project's real token. This is why gateway needs the full `ResolvedProjectEntry` (with token) from the registry, not just the repo→product mapping — it isn't only "who owns this repo," it's "read a file from this repo before the workflow starts."

`loadTaskConfig(scm: ScmPort, repo: string)` takes an **already-constructed** `ScmPort` rather than building one from a token internally — same lesson as [project-registry-design.md](2026-07-06-project-registry-design.md)'s `createProjectScopedPorts`: a function that calls `createGithubPorts(token, git)` itself can only be tested against a live GitHub client. Injecting `ScmPort` makes this trivially testable with `MemoryScmPort`. This is a small, deliberate duplication of `packages/cli/src/load-product-config.ts`'s `loadProductConfig` — no shared package was a natural home for it without touching `packages/cli/src/main.ts`, which was mid-edit by concurrent work when this was built. Worth unifying later, not urgent.

### Idempotent start (`start-dev-cycle.ts`)

Workflow id is deterministic: `issue-<owner>-<repo>-<issueNumber>` (slashes replaced). This does double duty:

- **Dedupe while running**: GitHub can redeliver a webhook, and a human can remove-then-re-add the same label. Starting a workflow with an id that's still open throws `WorkflowExecutionAlreadyStartedError`, caught and treated as `{ started: false }` — a deliberate no-op, not an error surfaced to GitHub as a failed delivery.
- **Allow re-trigger after completion**: Temporal's default `workflowIdReusePolicy` permits starting a *new* run under the same id once the previous one has closed (done/failed) — so re-labeling an issue after its first task finished correctly starts a fresh attempt, with no extra logic needed here.

### Registry lookup

Gateway loads the same `PROJECT_REGISTRY_JSON` (+ per-project `GITHUB_TOKEN__<PRODUCT>`) the worker does, via the same `loadProjectRegistry()` from `packages/activities`. A repo with no matching registry entry is acknowledged (202) and logged, not started — matches the registry's role as validation, not just credential storage.

### Chart

`charts/engine` gained a second Deployment + ClusterIP Service (`templates/gateway-deployment.yaml`/`gateway-service.yaml`) alongside the existing worker Deployment, sharing the chart's existing `PROJECT_REGISTRY_JSON` computation via a new `_helpers.tpl` named template (`engine.projectRegistryJson`) rather than duplicating the `range`/`toJson` logic in two files. A new `images/gateway/Dockerfile` (plain `node:22-slim` + pnpm, no CLI installs — mirrors `images/worker/Dockerfile`) and a third CI build-push step alongside `worker`/`agent-runner`.

## Testing strategy

Every non-HTTP piece (`verifyGithubSignature`, `parseIssueLabeledEvent`, `loadTaskConfig`, `startDevCycleForIssue`) is a pure or DI-injectable function, unit-tested with fakes — no real GitHub, no real Temporal server. `createGatewayServer` is tested with real `fetch()` requests against a real (ephemeral-port) `http.Server`, with `client`/`registry`/`buildScm` injected as fakes — covers signature rejection, wrong-label/wrong-action ignoring, unregistered-repo handling, and the full happy path asserting `client.workflow.start`'s exact arguments.

## Named risks

- **Public exposure is unbuilt.** GitHub needs to reach this service over the internet; the chart's Service is ClusterIP-only. Nothing here decides how that happens — named explicitly in "Open questions," not silently assumed.
- **`loadTaskConfig` duplicates `packages/cli`'s `loadProductConfig`.** Small, deliberate, and named — not a design gap, but worth collapsing into one shared implementation once a natural home exists (see "Config loading" above).
- **No pagination or size limit on the webhook body read.** `readRawBody` buffers the entire request in memory before verifying anything — fine for GitHub's payload sizes (issue events are small JSON), would need a body-size cap if this service's threat model ever needs to withstand a hostile sender before signature verification (relevant once it's publicly reachable — see the exposure risk above).

## Open questions carried forward

- **How does this become reachable from GitHub's public webhook delivery?** Every other externally-visible hostname in this stack (`temporal.lab`) is internal-only, step-ca-trusted — nothing on the public internet trusts that CA. Real options: (a) a public DNS name + `cert-manager` `ClusterIssuer` using Let's Encrypt (a second, public-facing issuer alongside step-ca's internal one) + router/firewall exposure on whichever host runs k3s; (b) a tunnel/relay (e.g. a webhook proxy) that avoids opening inbound ports on the host at all, at the cost of depending on a third-party relay. Not decided here — needs its own pass once the "how much am I willing to expose this host" question is answered.
- **Per-project webhook secrets.** This design assumes one shared `GITHUB_WEBHOOK_SECRET` configured identically on every registered repo's webhook. Splitting to one secret per project (mirroring the per-project GitHub token) is straightforward if ever needed, not built now (YAGNI until a real reason shows up).
- **Unifying `loadTaskConfig` with `packages/cli`'s `loadProductConfig`** — named as a risk above.

## Package/file summary

- **New:** `packages/gateway/{package.json,tsconfig.json,README.md}`, `src/{verify-signature,parse-issue-labeled,load-task-config,start-dev-cycle,create-gateway-server,main}.ts` (+ `.test.ts` for all but `main.ts`).
- **New:** `images/gateway/Dockerfile`.
- **New:** `charts/engine/templates/{gateway-deployment.yaml,gateway-service.yaml,_helpers.tpl}`.
- **Changed:** `charts/engine/values.yaml` (`image.gatewayTag`, `gateway.*`), `templates/deployment.yaml` (registry JSON now via the shared helper).
- **Changed:** `.github/workflows/ci.yaml` (third image build/push), `scripts/bump-platform-engine-tags.sh` (`gatewayTag` bump).
- **Changed (in `agentops-platform`, out of this repo):** `clusters/ops/engine/values.yaml` needs a real `gatewayTag`, a `gateway-webhook-secret` K8s Secret, and — once the public-exposure question above is resolved — an Ingress + cert-issuer + DNS record.
