# Platform Console — design

Status: draft v1 · 2026-07-07 · Owner: Artem

## 1. What this is

A minimal web UI + BFF that lets an operator start and watch `platform` workflow runs (PR #22, merged to `main`) without touching Temporal's native "Start Workflow" form — no task queue name, no workflow type string, no raw JSON input/output to read.

This is the **first slice** of Mission Control (ARCHITECTURE.md §5.10, M4 sub-project 5 in `docs/superpowers/specs/2026-07-06-m4-decomposition.md`), deliberately scoped to one workflow type. It does not build the cross-workflow board, live Loki tail, or budgets view §5.10 describes for the full version — those stay future work, unlocked by the same `control`/`ui` packages this slice creates. No ARCHITECTURE.md/MILESTONES.md changes are needed: this implements a subset of what §5.10 already describes, not a deviation from it.

**What an operator can do:**
1. Type a free-text prompt (optionally hint at repos to look at first), click Run.
2. See recent `platform` runs with status, without knowing where to look in Temporal.
3. Open a run and watch it go from `RUNNING` to done, then read the summary, actions taken, and any child `devCycle` fixes it started — with one click through to Temporal for forensics.

**Out of scope for v1** (unchanged from the original ask): multi-turn chat, starting `devCycle` from the UI, live Loki log tail, auth implementation (Traefik basic-auth in front in-cluster; open in local dev), the full cross-workflow board.

## 2. Packages

Two new packages, following this repo's existing conventions exactly (AGENTS.md: "one package per concern," no new top-level package without an ARCHITECTURE.md note — waived here since both are already named in ARCHITECTURE.md §5.10):

- **`packages/control`** — Node HTTP BFF, structured like `packages/gateway` (plain `node:http`, no framework, one file per concern). Talks to Temporal via `@temporalio/client` — same SDK `packages/cli` already uses for `start`/`getHandle`/`query`/`signal`. Serves `packages/ui`'s built static assets in production (single deployable).
- **`packages/ui`** — Vite + React + TypeScript SPA. **First browser code in this repo** — see §6 for the tooling this adds.

Local dev (two processes, matching the task description):
```bash
pnpm --filter @agentops/control dev   # BFF, port 3001
pnpm --filter @agentops/ui dev        # Vite dev server, proxies /api/* to :3001
```

## 3. Contracts (`packages/contracts/src/control-api.ts`)

New zod schemas, validated at the `control` boundary per AGENTS.md rule 3:

```ts
export const StartRunRequestSchema = z.object({
  prompt: z.string().min(1),
  hintRepos: z.array(z.string()).optional(),
  workflowId: z.string().min(1).optional(),
});
export type StartRunRequest = z.infer<typeof StartRunRequestSchema>;

export const StartRunResponseSchema = z.object({ workflowId: z.string(), runId: z.string() });
export type StartRunResponse = z.infer<typeof StartRunResponseSchema>;

export const RunStatusSchema = z.enum([
  'RUNNING', 'COMPLETED', 'FAILED', 'CANCELED', 'TERMINATED', 'TIMED_OUT',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunListItemSchema = z.object({
  workflowId: z.string(),
  runId: z.string(),
  status: RunStatusSchema,
  startTime: z.string(),           // ISO 8601
  closeTime: z.string().optional(),
  promptSnippet: z.string().optional(), // truncated prompt, from Temporal memo -- NOT PlatformAgentResult.summary
});
export type RunListItem = z.infer<typeof RunListItemSchema>;

export const RunListResponseSchema = z.array(RunListItemSchema);

export const RunDetailSchema = z.object({
  workflowId: z.string(),
  runId: z.string(),
  status: RunStatusSchema,
  prompt: z.string().optional(),          // full original prompt, from memo
  result: PlatformAgentResultSchema.optional(), // present only once COMPLETED and parseable
  error: z.string().optional(),           // failure message, or "unparseable result" on a schema mismatch
  temporalUrl: z.string(),
});
export type RunDetail = z.infer<typeof RunDetailSchema>;

export const RepoListResponseSchema = z.object({ repos: z.array(z.string()) });
```

**Naming fix vs. the original ask:** the list endpoint's per-row field is `promptSnippet`, not `summary` — the actual result `summary` only exists once a run completes, and fetching it for every row in the list view would mean one extra Temporal call per row. `promptSnippet` costs nothing extra (see §4).

**Design decision — how the UI gets the prompt text back at all:** neither `PlatformAgentInput` nor `PlatformAgentResult` round-trips the original prompt through workflow *output*, and Temporal visibility search only returns metadata, not the start input. Fetching real input requires a history lookup (the `WorkflowExecutionStarted` event), which is an extra call per workflow — the same N+1 problem `promptSnippet` avoids. Instead, `control` attaches the **full prompt as a Temporal memo** (`memo: { prompt }`) when starting the workflow (§4). Memos are ordinary JSON payloads with no server-side schema registration (unlike Search Attributes, which need cluster-level index config `control` shouldn't depend on) — `client.workflow.list()` and `handle.describe()` both return memo values decoded for free. The list endpoint truncates `memo.prompt` server-side to build `promptSnippet`; the detail endpoint returns it in full as `prompt`.

## 4. `control` BFF

**Deps injected into each handler** (mirrors `GatewayDeps`):
```ts
interface ControlDeps {
  client: Client;               // @temporalio/client
  taskQueue: string;
  namespace: string;
  temporalUiBaseUrl: string;
  registry: string[];           // repo slugs, from parseProjectRegistry — see below
}
```

**Routes** (`packages/control/src/create-control-server.ts`, one handler file per route):

| Route | Behavior |
|---|---|
| `POST /api/platform/runs` | Validate body with `StartRunRequestSchema` (400 on failure). `workflowId = body.workflowId ?? \`platform-${randomUUID()}\``. `client.workflow.start(platform, { taskQueue, workflowId, args: [{prompt, hintRepos}], memo: { prompt } })`. Catch `WorkflowExecutionAlreadyStartedError` → 409. Return 202 `{workflowId, runId: handle.firstExecutionRunId}`. |
| `GET /api/platform/runs?limit=20` | `client.workflow.list({ query: 'WorkflowType="platform" ORDER BY StartTime DESC' })`, take up to `limit` from the async iterator. Map each `WorkflowExecutionInfo` → `RunListItemSchema` (status normalized from the SDK's status enum; `promptSnippet` = `memo.prompt` truncated to ~120 chars). |
| `GET /api/platform/runs/:workflowId` | `handle.describe()` for status. `WorkflowNotFoundError` → 404. If `COMPLETED`: `handle.result()`, validate with `PlatformAgentResultSchema.safeParse` — mismatch sets `error`, not a crash. If `FAILED`/`TERMINATED`/`CANCELED`/`TIMED_OUT`: read the failure message from `describe()`'s execution info (never call `result()`, which throws on these). `prompt` from `memo.prompt`. `temporalUrl` built from `temporalUiBaseUrl` + namespace + workflowId + runId. |
| `GET /api/registry/repos` | Parse `PROJECT_REGISTRY_JSON` with `parseProjectRegistry` (the pure zod parser in `@agentops/contracts`) — **not** `loadProjectRegistry` from `@agentops/activities`, which throws if a repo's token env var isn't set. `control` only needs repo slugs for a picker, never a token, so it must not require write-scoped credentials the worker needs. Return `{ repos: entries.map(e => e.repo) }`, `[]` if unset. |
| `GET /healthz` | 200 `ok`, same as gateway. |

**Routing:** a small hand-rolled `matchRoute(method, url, pattern)` helper (`packages/control/src/route.ts`) supporting one `:param` path segment — enough for these 5 routes, no new dependency, consistent with gateway's zero-framework style.

**Error convention:** JSON `{"error": "..."}` on 4xx/5xx (gateway uses plain text because its only consumer is GitHub; `control`'s consumer is the SPA, which needs a machine-readable message).

**Static file serving (production only):** `control` serves `packages/ui/dist` itself — a small `fs.readFile` + extension→content-type map in `control`, no `serve-handler`/`express.static` dependency. SPA fallback (unknown non-`/api` GET path → `index.html`) so client-side routing (`/runs/:workflowId`) works on a hard refresh.

**Env vars** (as specified): `TEMPORAL_ADDRESS` (default `localhost:7233`), `TEMPORAL_NAMESPACE` (default `default`), `TASK_QUEUE` (default `agentops-devcycle`), `PROJECT_REGISTRY_JSON` (optional), `TEMPORAL_UI_BASE_URL`, `PORT` (default `3001`).

## 5. `ui` SPA

**Routes** (`react-router-dom`): `/` → `HomePage`, `/runs/:workflowId` → `RunDetailPage`.

**`api.ts`** — thin `fetch` wrapper per endpoint, parsing every response through the matching zod schema from `@agentops/contracts` (schemas cross a network boundary here, same "validate at the boundary" rule as the server side).

**`HomePage`:**
- Prompt textarea; three suggested-prompt chips (hardcoded `SUGGESTED_PROMPTS` constant) that fill the textarea on click.
- Hint-repos: a single freeform text input (comma-separated `owner/repo`), always usable even with no registry configured, with a suggestions dropdown populated from `GET /api/registry/repos` when non-empty. **Decided over a strict registry-only picker** — `hintRepos` was designed as unvalidated prompt context, not a scope restriction (per `docs/superpowers/specs/2026-07-07-platform-agent-design.md` §3), so gating the input on registry membership would be more restrictive than the workflow itself.
- Run button, disabled while the prompt is empty/whitespace-only or a submit is in flight. On success, navigates to `/runs/:workflowId`.
- Recent-runs table below: fetches `GET /api/platform/runs?limit=20` once on mount (not continuously polled — an operator watching a specific run uses the detail page's live status instead). Columns: status badge, `promptSnippet` (falls back to `workflowId` if absent), started-at, link to detail.

**`RunDetailPage`:**
- Fetches `GET /api/platform/runs/:workflowId` on mount. While `status === 'RUNNING'`, polls every 3s via `useEffect`+`setInterval`, stopping once a terminal status is reached.
- Header: status badge, prompt (full text from `prompt`), "Open in Temporal" button linking to the top-level `temporalUrl` field.
- On `COMPLETED`: `result.summary` rendered through `react-markdown` (+ `remark-gfm` for tables/task-lists), styled to match the console's flat/minimal look — **revised 2026-07-08**, reversing the v1 "plain pre-wrapped text, no markdown parser" decision above. The `platform` prompt template now explicitly instructs the agent to write `summary` in Markdown (headings, lists, bold, code spans), so rendering it as plain text left real structure looking like escaped noise. `react-markdown` parses to React elements rather than using `dangerouslySetInnerHTML`, so it stays safe against the same XSS concern that motivated the original caution without needing a sanitizer. `result.actionsTaken` as a small table (type, workflowId, reason) — each workflowId links to `{temporalUiBaseUrl}/namespaces/{ns}/workflows/{workflowId}` (no runId needed; Temporal Web UI resolves to the latest run); `result.childWorkflows` as cards (repo, goal, same kind of link to the child's own workflow page). `actionsTaken[].reason` and `childWorkflows[].goal` stay plain text — they're short single-line fields, not free-form narrative.
- On any other terminal status, or a `COMPLETED` run with `error` set (unparseable result): render `error` in place of the summary/actions/children block — no partial rendering of a shape that failed validation.

**Styling:** one plain CSS file, flexbox/grid, no framework/CSS-in-JS — matches "no design system rabbit hole."

## 6. New tooling (first browser package in this repo)

- `packages/ui/tsconfig.json` extends the root `tsconfig.base.json` but overrides `lib` (adds `DOM`, `DOM.Iterable`), `jsx` (`react-jsx`), `module`/`moduleResolution` (`ESNext`/`bundler`) — same per-package `tsconfig.json` pattern every existing package already uses, not a violation of AGENTS.md's "no per-package eslint/prettier overrides" (that rule doesn't cover tsconfig).
- Root `eslint.config.js` gets one new scoped block, `files: ['packages/ui/src/**/*.tsx']`, adding `eslint-plugin-react-hooks` rules — the same scoping technique the config already uses for `packages/workflows/src/**`'s determinism rules. Still one central config.
- New root devDependencies: `vite`, `@vitejs/plugin-react`, `react`, `react-dom`, `react-router-dom`, `eslint-plugin-react-hooks`.
- No UI component-testing library added — testing is scoped to `control` handlers (§7); `packages/ui` is verified by running it in a browser (see §7).

## 7. Testing

Per AGENTS.md's definition of done (`pnpm lint && pnpm typecheck && pnpm test`; `pnpm e2e` not triggered here — this doesn't touch workflows/policies/activities/backends):

- **`packages/contracts`**: schema tests for `control-api.ts` (same style as `platform-agent.test.ts`).
- **`packages/control`**: vitest unit tests per handler, mocking a fake object satisfying the subset of `Client` used (`workflow.start`/`list`/`getHandle`), no real Temporal connection:
  - `POST /api/platform/runs`: empty prompt → 400; correct `taskQueue`/args/`memo` passed to `client.workflow.start`; duplicate `workflowId` → 409.
  - `GET /api/platform/runs`: maps a fake `list()` page into `RunListItemSchema`-conforming items, including `promptSnippet` from memo.
  - `GET /api/platform/runs/:workflowId`: completed run returns a parsed `result`; running run has no `result`; unknown workflowId → 404; a `COMPLETED` run whose output fails `PlatformAgentResultSchema` → `error` set, not a throw.
  - `GET /api/registry/repos`: returns parsed slugs; `[]` when `PROJECT_REGISTRY_JSON` unset.
- **`packages/ui`**: no automated tests; verified by running `temporal server start-dev` + `pnpm worker` (stub backend, zero token spend) + `pnpm --filter @agentops/control dev` + `pnpm --filter @agentops/ui dev` locally, and driving the golden path in a browser (start a run, watch it complete, read the result) before this ships — required by this repo's own frontend-verification convention, not optional.
- Helm: extend `charts/engine/tests/render.golden.yaml` to cover the new `control` Deployment/Service/Ingress, matching the existing golden-file convention.

## 8. Helm / deploy

Extends `charts/engine` (same chart as worker/gateway), following `gateway-deployment.yaml`/`gateway-service.yaml`/`gateway-ingress.yaml` exactly:

- `control-deployment.yaml`, `control-service.yaml` (port 3001), `control-ingress.yaml` (disabled by default, `control.ingress.enabled`/`host`, same pattern as `gateway.ingress`).
- New values: `image.controlTag`, `control.port` (3001), `control.resources`, `control.ingress`, `temporalUiBaseUrl` (top-level, alongside the existing `temporalAddress`).
- `images/control/Dockerfile`: multi-stage — build `packages/ui` (`pnpm --filter @agentops/ui build`), build/typecheck `packages/control`, copy `packages/ui/dist` into the final image, run `pnpm --filter @agentops/control run start`. Same `node:22-slim` + pinned `pnpm` + numeric non-root user pattern as `images/gateway/Dockerfile`.
- CI (`.github/workflows/ci.yaml`'s `build-images` job): add a `docker/build-push-action@v6` step for `images/control/Dockerfile`, tagged `gitactions.est1908.top/agentic-ops/control:${{ github.sha }}`, same shape as the existing gateway step.
- `scripts/bump-platform-engine-tags.sh` gets one more regex substitution line for `controlTag`, alongside `workerTag`/`agentRunnerTag`/`gatewayTag`. It writes into `agentops-platform`'s `clusters/ops/engine/values.yaml`, a file this repo doesn't own — the substitution is a no-op until that repo's values file has a `controlTag` key to match, which is `agentops-platform`-side work tracked as a precondition, not built here (same pattern as the platform-agent design's own §9 preconditions).

**Precondition, not built here:** `agentops-platform`'s `clusters/ops/engine/values.yaml` needs a `controlTag` key (and ideally `control.ingress`/host values) added before the tag-bump script's new substitution line has any effect, and before `control` can be deployed with a real image. Until then, this PR's chart changes render correctly and pass `helm lint`/the golden-file test, but `control` won't actually roll out in-cluster.

## 9. Non-goals (unchanged from the original ask)

Multi-turn chat, starting `devCycle` from the UI, live Loki log tail, auth implementation, the full cross-workflow board, budgets view. All remain future Mission Control work built on the same two packages.
