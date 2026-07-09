# Linear issue trigger — Design

Status: implemented (first cut) · 2026-07-09 · Owner: Artem
Depends on [gateway-design.md](2026-07-06-gateway-design.md), which named "non-GitHub trackers (Linear/Gitea webhooks)" an explicit non-goal, matching every other GitHub-only decision in the stack so far.

## Context

ARCHITECTURE.md §5.3/§4 has always described the Gateway as tracker-agnostic ("Normalizes all trackers into one `TaskEvent` shape via `TrackerPort` — GitHub, Linear, and Gitea are config, not code paths"), and `trackerType` in the project registry has been a `z.literal('github')` placeholder since M3 for exactly this reason. This pass fills in the Linear half: labeling a Linear issue with a configured trigger label starts `devCycle`, the same way labeling a GitHub issue already does.

## Goal

An operator registers a project with `trackerType: 'linear'`. Adding the configured trigger label to a Linear issue in that project's team starts `devCycle` with no human running a CLI command. The resulting task can read the issue body, and post the PR link back as a Linear comment, the same way the GitHub path does today.

## Non-goals

- **Gitea** — still unbuilt, unrelated to this pass.
- **DB-managed Linear projects.** `resolveManagedProjectEntry`'s Postgres-backed registry (`docs/superpowers/specs/2026-07-08-managed-project-registry-design.md`) hardcodes `trackerType: 'github'` and is untouched here. Linear projects are static-registry-only (`PROJECT_REGISTRY_JSON`) until a real reason to extend the managed-project schema to a second tracker (and a second encrypted-credential column) shows up.
- **Full `TaskEvent` unification.** The GitHub path (`parseIssueLabeledEvent` / `startDevCycleForIssue`) is left exactly as-is — a new, parallel `parseLinearIssueEvent` / `startDevCycleForLinearIssue` pair is added rather than refactoring both trackers onto one shared type. Collapsing them is future work once a third tracker makes the duplication actually hurt (same "small, deliberate duplication, named, not urgent" call the original gateway design made for `loadTaskConfig`).
- **Public exposure of `/webhooks/linear`.** Same unresolved DNS/TLS question the GitHub route already has, not reopened here.
- **Workspace-level `issueAddLabel` calls from the workflow.** `TrackerPort.label()` is implemented for interface completeness (and unit-tested) but `devCycle` doesn't call it today for either tracker — confirmed by reading `dev-cycle.ts`, which only calls `getIssue` and `commentOnIssue`.

## Design

### Two problems Linear support actually has to solve

1. **Label events carry label *IDs*, not names.** GitHub's webhook payload puts the label name directly on `payload.label.name`. Linear's `Issue` webhook payload only has `data.labelIds` (an array of label UUIDs) plus `updatedFrom.labelIds` (the previous array, present on `update` actions) — confirmed against Linear's webhook docs. There's no label name in the payload at all.
2. **Tracker refs no longer self-describe a routing key the existing dispatcher understands.** `createProjectScopedPorts` (packages/ports/src/github/project-scoped-ports.ts) currently routes every `TrackerPort` call by parsing `owner/repo` out of the ref string itself (`repoFromRef` → `parseRef`). A Linear issue identifier (`ENG-123`) doesn't encode a GitHub repo — the project it belongs to is only recoverable from its *team key* (`ENG`), which has nothing to do with the GitHub repo the resulting PR lands in.

### Registry (`packages/contracts/src/project-registry.ts`)

`ProjectRegistryEntrySchema` becomes a `z.discriminatedUnion('trackerType', [...])`:

