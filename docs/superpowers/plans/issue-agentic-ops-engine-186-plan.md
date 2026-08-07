# Plan — Task issue-agentic-ops-engine-186

**Goal:** `loadManagedProjectRegistry` redundantly re-scans the whole project directory per project, and can silently drop a project with no warning.

**Design:** `docs/superpowers/specs/issue-agentic-ops-engine-186-design.md` — Approach A: build the registry directly from the single `store.list()` snapshot via `buildResolvedEntry(deps, project)`, dropping the redundant per-project `resolveOne`/`store.get()` re-scan. No store/contract interface change. Preserve the #184 per-project skip-and-warn behavior, and add a warn-on-null guard so no project can ever leave the registry without a log line.

Files touched, in order:
1. `packages/activities/src/resolve-managed-projects.ts` (production fix)
2. `packages/activities/src/resolve-managed-projects.test.ts` (regression tests)

## Steps

### Step 1 — Fix `loadManagedProjectRegistry` to resolve from the `list()` snapshot

**File:** `packages/activities/src/resolve-managed-projects.ts`

**Change:** In `loadManagedProjectRegistry`, iterate the `ManagedProject` objects already returned by `deps.store.list()` and resolve each via `buildResolvedEntry(deps, project)` instead of `resolveOne(deps, project.repo)`. This removes the extra per-project `store.get()` re-scan and the mid-load-inconsistency null path.

