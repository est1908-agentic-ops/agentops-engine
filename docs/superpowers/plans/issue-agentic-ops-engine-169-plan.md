# Plan — issue-agentic-ops-engine-169

Reconnect the two severed ends of the already-built Linear tracker path against the ConfigMap-backed
registry, restoring end-to-end reachability within the engine. Approach A from the design:
[docs/superpowers/specs/issue-agentic-ops-engine-169-design.md](../specs/issue-agentic-ops-engine-169-design.md).

Scope is the engine repo only (design A2): route → verify → parse → resolve-by-team-key → start
`devCycle`. The middle/consumer layers (`ports/src/linear/*`, worker `trackerType === 'linear'` branch,
`createProjectScopedPorts` `byLinearTeamKey`, `ResolvedProjectEntry` linear variant) are already built,
tested, and **unchanged by this plan** — verified present during planning. No live Linear delivery.

## Pre-work findings that shaped this plan

- `packages/contracts/src/resolved-project-entry.ts` **already** has the full `linear` variant
  (`token`, `linearTeamKey`, `linearTriggerLabelId`, `linearToken`) — no edit needed there.
- `charts/engine/templates/gateway-deployment.yaml` (lines 45–51) and `charts/engine/values.yaml`
  (`linearWebhookSecretName: ""`, line 139) **already** carry the conditional `LINEAR_WEBHOOK_SECRET`
  wiring. The chart step in the design is already satisfied → downgraded to a verification-only step
  (Step 7), not an edit.
- Adding `getByLinearTeamKey` as a **required** method to the `ManagedProjectStore` interface breaks
  the typed fake in `packages/control/src/create-control-server.test.ts` (`fakeManagedProjectStore`,
  ~line 61, returns an explicitly-typed literal). That fake must be updated in the same step
  (Step 2). The `cli` fakes use `as unknown as ManagedProjectStore` double-casts and are unaffected.

## Steps

Each step is independently `pnpm typecheck`-green after it completes (barring the one interface/fake
coupling handled together in Step 2).

### Step 1 — Contracts: add `linearTokenSecret` to the `linear` ManagedProject variant
- **File:** `packages/contracts/src/managed-project.ts`
- **Change:** add `linearTokenSecret: z.string().optional()` to the `linear` object in
  `ManagedProjectSchema` (K8s Secret name for the Linear API key; mirrors the existing optional
  `tokenSecret` for GitHub, comment likewise). Additive/optional — no existing fixture breaks.
- **Verify:** `pnpm --filter @agentops/contracts typecheck`; `pnpm --filter @agentops/contracts test`.

### Step 2 — Contracts: add `getByLinearTeamKey` to the store interface (+ fix the one typed fake)
- **Files:** `packages/contracts/src/managed-project-store.ts`,
  `packages/control/src/create-control-server.test.ts`
- **Change:** add `getByLinearTeamKey(teamKey: string): Promise<ManagedProject | null>` to the
  `ManagedProjectStore` interface; replace the "intentionally omitted / Linear retired" comment with a
  note that Linear resolution is back and resolved by team key against the ConfigMap store. In the
  control test, extend `fakeManagedProjectStore` to implement the new method
  (`async getByLinearTeamKey(teamKey) { return projects.find(p => p.trackerType === 'linear' &&
  p.linearTeamKey === teamKey) ?? null }`) so the typed literal still satisfies the interface.
- **Verify:** `pnpm --filter @agentops/contracts typecheck && pnpm --filter @agentops/control typecheck`;
  `pnpm --filter @agentops/control test` (control suite still green).
- **Sequencing note:** interface change + fake fix are one step on purpose — splitting them leaves an
  intermediate state where `control` typecheck is red. `FileManagedProjectStore` gains the concrete
  method in Step 3; ordering Step 3 before this would also work, but this order keeps the contracts
  changes adjacent.

### Step 3 — Activities: teach `FileManagedProjectStore` to parse Linear projects & look up by team key
- **File:** `packages/activities/src/file-managed-project-store.ts` (+ `file-managed-project-store.test.ts`)
- **Change:**
  - Extend `RawManagedProjectFile` with `trackerType?`, `linearTeamKey?`, `linearTriggerLabelId?`,
    `linearTokenSecret?` (all `unknown`).
  - In `readAll()`: when `trackerType === 'linear'`, validate `repo`/`project` plus the three Linear
    fields are non-empty strings (throw the same slug-named strict error on any missing field), and
    build the `linear` `ManagedProject` variant (`credentialSet: true`, `linearCredentialSet: true`,
    `tokenSecret` from `tokenSecret`, `linearTokenSecret` from its field). Absent/`'github'`
    `trackerType` ⇒ existing GitHub path unchanged (every current `project.yaml` stays valid).
  - Build a second `byLinearTeamKey` map alongside `byRepo` during `readAll()`. Linear entries are
    added to **both** `byRepo` (so repo-keyed config lookup still works) and `byLinearTeamKey`. Return
    both maps from `readAll()` / cache them (change `cache` to hold `{ byRepo, byLinearTeamKey }`).
  - Implement `async getByLinearTeamKey(teamKey)` reading the `byLinearTeamKey` map.
