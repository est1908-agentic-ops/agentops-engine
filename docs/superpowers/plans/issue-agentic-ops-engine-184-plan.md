# Plan — issue-agentic-ops-engine-184: Boot-time managed-project registry load must not crash the whole worker on one bad project

_Date: 2026-08-06_

Implements **Approach A** from `docs/superpowers/specs/issue-agentic-ops-engine-184-design.md`:
per-project skip-and-warn at the two layers where a single bad project currently aborts the whole
batch — the file parse/validation layer (`FileManagedProjectStore.readAll`) and the token-resolution
layer (`loadManagedProjectRegistry`). No contract change; `main.ts` needs no functional edit.

## Steps

### Step 1 — Isolate parse/validation failures per file in `FileManagedProjectStore.readAll()`

- **File:** `packages/activities/src/file-managed-project-store.ts` (`readAll()`, lines ~126–265).
- **Change:**
  - Keep `const entries = await readdir(this.dir)` and the `entrySet`/`byRepo`/`byLinearTeamKey`
    setup **outside** any new guard — a `readdir` failure (missing/unmounted dir) must still throw so
    it reaches the empty-registry fail-fast.
  - Keep the `PROJECT_FILE_PATTERN.exec(entry)` match + `continue` for non-project files outside the
    guard (a non-match is not an error, just a skip).
  - Wrap the **per-file body** — from YAML parse through building `managedProject` and inserting into
    `byRepo`/`byLinearTeamKey` — in a single `try/catch` inside the loop. On catch:
    `console.warn` one line naming the `entry`/`slug` and `(err as Error).message`, then `continue`.
    The inserts into `byRepo`/`byLinearTeamKey` must be inside the `try` so a project that fails
    partway (e.g. throws after the `byLinearTeamKey.set`) is never half-registered. Simplest structure:
    move the whole per-file body into the `try`, with both map `.set(...)` calls as the last
    statements, so a throw at any earlier point skips both inserts.
  - The inner `throw`s (bad YAML, missing fields, invalid JSON, `InvalidProjectConfigError`,
    `parseReadRepositories` failures) stay as-is; they now become the messages the outer catch warns
    on rather than propagating.
- **Verify:** `pnpm --filter @agentops/activities test file-managed-project-store` (new tests added in
  Step 3 must pass; existing tests still green).

### Step 2 — Isolate token-resolution failures per project in `loadManagedProjectRegistry()`

- **File:** `packages/activities/src/resolve-managed-projects.ts` (`loadManagedProjectRegistry()`,
  lines 123–135).
- **Change:** wrap the `const resolved = await resolveOne(deps, project.repo)` call (only) in
  `try/catch` inside the boot loop. On catch: `console.warn` naming `project.project`/`project.repo`
  and `(err as Error).message`, then `continue`. Leave `resolveManagedProjectEntry` /
  `resolveManagedProjectEntryByLinearTeamKey` (single-lookup request-time fns) untouched — a caller
  asking about one project should still see the real error.
- **Verify:** `pnpm --filter @agentops/activities test resolve-managed-projects` (new tests from
  Step 4 pass; existing single-lookup tests still surface errors).

### Step 3 — Tests for parse-layer isolation

- **File:** `packages/activities/src/file-managed-project-store.test.ts`.
- **Change:** add cases writing a temp dir containing one **valid** project plus, separately:
  (a) one malformed `<slug>__project.yaml` (unparseable YAML / missing `project`/`repo`/`tokenSecret`),
  and (b) one valid `__project.yaml` with an invalid `<slug>__agentops.json`. Assert `list()` returns
  exactly the valid project and `get()`/`getByProject()` for the bad slug returns `null`; assert the
  valid project is still returned. Add/confirm a case that `readdir` failure (nonexistent `dir`) still
  **rejects**. Optionally assert `console.warn` was called (spy) for the skipped file.
- **Verify:** `pnpm --filter @agentops/activities test file-managed-project-store` green.

### Step 4 — Tests for token-resolution-layer isolation

- **File:** `packages/activities/src/resolve-managed-projects.test.ts`.
- **Change:** add cases with a stub store whose `list()` returns two projects where (a) one's
  `resolveToken` rejects, and separately (b) one Linear project missing `linearTokenSecret`/whatever
  `resolveOne` requires. Assert `loadManagedProjectRegistry` resolves to only the healthy entry
  instead of rejecting. Confirm existing single-lookup tests (that assert errors propagate) are
  unchanged and still pass.
- **Verify:** `pnpm --filter @agentops/activities test resolve-managed-projects` green.

### Step 5 — Full gate

- **Change:** none (verification only).
- **Verify:** from repo root, `pnpm lint && pnpm typecheck && pnpm test`. Per AGENTS.md, `pnpm e2e`
  is required for changes touching activities — run `pnpm e2e` and confirm green. Manually confirm
  `packages/worker/src/main.ts` still compiles/behaves unchanged: the boot call at `:540` returns the
  healthy subset, and the in-cluster empty-registry fail-fast in `buildActivityDependencies`
  (`:166–174`) still fires only when the surviving set is empty.

## Sequencing notes

- **Step 1 (parse layer) before Step 2 (token layer)** deliberately: the parse layer is the first and
  most common failure point (`readAll` funnels every lookup), and de-risking it first makes the token
  layer's inputs already-filtered. The two are independent, though, and could be swapped without
  breaking anything.
- **Source before tests (Steps 1–2 before 3–4):** I paired each source change with its test in
  adjacent steps rather than writing all tests first, because these are behavior-change tests (the old
  behavior was "throw") — writing them against the current code would just assert the old throw. Each
  test step is run immediately after its source step to confirm the new skip-and-warn behavior.
- **Step 5 (full gate) last:** lint/typecheck/test/e2e across the workspace only makes sense once both
  source edits and both test additions are in place.
- **No `main.ts` step:** the design confirms `main.ts` needs no functional edit; Step 5 verifies this
  by observation rather than change.

## Assumptions

- **`console.warn` message shape.** The design specifies "one line naming the slug/reason" but not the
  exact string. I'll use the repo's existing skip-and-warn phrasing style (e.g.
  `FileManagedProjectStore: skipping "<entry>" (slug "<slug>"): <message>` and, for the loader,
  `loadManagedProjectRegistry: skipping "<project>" (<repo>): <message>`), matching the tier/refresh
  catches. Tests assert the skip **behavior** (project absent / healthy project present), not exact
  warn text, so wording stays flexible.
- **Map inserts belong inside the guard.** To avoid half-registering a project that throws after
  `byLinearTeamKey.set` but before completion, I put both `.set(...)` calls at the end of the guarded
  body so any earlier throw skips both. This is a stricter reading than "wrap the parse+validate" but
  is the only correct one and stays within the design's intent.
- **Temp-dir test harness.** `file-managed-project-store.test.ts` already reads a real directory; new
  cases reuse the same `mkdtemp`/write-fixture pattern already present in that file rather than
  introducing a new fs mock. No secrets in fixtures (`tokenSecret` is just a Secret *name* string).
- **e2e applicability.** AGENTS.md requires `pnpm e2e` for changes touching `activities`. This change
  is in `packages/activities`, so Step 5 runs it even though the change is boot-robustness only.