Keep the existing per-project `try/catch` skip-and-warn (from #184) around each `buildResolvedEntry` call for token-resolution/validation failures. Because `list()` entries are non-null, `buildResolvedEntry` returns a real entry on the success path; still, replace the silent `if (resolved) push` drop with an explicit warn-on-null guard so a `null` (which should be unreachable from a non-null input) logs a `loadManagedProjectRegistry: skipping "<project>" (<repo>): ...` warning rather than vanishing silently. Leave `resolveOne`, `resolveManagedProjectEntry`, `resolveManagedProjectEntryByLinearTeamKey`, and `buildResolvedEntry` otherwise unchanged — `resolveOne` remains the single-lookup path's `store.get()` helper.

**Verify:**
- `pnpm --filter @agentops/activities test -- resolve-managed-projects` — the existing `loadManagedProjectRegistry` suite (resolve-all, canonicalization, readRepositories propagation, skip-on-token-failure with warning, skip Linear-missing-secret with warning, and the single-lookup-still-throws case) must stay green unchanged, confirming the happy-path registry contents and the #184 skip-and-warn behavior are preserved.
- `pnpm typecheck` — `buildResolvedEntry` accepts `ManagedProject | null`; passing a `ManagedProject` from `list()` must type-check with no `any`/casts.

### Step 2 — Regression test: no redundant per-project re-scan

**File:** `packages/activities/src/resolve-managed-projects.test.ts`

**Change:** Add a test under the `loadManagedProjectRegistry` describe block that proves the load performs exactly one directory scan. Construct a `FileManagedProjectStore` over a temp dir with ≥2 project files, spy on the store's `get` method (`vi.spyOn(store, 'get')`) and its `list` method, run `loadManagedProjectRegistry`, and assert `list` was called once and `get` was **not** called (`expect(getSpy).not.toHaveBeenCalled()`). This directly asserts the redundant re-scan is gone (before the fix, `get` was called once per project).

**Verify:** `pnpm --filter @agentops/activities test -- resolve-managed-projects` — new test fails against the pre-fix code (guards against regression) and passes with Step 1 applied. Sanity-check the "fails before" claim by reasoning against the original loop (which called `resolveOne` → `store.get` per project); optionally confirm by temporarily reverting Step 1 locally.

### Step 3 — Regression test: snapshot-consistent load never silently drops a project

**File:** `packages/activities/src/resolve-managed-projects.test.ts`

**Change:** Add a test that simulates the mid-load inconsistency where a project present in the `list()` snapshot would be absent from a later per-project `get()`. Use a hand-rolled stub `ManagedProjectStore` (not the file store) whose `list()` returns one fully-formed `ManagedProject` but whose `get()` returns `null`. Run `loadManagedProjectRegistry` with a passthrough `resolveToken`; assert the resolved entry is still produced from the `list()` snapshot (the project is **not** dropped), and assert `get` was not consulted. This demonstrates the load is built from the single consistent snapshot and the silent-drop path is closed.

The stub must satisfy the `ManagedProjectStore` interface (`get`, `getByProject`, `getByLinearTeamKey`, `list`); unused methods can throw or return `null`. Build the `ManagedProject` literal to match the contract shape (mirror the `baseFields` + `trackerType: 'github'` shape the file store produces).

**Verify:** `pnpm --filter @agentops/activities test -- resolve-managed-projects` — new test passes with Step 1; it would fail against pre-fix code (the old loop re-fetches via `get()` → `null` → silently skipped).

### Step 4 — Full gate

**Change:** none beyond Steps 1–3.

**Verify (repo definition-of-done, from AGENTS.md):**
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- e2e (`pnpm e2e`) is applicable because `packages/activities` is touched; run it and confirm green. If the environment cannot run e2e (no Temporal test server), record that limitation here and rely on the unit + typecheck + lint gate, since this change is a local, non-workflow activity fix with no new I/O or contract surface.

## Sequencing notes

- **Production fix (Step 1) before tests (Steps 2–3).** The fix is the de-risking step: it's a one-function change whose correctness the existing suite already largely pins down, so applying it first lets Step 1's verification (existing tests stay green) immediately confirm no behavior regressed before new tests are layered on. The new regression tests in Steps 2–3 assert the *absence* of the old behavior (no `get()` re-scan; no silent drop), so they are written to pass against the fixed code; I note in each how they'd fail against the pre-fix code to confirm they actually guard the regression.
- **Steps 2 and 3 are independent** and could be written in either order; I kept re-scan (2) before silent-drop (3) to match the two defects in issue order. Neither depends on the other.
- **Alternative considered:** writing the failing tests first (TDD red) against the current code. I did not, because the existing `loadManagedProjectRegistry` suite already covers the happy path and skip-and-warn semantics that must be preserved; running it against the fix is the primary safety check, and the two new tests are targeted additions best expressed against the intended post-fix behavior.

## Assumptions

- **`vi.spyOn(store, 'get')` on a `FileManagedProjectStore` instance is the cleanest way to assert "no re-scan."** The design suggested either spying on `get`/`list` or counting `readAll`/`readdir`. I chose spying on the public `get`/`list` methods because they are the store's contract surface and don't reach into private internals (`readAll`/`load` are private); this keeps the test coupled to behavior, not implementation.
- **The silent-drop regression test uses a hand-rolled stub store, not the file store.** Reliably forcing a `FileManagedProjectStore` to have `list()` and `get()` disagree would require racing a mid-load filesystem mutation, which is flaky. A stub whose `list()`/`get()` deliberately disagree deterministically reproduces the exact inconsistency the design describes, without timing races.
- **The warn-on-null guard is defensive and unreachable on the success path.** After Step 1, `buildResolvedEntry` only returns `null` for a `null` input, and `list()` yields non-null entries, so the guard should never fire in practice. I still add it (per the design) so the issue's "silently drop a project with no warning" symptom is impossible by construction. I do not add a dedicated test that forces this specific null branch (it's unreachable via the real store); the guard is belt-and-suspenders, and Step 3 already covers the snapshot-consistency guarantee that makes drops observable.
- **e2e may be unrunnable in this environment.** If `pnpm e2e` cannot start (no Temporal test server), I will record that and rely on lint + typecheck + unit tests, given the change is a self-contained activity-layer fix with no workflow, contract, or new-I/O surface.