- **Verify:** new test cases in `file-managed-project-store.test.ts` — a `linear` fixture asserting the
  `linear` variant is returned, `getByLinearTeamKey('ENG')` finds it, the same entry is still reachable
  by repo via `get()`, and a `linear` fixture missing (e.g.) `linearTriggerLabelId` throws with the
  slug named. `pnpm --filter @agentops/activities test file-managed-project-store`.

### Step 4 — Activities: branch the resolver on `trackerType` + add team-key resolution
- **File:** `packages/activities/src/resolve-managed-projects.ts` (+ `resolve-managed-projects.test.ts`)
- **Change:**
  - In `resolveOne`, branch on `managedProject.trackerType`: for `linear`, require both `tokenSecret`
    and `linearTokenSecret`, resolve each via `deps.resolveToken`, and return the `linear`
    `ResolvedProjectEntry` (`token`, `linearToken`, `linearTeamKey`, `linearTriggerLabelId`, normalized
    `repo`). GitHub branch unchanged. Refactor `resolveOne` to take the already-fetched `ManagedProject`
    (or keep fetching by repo) — extract the token-resolve+build into a shared helper so the new
    team-key entrypoint reuses it.
  - Add `export async function resolveManagedProjectEntryByLinearTeamKey(deps, teamKey)`: returns
    `null` when `deps` is undefined; else `store.getByLinearTeamKey(teamKey)` then the shared build
    step (`null` on miss). `deps` shape (`{ store, resolveToken }`) is unchanged — `resolveToken`
    already accepts any Secret name. Exported automatically via `export *` in `activities/src/index.ts`.
- **Verify:** new test cases — Linear resolution populates both `token` and `linearToken` plus the
  Linear fields (assert `resolveToken` called with both secret names);
  `resolveManagedProjectEntryByLinearTeamKey` returns the resolved entry on hit and `null` on miss and
  when `deps` is undefined. `pnpm --filter @agentops/activities test resolve-managed-projects`.
- **Sequencing note:** depends on Step 3 (needs `getByLinearTeamKey` on the concrete store and the
  Linear `ManagedProject` shape). Kept after Step 3 for that reason.

### Step 5 — Gateway: add the `/webhooks/linear` route + handler
- **File:** `packages/gateway/src/create-gateway-server.ts` (+ `create-gateway-server.test.ts`)
- **Change:**
  - `GatewayDeps` gains `linearWebhookSecret?: string`.
  - In `handleRequest`, when `req.method === 'POST' && req.url === '/webhooks/linear'` **and**
    `deps.linearWebhookSecret` is set, dispatch to a new `handleLinearWebhook`; when the secret is
    unset the path falls through to the existing `404` (design A4 — backward compatible).
  - `handleLinearWebhook` implements the design's data flow, reusing `deps.buildScm` /
    `resolveProjectConfig` exactly as the GitHub path does, importing the already-built
    `verifyLinearSignature` + `isFreshLinearWebhook`, `parseLinearIssueEvent` +
    `matchesLinearTriggerLabel`, `resolveManagedProjectEntryByLinearTeamKey`, and
    `startDevCycleForLinearIssue`:
    - read raw body; `verifyLinearSignature(raw, headers['linear-signature'], secret)` → `401` on fail;
    - `JSON.parse` → `400` on malformed;
    - `parseLinearIssueEvent(payload)` → `204` if `null` (non-Issue / non-create-update);
    - `isFreshLinearWebhook(event.webhookTimestamp, Date.now())` → `202` ignore if stale (A5:
      `Date.now()` is allowed here, gateway is a plain Node server, not `packages/workflows`);
    - `resolveManagedProjectEntryByLinearTeamKey(deps.managedProjectDeps, event.teamKey)` → `202` +
      warn log if unregistered;
    - `matchesLinearTriggerLabel(event, entry.linearTriggerLabelId)` → `204` if not a fresh trigger add;
    - `scm = deps.buildScm(entry)`, `config = await resolveProjectConfig(deps.managedProjectDeps, scm,
      entry.repo)`, then `startDevCycleForLinearIssue(client, taskQueue, entry.project, event,
      entry.repo, config)` → `202` (`204` on already-started duplicate), `500` on throw (caught locally,
      like the GitHub path).
- **Verify:** new Linear suite in `create-gateway-server.test.ts` mirroring the GitHub one:
  route-disabled-when-secret-unset (404), bad signature (401), non-Issue/wrong-action (204),
  stale-timestamp (202 ignore), unregistered team (202), label-not-trigger (204), and the happy path
  (202 with `startDevCycleForLinearIssue` called with the resolved project/repo/config). Drive with a
  signed fake delivery + fake Temporal client. `pnpm --filter @agentops/gateway test create-gateway-server`.
