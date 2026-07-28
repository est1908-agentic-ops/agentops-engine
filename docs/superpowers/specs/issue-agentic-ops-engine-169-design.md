# Linear tracker integration is unreachable end-to-end — Design

Task: issue-agentic-ops-engine-169 · 2026-07-28 · Unattended run (no human in the loop)

Builds on and reconciles two prior specs whose decisions currently conflict in the tree:
[2026-07-09-linear-trigger-design.md](2026-07-09-linear-trigger-design.md) (added Linear support) and
[../plans/2026-07-25-engine-projects-configmap-resolver.md](../plans/2026-07-25-engine-projects-configmap-resolver.md)
(migrated the registry from Postgres to a mounted ConfigMap and "retired the Linear resolution path… If Linear
returns, re-add it against the ConfigMap the same way").

## Goal

Labeling a Linear issue with a project's configured trigger label should start `devCycle`, exactly the way
labeling a GitHub issue already does. Today it cannot: the Linear feature is almost entirely built and
unit-tested, but the **two ends of the pipeline are severed**, so a Linear webhook can never reach `devCycle`
and no Linear-tracked project can ever be resolved. This change reconnects those ends against the current
ConfigMap-backed registry, restoring end-to-end reachability *within the engine*.

## What is actually broken (root cause)

The middle and consumer half of the Linear path is intact and tested:

- `packages/ports/src/tracker-ref.ts` — `parseTrackerRef` / `linearRef` route `linear:ENG-123` refs. ✅
- `packages/ports/src/github/project-scoped-ports.ts` — routes Linear-shaped refs via a `byLinearTeamKey` map. ✅
- `packages/ports/src/linear/{linear-client,linear-tracker-port,build-linear-ports}.ts` — the Linear `TrackerPort`. ✅
- `packages/worker/src/main.ts` — `buildActivityDependencies` **actively branches** on `trackerType === 'linear'`,
  builds `createLinearTracker(entry.linearToken)`, and threads `linearTeamKey` into `createProjectScopedPorts`. ✅
- `packages/gateway/src/{parse-linear-issue-event,verify-linear-signature,start-dev-cycle-for-linear-issue}.ts` — the
  webhook parser, signature/replay verifier, and workflow starter. ✅ (built + tested, imported by nothing).
- `packages/contracts` — `ResolvedProjectEntry` and `ManagedProjectSchema` both carry a `linear` variant. ✅

But nothing can produce a Linear event or a Linear-typed `ResolvedProjectEntry`, because the July-25 ConfigMap
migration stripped Linear from the ingestion and resolution layers and never re-added it:

1. **No gateway entrypoint.** `packages/gateway/src/create-gateway-server.ts` routes only `POST /webhooks/github`.
   There is no `POST /webhooks/linear`, so the built parser/verifier/starter are dead code.
2. **No webhook secret.** `packages/gateway/src/main.ts` never reads `LINEAR_WEBHOOK_SECRET`, so even a route would
   have no secret to verify against.
3. **Resolver hardcodes GitHub.** `packages/activities/src/resolve-managed-projects.ts` `resolveOne` always returns
   `trackerType: 'github'` and drops every Linear field; `resolveManagedProjectEntryByLinearTeamKey` (named in the
   July-09 spec's addendum) does not exist.
4. **Store lookup absent.** `ManagedProjectStore` (contracts) deliberately omits `getByLinearTeamKey`, and
   `FileManagedProjectStore` hardcodes `trackerType: 'github'` and never parses Linear fields from `project.yaml`.

So the worker is fully prepared to *service* a Linear-tracked project it will never be handed. That incoherence —
a complete, tested feature with both ends cut — is the bug.

## Approaches considered

### A. Reconnect the two severed ends against the ConfigMap store (recommended)

Re-add the gateway `/webhooks/linear` route + `LINEAR_WEBHOOK_SECRET`, teach `FileManagedProjectStore` to parse
Linear `project.yaml` entries and expose `getByLinearTeamKey`, and branch `resolveOne` on `trackerType` (plus a new
`resolveManagedProjectEntryByLinearTeamKey`). Additive, ~5 source files + tests; leaves every intact downstream
piece (ports, worker, contracts) untouched.

- **Trade-off:** introduces one new additive contract field (`linearTokenSecret`) and re-opens a route that no
  homelab project uses *yet*. Full cluster reachability still needs out-of-repo work (a real webhook secret, a
  per-project Linear API-key Secret, Linear-org webhook registration, `/webhooks/linear` DNS/TLS) — exactly the
  agentops-platform/engine split both prior specs already drew.
- **Cost:** low–moderate. No churn to the tested middle/consumer layers.

### B. Finish the retirement — delete the unreachable Linear code

Treat the July-25 "Linear retired, not preserved" decision as final and delete the orphaned leaves: the three
gateway Linear modules, all of `ports/src/linear/*`, the `tracker-ref` Linear branch + `linearRef`, the
`project-scoped-ports` Linear routing, the worker's `trackerType === 'linear'` branch, and the `linear` variants of
both discriminated unions in contracts.

- **Trade-off:** destroys a large body of correct, tested work and directly contradicts the July-25 plan's own
  explicit "If Linear returns, re-add it against the ConfigMap the same way." It also has a *larger* blast radius
  than A — ripping a variant out of two `z.discriminatedUnion`s ripples into managed-project/control/CLI tests.
- **Cost:** moderate–high, and irreversible without redoing the deleted work.

### C. Add only the gateway route, leave resolution stubbed

Add `POST /webhooks/linear` but keep resolving via `resolveManagedProjectEntry` (repo-keyed), i.e. don't add the
team-key lookup or the store/resolver Linear branches.

- **Trade-off:** doesn't actually work — a Linear webhook carries a team key (`ENG`), not a GitHub repo, so
  repo-keyed resolution can never match it. This "fixes" the visible symptom (a 404 route) while leaving the path
  just as unreachable, and would ship a route that always 202-ignores. Rejected as a non-fix.

## Chosen approach: A

The decisive reason is the July-25 plan's own instruction: it did not declare Linear permanently dead — it said
*"The Linear resolution path is retired here… If Linear returns, re-add it against the ConfigMap the same way."*
A bughunt titled "unreachable end-to-end despite being fully built" **is** Linear returning, and A is literally the
prescribed re-addition. B contradicts that instruction and throws away tested code that the worker still actively
consumes; coherence under B would force deleting the worker/ports/contracts Linear support too — a far bigger,
irreversible change than reconnecting two ends. C is a non-fix (repo-keyed resolution structurally cannot match a
team-key webhook). A is additive, small, preserves all existing tests, and restores the exact data flow the
July-09 spec designed, only re-pointed at the ConfigMap store instead of the deleted Postgres registry.

## Assumptions

Resolved without asking, per the unattended-run instruction:

- **A1 — Reconnect, don't delete.** The intended fix is to make the built feature reachable, per the July-25 plan's
  "re-add it against the ConfigMap the same way," not to delete it. Recorded as the central decision above.
- **A2 — "End-to-end" is scoped to the engine repo.** Reachability delivered here is: route → verify → parse →
  resolve (by team key) → start `devCycle` → worker builds Linear ports and services the run. The live webhook
  secret, the per-project Linear API-key K8s Secret, the Linear-org webhook registration, and `/webhooks/linear`
  DNS/TLS exposure remain agentops-platform's responsibility — the identical split both prior specs drew. The
  engine change is verified with unit/integration tests using fakes, not a live Linear delivery.
- **A3 — Linear API token is resolved per-project like the GitHub token.** The `linear` `project.yaml`/`ManagedProject`
  variant gains a `linearTokenSecret` naming a K8s Secret whose value `KubeTokenResolver` reads (RBAC `secrets:get`
  in `dev-agents` already exists for the GitHub token). This is the additive field the current `linear` contract
  variant lacks (it has `linearTeamKey`/`linearTriggerLabelId`/`linearCredentialSet` but no secret name).
- **A4 — Route stays secret-gated (backward compatible).** `LINEAR_WEBHOOK_SECRET` unset ⇒ `/webhooks/linear`
  returns 404, so every existing gateway deployment with no Linear projects needs no new required secret — the same
  gating the July-09 spec specified.
- **A5 — Replay-freshness uses wall-clock time.** `isFreshLinearWebhook(event.webhookTimestamp, Date.now())` runs in
  the gateway, a plain Node HTTP server where `Date.now()` is allowed (the determinism boundary only binds
  `packages/workflows`).

## Design

One coherent change: *restore end-to-end reachability of the Linear tracker against the ConfigMap-backed registry.*
Every edit below serves that single feature; nothing unrelated is bundled.

### Data flow (target)

```
Linear webhook  →  POST /webhooks/linear (gateway)
  → verifyLinearSignature(raw, Linear-Signature, LINEAR_WEBHOOK_SECRET)         [401 on mismatch]
  → parseLinearIssueEvent(JSON)                                                 [204 if not an Issue create/update]
  → isFreshLinearWebhook(event.webhookTimestamp, Date.now())                    [202 ignore if stale]
  → resolveManagedProjectEntryByLinearTeamKey(managedProjectDeps, event.teamKey)[202 + log if unregistered]
  → matchesLinearTriggerLabel(event, entry.linearTriggerLabelId)               [204 if not the trigger label]
  → scm = buildScm(entry); config = resolveProjectConfig(deps, scm, entry.repo)
  → startDevCycleForLinearIssue(client, taskQueue, entry.project, event, entry.repo, config)   [202]
                                              ↓
worker buildActivityDependencies: entry.trackerType === 'linear'
  → createLinearTracker(entry.linearToken) + createProjectScopedPorts(byLinearTeamKey)   (already built)
```

### Components / files affected

**Contracts**
- `packages/contracts/src/managed-project.ts` — add `linearTokenSecret: z.string().optional()` to the `linear`
  variant (K8s Secret name for the Linear API key), mirroring the existing optional `tokenSecret` for GitHub.
- `packages/contracts/src/managed-project-store.ts` — add `getByLinearTeamKey(teamKey: string): Promise<ManagedProject | null>`
  to the `ManagedProjectStore` interface and replace the "intentionally omitted" comment with a note that Linear
  resolution is back, resolved by team key against the ConfigMap store.

**Activities**
- `packages/activities/src/file-managed-project-store.ts` — extend `RawManagedProjectFile` with
  `trackerType`/`linearTeamKey`/`linearTriggerLabelId`/`linearTokenSecret`; when `trackerType === 'linear'`,
  validate those fields and build the `linear` `ManagedProject` variant (`credentialSet`/`linearCredentialSet`
  both `true`). Build a second `byLinearTeamKey` map alongside `byRepo` during `readAll()` (Linear entries stay in
  `byRepo` too, so config lookup by repo keeps working), and implement `getByLinearTeamKey`. `trackerType` absent ⇒
  `github` (every existing `project.yaml` stays valid unchanged).
- `packages/activities/src/resolve-managed-projects.ts` — branch `resolveOne` on `managedProject.trackerType`: for
  `linear`, resolve both `tokenSecret` (GitHub) and `linearTokenSecret` (Linear) via `deps.resolveToken`, returning
  the `linear` `ResolvedProjectEntry` (`token`, `linearToken`, `linearTeamKey`, `linearTriggerLabelId`). Add
  `resolveManagedProjectEntryByLinearTeamKey(deps, teamKey)` calling `store.getByLinearTeamKey` then the shared
  resolve step. `deps` remains the existing `{ store, resolveToken }` shape — `resolveToken` already accepts any
  Secret name, so no deps change is needed.

**Gateway**
- `packages/gateway/src/create-gateway-server.ts` — `GatewayDeps` gains `linearWebhookSecret?: string`; when set,
  `handleRequest` routes `POST /webhooks/linear` to a new `handleLinearWebhook` implementing the data flow above;
  when unset, the path falls through to the existing 404. Reuses `deps.buildScm` and `resolveProjectConfig` exactly
  as the GitHub path does. Status-code conventions mirror the GitHub handler (202 started / 204 no-op-or-duplicate /
  401 bad signature / 202 unregistered-team).
- `packages/gateway/src/main.ts` — read `process.env.LINEAR_WEBHOOK_SECRET` (optional) and pass it as
  `linearWebhookSecret`. No other wiring changes (`buildScm`, `managedProjectDeps` already flow to both routes).

**Chart** (`charts/engine`)
- `templates/gateway-deployment.yaml` — conditional `LINEAR_WEBHOOK_SECRET` env from a new
  `gateway.linearWebhookSecretName` value, rendered only when set (same optional-secret convention as
  `platformAgentSecretName`); `values.yaml` documents it as unset by default. The `managed-projects` ConfigMap is
  already mounted; a `linear` `project.yaml` simply carries the extra keys, and its `linearTokenSecret` names a K8s
  Secret the existing `KubeTokenResolver` reads. No new required knob for GitHub-only deployments.

**Tests**
- `create-gateway-server.test.ts` — a Linear suite mirroring the GitHub one: route-disabled-when-secret-unset (404),
  bad signature (401), non-Issue / wrong-action ignored (204), stale-timestamp ignored, unregistered team (202),
  label-not-the-trigger (204), and the full happy path (202 → `startDevCycleForLinearIssue` called with the resolved
  project/repo/config).
- `file-managed-project-store.test.ts` — a `linear` fixture asserting the `linear` variant, `getByLinearTeamKey`,
  and that the entry is still reachable by repo.
- `resolve-managed-projects.test.ts` — Linear resolution populates both tokens and Linear fields;
  `resolveManagedProjectEntryByLinearTeamKey` returns the entry / `null` on miss.

### Error handling

- Bad/missing signature → 401 before any parse (raw-bytes HMAC, constant-time), matching the GitHub route.
- Malformed JSON → 400; non-Issue or non-create/update payload → 204 (acknowledge, do nothing).
- Stale `webhookTimestamp` (> 5 min) → 202 ignore (defense-in-depth replay guard).
- Unregistered team key → 202 + warn log (same shape as the GitHub route's unregistered-repo handling).
- Label present but not a *fresh* trigger-label add (`matchesLinearTriggerLabel` false) → 204.
- `startDevCycleForLinearIssue` throwing (bad token, Temporal unreachable) → 500, caught locally like the GitHub
  path; the server's outer catch remains the backstop against a parser/verifier throw taking down the process.
- A `linear` `project.yaml` missing any required Linear field → `FileManagedProjectStore` throws at load with the
  slug named, matching its existing strict-validation behavior for GitHub entries.

### Definition of done

`pnpm lint && pnpm typecheck && pnpm test` green; `pnpm e2e` green (touches gateway + activities + worker path);
the two conflicting specs reconciled with a short note in this design and in `packages/gateway/README.md` that the
Linear route is back and ConfigMap-resolved. No live Linear delivery is exercised (out-of-repo per A2); reachability
is proven by the gateway integration test driving a signed fake delivery through to a fake Temporal client.

## Brainstorm Summary
**Approaches considered:** (A) reconnect the two severed ends of the already-built Linear path against the ConfigMap
store; (B) finish the July-25 retirement by deleting all orphaned Linear code; (C) add only the gateway route and
leave resolution repo-keyed.
**Chosen approach:** A — re-add the `/webhooks/linear` route + `LINEAR_WEBHOOK_SECRET`, teach `FileManagedProjectStore`
to parse Linear projects and look up by team key, and branch the resolver on `trackerType`.
**Why (decisive reasons):** The July-25 plan explicitly said "if Linear returns, re-add it against the ConfigMap the
same way" — this bughunt is that return. The whole middle/consumer half (ports, worker, contracts) is intact and
tested; only ingestion + resolution were stripped. A is small/additive and preserves that work; B contradicts the
plan and is a larger, irreversible delete; C is a structural non-fix (a team-key webhook can't be resolved by repo).
**Key risks/assumptions:** Full cluster reachability still needs out-of-repo work (real webhook secret, per-project
Linear API-key Secret, Linear-org webhook registration, DNS) — engine scope is verified with fakes. One additive
contract field (`linearTokenSecret`) is introduced; the route stays 404 unless `LINEAR_WEBHOOK_SECRET` is set, so
GitHub-only deployments are unaffected.