- `github` variant: unchanged (`project`, `repo`, `tokenEnvVar`).
- `linear` variant: `project`, `repo` (still the GitHub repo the PR lands in — SCM stays GitHub-only regardless of tracker), `tokenEnvVar` (still the GitHub token, for SCM + `agentops.json` loading), plus:
  - `linearTeamKey` — e.g. `"ENG"`, the prefix of every issue identifier in that Linear team. This is the routing key both the gateway (webhook → project) and the worker (`TrackerPort` call → project) use.
  - `linearTokenEnvVar` — env var holding the Linear API key used for `getIssue`/`comment`/`label`.
  - `linearTriggerLabelId` — the Linear label **UUID** (not name) that starts a task. Configured directly as an ID, not resolved from a name at runtime: Linear labels can be team- or workspace-scoped and the webhook payload never carries the name, so resolving a configured name to an ID would need an extra Linear API call either at gateway boot (a new startup dependency + failure mode for a service that's otherwise dependency-free-at-boot) or per delivery (added latency + a second thing that can fail on every webhook). An operator finds the label's ID once via Linear's GraphQL API or the label settings URL — a one-time manual step, the same shape as configuring a webhook secret.

`parseProjectRegistry` gains a duplicate check on `linearTeamKey` (only meaningful across `linear` entries), alongside the existing duplicate `project`/`repo`/`tokenEnvVar` checks.

`ResolvedProjectEntry` (still not zod-validated, constructed programmatically) grows an optional `linearToken` populated the same way `token` is — `loadProjectRegistry` (packages/activities) reads `env[entry.linearTokenEnvVar]` for `linear` entries the same way it already reads `env[entry.tokenEnvVar]`.

### Ports (`packages/ports/src/`)

- **`tracker-ref.ts`** (new): `parseTrackerRef(ref)` → `{ kind: 'github', repo }` or `{ kind: 'linear', teamKey, identifier }`. A ref is Linear-shaped iff it starts with the literal prefix `linear:` (e.g. `linear:ENG-123`); everything else falls through to the existing GitHub `parseRef` (`owner/repo#N`). No ambiguity: GitHub refs always contain `/` and `#`; Linear identifiers never contain either. `teamKey` is derived from the identifier's prefix (`ENG-123` → `ENG`) — Linear team keys are always plain uppercase alphanumeric with no hyphen, so splitting on the first `-` is safe.
- **`github/project-scoped-ports.ts`**: generalized to dispatch on `parseTrackerRef(ref)` instead of always assuming a GitHub-shaped ref. `ProjectScopedPortsEntry` gains an optional `linearTeamKey`; the entry map now has two lookup tables (`byRepo`, `byLinearTeamKey`) and `resolve(ref)` picks the right one based on the parsed kind. (File keeps its current name/location — it's not GitHub-specific in behavior, and a rename is unrelated churn for this change.)
- **`linear/linear-client.ts`** (new): thin `fetch`-based wrapper over Linear's GraphQL API (`https://api.linear.app/graphql`, `Authorization: <key>` header, no `Bearer` prefix — Linear's own convention). Narrow surface: `issue(identifier)`, `createComment(issueId, body)`, `issueLabelByName(teamKey, name)`, `addLabel(issueId, labelId)` — mirrors `GithubClient`'s role as the narrow facade the tracker port depends on, not a general Linear SDK.
- **`linear/linear-tracker-port.ts`** (new): implements `TrackerPort`.
  - `getIssue(ref)`: parses the identifier out of `ref` (strips a leading `linear:` if present), queries Linear for title/description/labels — returned as `{ ref, title, body, labels }` (label *names*, since the GraphQL query can request `labels { nodes { name } }` directly; this is unrelated to the webhook payload's UUID-only limitation, which only affects event *detection*, not this direct API read).
  - `comment(ref, body)`: `createComment` mutation.
  - `label(ref, label)`: Linear's `issueAddLabel` mutation needs a label ID, not a name, so this does one `issueLabelByName` lookup first. Not on `devCycle`'s hot path today (see Non-goals), but implemented correctly rather than stubbed, since it's part of the `TrackerPort` contract every other implementation honors.

### Gateway (`packages/gateway/src/`)

The gateway itself never talks to Linear's API — it only needs to (a) recognize a labeled-issue webhook and (b) start `devCycle`, using the *same* GitHub `ScmPort` it already builds for `agentops.json` loading (config lives in the git repo regardless of which tracker filed the task).

- **`verify-linear-signature.ts`** (new): `Linear-Signature` header, raw hex HMAC-SHA256 over the raw body (no `sha256=` prefix, unlike GitHub) — `crypto.timingSafeEqual` after an equal-length check, same pattern as `verify-signature.ts`. Also rejects payloads whose `webhookTimestamp` is more than 5 minutes old, a defense-in-depth replay check Linear's own docs recommend (looser than the 60s some integrations use, to tolerate redelivery/clock skew without adding a second failure mode for a check that's secondary to the HMAC itself).
- **`parse-linear-issue-event.ts`** (new): accepts `type: 'Issue'` payloads only. Detects "labeled with the trigger label" as: current `data.labelIds` includes the configured `linearTriggerLabelId`, **and** (action is `create`, or `updatedFrom.labelIds` doesn't already include it) — covers both "label added via update" and "issue created already carrying the label." Returns `{ teamKey, identifier, title } | null`; `teamKey` comes straight from `data.identifier`'s prefix (no dependency on a `team` object being present in the payload).
- **`resolve-linear-project.ts`** (new): `findLinearProjectEntry(registry, teamKey)` — static-registry-only lookup (see Non-goals), returns the matching `linear`-typed `ResolvedProjectEntry` or `null`.
- **`start-dev-cycle-for-linear-issue.ts`** (new, parallel to `start-dev-cycle.ts` per the Non-goals call): deterministic workflow id `linear-<project>-<identifier>` (distinct prefix from the GitHub path's `issue-<project>-<number>`, so the two can never collide even if a project were ever double-registered under both trackers). `issueRef` passed into `devCycle` is `linear:<identifier>`, matching `parseTrackerRef`'s expected shape.
- **`create-gateway-server.ts`**: new route `POST /webhooks/linear`, gated on `deps.linearWebhookSecret` being configured — if unset, the route responds 404, so a deployment with no Linear projects registered doesn't need a new required secret (backward compatible with every existing `agentops-platform` gateway deployment). Otherwise: verify signature → parse event → `findLinearProjectEntry` (202 + log if no match, same as the GitHub path's unregistered-repo handling) → build the GitHub `ScmPort` via the existing `deps.buildScm(entry)` → load `agentops.json` → `startDevCycleForLinearIssue`.
- **`main.ts`**: reads `LINEAR_WEBHOOK_SECRET` (optional — `undefined` disables the route, per above).

### Worker (`packages/worker/src/main.ts`)

`buildActivityDependencies` now branches per registry entry on `trackerType`: `github` entries build `{ scm, tracker }` from `createGithubPorts` exactly as before; `linear` entries build the GitHub `scm` the same way (still needed for the repo's PR/push/file-read operations) but `tracker` from a new `createLinearPorts(entry.linearToken)`-style helper wrapping `LinearTrackerPort`. Every entry now also carries `linearTeamKey` into `createProjectScopedPorts`, which — per the ports change above — uses it to route Linear-shaped refs.

### Chart (`charts/engine`)

`values.yaml`'s per-project `projects` map gains three optional keys for Linear-tracked projects: `trackerType` (default `github` when absent, keeping every existing values file valid unchanged), `linearTeamKey`, `linearTriggerLabelId`, `linearTokenSecretName`. `_helpers.tpl`'s `engine.projectRegistryJson` emits the linear-specific fields (and a `LINEAR_TOKEN__<PROJECT>` env var name) only for entries with `trackerType: linear`. Both `templates/deployment.yaml` (worker) and `templates/gateway-deployment.yaml` gain a second per-project range block rendering `LINEAR_TOKEN__<PROJECT>` from `linearTokenSecretName`, alongside the existing `GITHUB_TOKEN__<PROJECT>` block (every project still needs a GitHub token for SCM regardless of tracker). `gateway-deployment.yaml` gains a conditional `LINEAR_WEBHOOK_SECRET` env var, rendered only when `.Values.gateway.linearWebhookSecretName` is set — unset by default, matching the "chart ships no cluster assumption" convention used for `piRateLimitFallbackModel`/`platformAgentSecretName` elsewhere in this same file.

Real secrets, the actual Linear org's webhook registration, and DNS/ingress exposure of `/webhooks/linear` are `agentops-platform` work, out of this repo — same split the original gateway design used.

## Testing strategy

Every new piece is pure or DI-injectable and unit-tested with fakes, matching the existing gateway/ports testing convention: `parseTrackerRef`, `verifyLinearSignature`, `parseLinearIssueEvent`, `findLinearProjectEntry`, `startDevCycleForLinearIssue` (fake Temporal client), `LinearTrackerPort` (fake `LinearClient`), and `createProjectScopedPorts`'s generalized routing (both GitHub- and Linear-shaped refs, plus the unregistered-key error case). `create-gateway-server.test.ts` gains a Linear-path suite mirroring its GitHub one: signature rejection, wrong-label/wrong-action ignoring, unregistered-team handling, the route-disabled-when-secret-unset case, and the full happy path.

## Named risks

- **`linearTriggerLabelId` is a UUID an operator has to go find**, not a friendly name like `TRIGGER_LABEL`. Named and accepted above — the alternative (name→ID resolution) trades this one-time friction for an ongoing runtime dependency and failure mode. Worth revisiting if label IDs turn out to rotate or if multiple Linear workspaces are onboarded often enough for this to become real toil.
- **Two near-duplicate event/start-workflow code paths** (GitHub's and Linear's). Named as a non-goal above, not an oversight.
- **No pagination or size limit on the Linear webhook body read**, same accepted-for-now risk the GitHub route already carries.

## Open questions carried forward

- Same public-exposure question as the GitHub route (`gateway-design.md`'s "Open questions") — a second webhook path reachable from the internet doesn't change that decision, just adds one more route behind whatever answer it gets.
- Whether DB-managed Linear projects are ever needed (see Non-goals) — no signal yet that they are.

## Package/file summary

- **New:** `packages/ports/src/tracker-ref.ts` (+ test), `packages/ports/src/linear/{linear-client,linear-tracker-port}.ts` (+ tests).
- **New:** `packages/gateway/src/{verify-linear-signature,parse-linear-issue-event,resolve-linear-project,start-dev-cycle-for-linear-issue}.ts` (+ tests).
- **Changed:** `packages/contracts/src/project-registry.ts` (+ test) — discriminated union, `linearTeamKey` duplicate check.
- **Changed:** `packages/activities/src/load-project-registry.ts` (+ test) — resolve `linearToken`.
- **Changed:** `packages/ports/src/github/project-scoped-ports.ts` (+ test), `packages/ports/src/index.ts` — generalized ref routing, new exports.
- **Changed:** `packages/gateway/src/{create-gateway-server,main}.ts` (+ tests), `packages/gateway/README.md`.
- **Changed:** `packages/worker/src/main.ts` (+ test).
- **Changed:** `charts/engine/values.yaml`, `charts/engine/templates/_helpers.tpl`, `charts/engine/templates/{deployment,gateway-deployment}.yaml`.
- **Changed (in `agentops-platform`, out of this repo):** real `LINEAR_WEBHOOK_SECRET`, per-project Linear API key secrets, Linear workspace webhook registration, and eventually the same Ingress/cert-issuer/DNS decision the GitHub route is already waiting on.