- **Sequencing note:** depends on Step 4 (`resolveManagedProjectEntryByLinearTeamKey`). This is the
  step that makes the built dead code reachable, so it comes as late as its dependencies allow.

### Step 6 — Gateway: wire the secret from the environment
- **File:** `packages/gateway/src/main.ts`
- **Change:** read `process.env.LINEAR_WEBHOOK_SECRET` (optional, no throw when unset) and pass it as
  `linearWebhookSecret` to `createGatewayServer`. No other wiring changes — `buildScm` /
  `managedProjectDeps` already flow to both routes.
- **Verify:** `pnpm --filter @agentops/gateway typecheck`. Manual read-through that unset secret ⇒
  `linearWebhookSecret: undefined` ⇒ route 404 (covered by Step 5's disabled-route test).

### Step 7 — Chart & values: verify the (already-present) Linear secret wiring
- **Files:** `charts/engine/templates/gateway-deployment.yaml`, `charts/engine/values.yaml`
- **Change:** none expected — both already carry the conditional `LINEAR_WEBHOOK_SECRET` env
  (rendered only when `gateway.linearWebhookSecretName` is set) and the `linearWebhookSecretName: ""`
  default. If a `helm template` render with the value set/unset does **not** show the env appearing
  only when set, add the missing piece to match the design; otherwise this step is a confirmation.
- **Verify:** `helm template charts/engine --set gateway.linearWebhookSecretName=my-secret | grep -A3
  LINEAR_WEBHOOK_SECRET` shows the env; the same render without the flag omits it. (If `helm` is
  unavailable in the sandbox, assert by inspection of the `{{- if ... }}` guard.)

### Step 8 — Docs: note the Linear route is back and ConfigMap-resolved
- **File:** `packages/gateway/README.md` (and a one-line reconciliation note is already in the design)
- **Change:** replace the "Linear route was retired… if Linear returns, re-added against the
  ConfigMap" sentence with a present-tense note that `POST /webhooks/linear` is active (secret-gated
  by `LINEAR_WEBHOOK_SECRET`) and resolves projects by Linear team key against the ConfigMap store,
  pointing at this design doc.
- **Verify:** manual read; `pnpm lint` (markdown/prettier if configured).

### Step 9 — Full green gate
- **Verify (definition of done, AGENTS.md §6):** from repo root run
  `pnpm lint && pnpm typecheck && pnpm test`, then `pnpm e2e` (this change touches gateway +
  activities and the worker Linear path). All green. No live Linear delivery exercised (A2) —
  reachability is proven by Step 5's integration test driving a signed fake through to a fake
  Temporal client.

## Sequencing summary

Contracts (1–2) → activities store (3) → activities resolver (4) → gateway route (5) → gateway
wiring (6) → chart/docs verification (7–8) → full gate (9). This is strict dependency order: each
layer's consumer is only written after its producer exists, so every step leaves the tree
typecheck-green. The one place two files must move together is Step 2 (interface + typed fake). The
gateway route (Step 5) — the actual bug fix that de-risks "is the path reachable end-to-end" — is
placed as early as its four dependencies (Steps 1–4) permit; it cannot precede them because it calls
`resolveManagedProjectEntryByLinearTeamKey` and reads the `linear` `ResolvedProjectEntry` fields.

An alternative ordering — gateway route first (top-down) to validate the wiring shape early — was
rejected: it would require stubbing the resolver/store, producing throwaway scaffolding and a
transiently red typecheck, whereas bottom-up keeps every intermediate commit shippable.

## Assumptions

- **P1 — Chart already done.** The design lists a chart edit, but `gateway-deployment.yaml` +
  `values.yaml` already contain the conditional `LINEAR_WEBHOOK_SECRET` wiring and the
  `linearWebhookSecretName` default. Assumption: this was landed by an earlier change; Step 7 is
  verification-only, and I only edit the chart if the render doesn't match the design.
- **P2 — `ResolvedProjectEntry` unchanged.** The contract already has the complete `linear` variant,
  so no `resolved-project-entry.ts` edit is planned despite the design's data-flow mentioning those
  fields; they already exist.
- **P3 — Control test fake must be updated.** Making `getByLinearTeamKey` a required interface method
  breaks `control`'s explicitly-typed `fakeManagedProjectStore`. Assumption: update that fake in
  Step 2 (returns a Linear entry by team key, else `null`) rather than making the method optional —
  a required method matches the design's intent and keeps the GitHub-path fakes honest. The `cli`
  fakes use `as unknown as` casts and need no change.
- **P4 — `linear-signature` header casing.** Node lowercases incoming header names, so the handler
  reads `req.headers['linear-signature']`. Assumption confirmed against how the GitHub handler reads
  `x-hub-signature-256`.
- **P5 — Shared resolve helper.** `resolveManagedProjectEntryByLinearTeamKey` and the repo-keyed
  `resolveOne` share one token-resolve+build helper rather than duplicating the branch. Assumption:
  extract-and-reuse (contracts rule 3, no structural duplication of a contract type).
