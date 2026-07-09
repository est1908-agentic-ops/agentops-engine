# Prompt-started DevCycle from the console — design

Status: draft v1 · 2026-07-09 · Owner: Artem

## 1. Why

The console can start a `platform` run from a free-text prompt, and the Managed Projects page can register any repo (credentials + config) without touching it — but there is still no way to say "go do this development task on project X" from the browser. The only ad-hoc (no tracker issue) `devCycle` entry point is the admin CLI (`engine start --goal ... --repo ...`); the console's own design explicitly deferred "starting `devCycle` from the UI" ([2026-07-07-platform-console-design.md](2026-07-07-platform-console-design.md) §9).

This design lifts that deferral: pick a registered project in the console, type a prompt, and a real `devCycle` starts with the prompt as its `goal` — the "ad-hoc prompt task" action ARCHITECTURE.md §5.10 already plans for Mission Control.

## 2. Scope

**In scope:** the `TaskInput.config`-optional contract change, in-workflow config resolution in `devCycle`, three `control` routes to start/list/inspect devCycle runs, and the console UI (target selector on the home form, per-project Run shortcut, devCycle run-detail page).

**Out of scope** (explicitly deferred, not forgotten):
- Console signal actions on a running devCycle (stop/cancel/resume/clarify) — future Mission Control slice; the Temporal UI link covers forensics/rescue for now.
- Fixing the worker's boot-time registry snapshot (§7) — pre-existing limitation, documented here, not solved here.
- Migrating gateway/CLI to in-workflow config resolution — they keep pre-resolving; the optional `config` path is additive.
- Auth changes — run-start endpoints keep the same posture as starting `platform` runs (ingress-level auth); `CONTROL_CRUD_TOKEN` stays scoped to credential writes.
- Creating a tracker issue for prompt-started runs — goal-driven runs are issue-less by design (same as `platform`'s child fixes).

## 3. The credential constraint that shapes the design

`devCycle` today requires a fully-resolved `ProjectConfig` in its input, and resolving one can require reading `agentops.json` from the repo — which needs a decrypted repo token. `control` deliberately cannot do that: it holds only the public key of the managed-project encryption scheme ([2026-07-08-managed-project-registry-design.md](2026-07-08-managed-project-registry-design.md) §5) so a browser-facing compromise can never read stored credentials.

**Decision (confirmed in this session): resolve config inside the workflow, not in `control`.** `TaskInput.config` becomes optional; when absent, `devCycle`'s first step calls the existing `resolveRepoConfig` activity (built for the `platform` workflow, `packages/activities/src/create-activities.ts`) on the worker — which already holds the private key and the merged static+managed registry. `control` starts the workflow with nothing but `{taskId, project, repo, goal}`.

Alternatives rejected:
- **Wrapper parent workflow** (`promptDevCycle` → `executeChild(devCycle)`): zero contract change, but adds a workflow type that exists only to work around an input shape, and every console run becomes parent+child in Temporal — worse listing, worse deep links.
- **Give `control` the private key:** simplest code-wise, but breaks the encrypt-only boundary that is the managed-project design's entire point.

## 4. Contracts (`packages/contracts`)

**Changed:** `TaskInputSchema.config` → `ProjectConfigSchema.optional()` (`src/task-input.ts`). All existing callers (gateway, CLI, `platform` children) keep passing it; only `control` omits it.

**New file `src/control-devcycle-api.ts`:**

```ts
export const StartDevCycleRequestSchema = z.object({
  repo: z.string().min(1),            // owner/repo — must be a registered project
  prompt: z.string().min(1),          // becomes TaskInput.goal verbatim
  taskId: z.string().min(1).optional(), // default: randomUUID() in control
});

export const StartDevCycleResponseSchema = z.object({
  workflowId: z.string(),
  runId: z.string(),
  taskId: z.string(),
});

// List rows reuse RunListItemSchema (control-api.ts) — it is already generic
// (workflowId, runId, status, startTime, closeTime?, promptSnippet?).

export const DevCycleRunDetailSchema = z.object({
  workflowId: z.string(),
  runId: z.string(),
  status: RunStatusSchema,            // reused from control-api.ts
  prompt: z.string().optional(),      // from memo; absent for webhook-started runs
  state: DevCycleStateSchema.optional(), // live query while RUNNING, result once closed
  error: z.string().optional(),
  temporalUrl: z.string(),
});
```

**`DevCycleState` moves to contracts.** Today it is a plain TS interface in `packages/workflows/src/dev-cycle.ts` (stage, status, blockReason, prRef, cumulativeTokens, …). `control` now consumes it across a network boundary, so per AGENTS.md rule 3 it gets a zod schema: new `DevCycleStateSchema` in contracts, and `dev-cycle.ts` replaces its local interface with the inferred type (no structural duplication). No shape change — a mechanical move.

## 5. Workflow change (`packages/workflows/src/dev-cycle.ts`)

At the top of `devCycle`, before anything reads `input.config` (note: `effectiveBrakes` is initialized from it today, so the resolution step moves ahead of that):

1. `config = input.config`, or if absent → `await activities.resolveRepoConfig(input.repo)`.
2. `registered: false` → the run ends immediately: `status: 'failed'`, a clear block/failure reason ("repo not registered on this worker — check registration or restart the worker"), never a crashing activity failure. This mirrors how `platform` treats unregistered repos as skips rather than crashes.
3. `registered: true` → proceed with the resolved config exactly as if it had been passed in.

`resolveRepoConfig` moves from `platform-activities-api.ts` into the shared activity surface so `devCycle` can call it (same implementation, wider interface). The workflow stays deterministic — resolution is one activity call.

## 6. `control` BFF (`packages/control`)

Three routes, existing conventions (plain `node:http`, one handler file per route, JSON `{"error": ...}`):

| Route | Behavior |
|---|---|
| `POST /api/devcycle/runs` | Validate with `StartDevCycleRequestSchema` (400). Resolve `project` slug server-side: managed store row for `repo`, else static `PROJECT_REGISTRY_JSON` entry — both readable without decryption; unknown repo → 422. `taskId = body.taskId ?? randomUUID()`; `workflowId = prompt-${project}-${taskId}`. `client.workflow.start(devCycle, { taskQueue, workflowId, args: [{taskId, project, repo, goal: prompt}], memo: { prompt } })`. `WorkflowExecutionAlreadyStartedError` → 409. 202 with `{workflowId, runId, taskId}`. |
| `GET /api/devcycle/runs?limit=20` | `client.workflow.list({ query: 'WorkflowType="devCycle" ORDER BY StartTime DESC' })` — includes webhook/CLI-started runs (a feature: this is the first slice of the cross-workflow board). `promptSnippet` from memo when present, else absent (UI falls back to workflowId, same as platform list). |
| `GET /api/devcycle/runs/:workflowId` | `describe()` for status (404 on not-found). While `RUNNING`: `handle.query('state')` for live `DevCycleState`. Once closed: `COMPLETED` → `handle.result()` (devCycle returns its final `DevCycleState`); other terminal statuses → failure message from `describe()`, never `result()`. Validate with `DevCycleStateSchema.safeParse`; mismatch sets `error`, not a crash. |

Notes:
- The state query can race a run that closes between `describe()` and `query()` — catch and fall back to the closed-run path rather than 500ing.
- The start handler needs read access to the managed store (already wired for project CRUD) plus the parsed static registry (extend `read-registry-repos.ts` to expose `{repo, project}` pairs, not just slugs).

## 7. Failure modes & known limitation

- **Unknown repo at start:** rejected synchronously by `control` (422) — the user never gets a doomed workflow.
- **Repo known to `control` but not to the worker:** the worker merges the managed registry **at boot** (`packages/worker/src/main.ts`), so a project registered in the console after the last worker restart passes `control`'s check but resolves `registered: false` in the workflow. The run fails fast with the explicit reason from §5. Pre-existing platform-wide limitation (webhook runs hit it too); fixing the snapshot (live re-resolution, registry refresh, or worker notification) is deliberately a separate follow-up.
- **Unparseable/mismatched result:** same convention as platform runs — `error` field, no partial rendering.

## 8. UI (`packages/ui`)

- **Console home:** the prompt form gains a target selector — **Platform** (default, today's behavior) or any registered project (options = managed projects ∪ static-registry repos). Project selected → `POST /api/devcycle/runs`, navigate to the devCycle detail page. The hint-repos input stays platform-only (hidden for project targets; devCycle has no hintRepos concept).
- **Recent runs:** fetch platform + devCycle lists, merge client-side sorted by start time, with a type badge per row. Rows link to the matching detail page.
- **Projects page:** each row gets a **Run** action → `/?target=<repo>` (pre-fills the selector, focuses the prompt box). No inline dialog — one form to maintain.
- **New `DevCycleRunDetailPage`** (`/dev-runs/:workflowId`): status badge, prompt, stage + status + blockReason from `state`, PR link when `prRef` is set, cumulative tokens, "Open in Temporal". Polls every 3s while `RUNNING`, same pattern as the platform detail page.

## 9. Testing

Per AGENTS.md definition of done (`pnpm lint && pnpm typecheck && pnpm test`; e2e required — workflows are touched):

- **contracts:** schema tests for `control-devcycle-api.ts` and `DevCycleStateSchema`; `TaskInputSchema` still accepts config-present inputs and now accepts config-absent.
- **workflows:** `TestWorkflowEnvironment` tests — config absent → `resolveRepoConfig` called and its config used; `registered: false` → immediate failed state with the explicit reason; config present → activity **not** called (gateway/CLI path unchanged).
- **control:** handler tests with mocked client/store — unknown repo → 422; correct args/memo/workflowId passed to `start`; duplicate → 409; detail mapping for running (query), completed (result), failed (describe message), and the close-race fallback.
- **e2e:** existing stub-backend suite re-run green; extend with a config-absent start if cheap.
- **ui:** no automated tests (repo convention) — verified in-browser against `temporal server start-dev` + stub-backend worker: register a project, Run from both entry points, watch the detail page reach a terminal state.

## 10. Non-goals

Restated from §2: console signal actions, boot-time registry snapshot fix, gateway/CLI migration to in-workflow resolution, auth changes, tracker-issue creation for prompt runs. Also: no Temporal Search Attributes (memo is sufficient at this scale, same call as the console design), no unified `/api/runs` endpoint (additive routes only; a merged board API can supersede both lists later).
