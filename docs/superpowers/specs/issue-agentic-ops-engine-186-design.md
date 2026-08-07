# Design — Task issue-agentic-ops-engine-186

**Goal:** `loadManagedProjectRegistry` redundantly re-scans the whole project directory per project, and can silently drop a project with no warning.

## Background / the bug

`loadManagedProjectRegistry` (`packages/activities/src/resolve-managed-projects.ts`) is the boot-time function the worker uses to build ports for every registered repo. It currently does:

```
const managedProjects = await deps.store.list();   // full scan #1
for (const project of managedProjects) {
  const resolved = await resolveOne(deps, project.repo);  // resolveOne → store.get(project.repo) → full scan #N
  ...
}
```

Two concrete defects flow from re-fetching each project by repo instead of using the object `list()` already returned:

1. **Redundant re-scans.** For the `FileManagedProjectStore` (the production ConfigMap-directory store), every `store.get(repo)` calls `load()` → `readAll()`, which `readdir`s the directory and re-reads + re-parses *every* project file. So loading N projects performs **N+1 full directory scans** (one `list()` plus one `get()` per project), re-parsing every YAML/JSON file O(N) times — quadratic file I/O at worker/gateway boot for something the initial `list()` already fully materialized.

2. **Silent project drop.** In the loop, `resolveOne` calls `store.get(project.repo)` a second time and passes the result to `buildResolvedEntry`, which returns `null` when the project is not found. `resolveOne` returns that `null`, and the loop's `if (resolved)` guard skips it **with no warning** — the `try/catch` only logs on a *thrown* error, not on a `null` return. Because `get()` re-reads the directory independently of the earlier `list()`, a project present in the `list()` snapshot can be absent in the later per-project `get()` snapshot (e.g. Kubernetes updating the projected ConfigMap volume in place mid-load, per the store's own "each lookup reads the directory again" contract). The project then vanishes from the registry silently — the exact failure mode #184's isolation work was meant to make observable, but this path routes around it.

Both defects share one root cause: the loop discards the fully-formed `ManagedProject` objects returned by `list()` and re-derives them by key.

## Candidate approaches

### A. Resolve directly from the `list()` results (recommended)

Change `loadManagedProjectRegistry` to call `buildResolvedEntry(deps, project)` on each `ManagedProject` already returned by `store.list()`, instead of `resolveOne(deps, project.repo)` (which re-fetches). `buildResolvedEntry` already accepts a `ManagedProject | null` and does the tracker-type/token-resolution work; the per-project entries from `list()` are always non-null, so the re-fetch adds nothing but I/O and a null-drop hazard.

- **Pros:** One `list()` scan total (removes the N extra `get()` scans). The registry is built from a single consistent snapshot, eliminating the mid-load-inconsistency drop. Minimal, localized change; the existing per-project `try/catch` skip-and-warn behavior (from #184) is preserved unchanged. No store-interface change, so all `ManagedProjectStore` implementations benefit.
- **Cons:** `resolveOne` becomes used only by the single-lookup path (`resolveManagedProjectEntry`), which is fine — that's its remaining legitimate caller.

### B. Memoize / cache `readAll()` inside `FileManagedProjectStore`

Cache the parsed directory map so repeated `get()`/`list()` calls within a short window reuse one scan.

- **Pros:** Speeds up the redundant scans without touching the caller.
- **Cons:** Directly contradicts the store's documented design ("Read-only and refreshable: each lookup reads the directory again … fresh reads preferable to stale caching" so Kubernetes ConfigMap updates are observed without a rollout). Introduces cache-invalidation/staleness questions across worker and gateway. Does **not** fix the silent-drop defect — a `get()` returning null still silently drops. Only masks the redundancy at request time. Larger blast radius for a narrower fix.

### C. Add a batch `resolveAll` / bulk method to `ManagedProjectStore`

Extend the store interface with a method that returns fully resolved entries in one pass.

- **Pros:** Conceptually clean single call.
- **Cons:** Over-engineering: `list()` already returns everything needed; resolution (token lookup) is a caller/`deps` concern, not a store concern, and pushing it into the store would blur the ports/store boundary. Requires changing the contract interface and every implementation. Rejected as disproportionate to a bug fix.

## Recommendation

**Approach A.** It fixes both defects at their shared root cause with the smallest, most local change, keeps the store's deliberate fresh-read semantics intact, and requires no contract/interface change. B is rejected because it fights the store's design and doesn't fix the silent drop; C is rejected as an over-scoped interface change for something `list()` already provides.

## What changes and why

- **`packages/activities/src/resolve-managed-projects.ts`**
  - In `loadManagedProjectRegistry`, resolve each project via `buildResolvedEntry(deps, project)` using the `ManagedProject` already returned by `deps.store.list()`, rather than `resolveOne(deps, project.repo)`. This removes the redundant per-project `store.get()` re-scan and the mid-load-inconsistency null-drop path.
  - Because `buildResolvedEntry` returns `null` only for a `null` input and `list()` entries are non-null, the resolved value is now always a real entry on the success path. Keep the existing `try/catch` skip-and-warn (from #184) for token-resolution/validation failures. As defensive belt-and-suspenders against the "silently drop with no warning" symptom, log a warning if a resolved entry unexpectedly comes back `null` instead of dropping it silently — so no project can ever leave the registry without a log line explaining why.
  - `resolveOne` remains for the single-lookup path (`resolveManagedProjectEntry`), which legitimately needs a by-repo `get()`.

- **`packages/activities/src/resolve-managed-projects.test.ts`**
  - Existing `loadManagedProjectRegistry` tests (resolve-all, canonicalization, readRepositories propagation, skip-on-token-failure with warning, skip Linear-missing-secret with warning, single-lookup still throws) must continue to pass unchanged — they assert behavior this change preserves.
  - Add a regression test asserting the load performs a single `store.list()` and **no** per-project `store.get()` calls (e.g. spy on a store's `get`/`list`, or count `readAll`/`readdir` invocations on a `FileManagedProjectStore`), proving the redundant re-scan is gone.
  - Add a regression test that no project is dropped without a warning: with a store whose `list()` returns a project that `get()` would not (simulating the mid-load inconsistency), the resolved entry is still produced from the `list()` snapshot — demonstrating the snapshot-consistent load.

No production behavior visible to consumers changes on the happy path (the returned registry contents are identical); this is a performance + observability correctness fix.

## Assumptions

- **Scope is the registry-load path only, not the store's fresh-read contract.** The issue is about `loadManagedProjectRegistry`'s redundant scanning and silent drop, not the store's per-lookup refresh design. I resolved this by fixing only the caller and leaving `FileManagedProjectStore`'s fresh-read-per-lookup semantics untouched (approach A over B).
- **Building from the `list()` snapshot is the desired consistency model for boot-time load.** A single consistent snapshot is preferable to per-project re-reads that can disagree with each other. I assume atomicity within one `list()` is correct for boot-time port construction; the store is explicitly described as refreshed on later lookups, so a subsequent ConfigMap change is picked up by later request-time lookups, not by this one boot-time call.
- **The silent-drop path is currently reachable and worth closing defensively.** Even though after this change the success path never yields a `null` entry, I add a warn-on-null guard so the "silently drop a project" symptom named in the issue is impossible by construction going forward.
- **No contract/interface change is warranted.** `ManagedProjectStore` stays as-is; `list()` already returns everything resolution needs.

## Self-review

- No placeholders; all named files and functions exist and were read.
- No contradictions: the recommendation, changes, and assumptions all consistently pick approach A and preserve the #184 skip-and-warn behavior.
- Single coherent change: one caller function fixed plus its tests; both the redundant-scan and silent-drop defects share the same root cause and are addressed together.

## Brainstorm Summary
**Approaches considered:** (A) resolve each project from the `ManagedProject` objects `store.list()` already returns; (B) cache/memoize `readAll()` inside `FileManagedProjectStore`; (C) add a bulk `resolveAll` method to the store interface.
**Chosen approach:** A — build the registry directly from the single `list()` snapshot via `buildResolvedEntry`, dropping the redundant per-project `store.get()` re-scan.
**Why (decisive reasons):** Fixes both the N+1 quadratic re-scan and the silent mid-load project drop at their shared root cause with one local change; keeps the store's deliberate fresh-read semantics (B fights that design and doesn't fix the drop); needs no contract change (C is over-scoped).
**Key risks/assumptions:** Boot-time load should use one consistent `list()` snapshot; the store's per-lookup refresh contract stays unchanged; a warn-on-null guard makes silent drops impossible by construction; existing #184 skip-and-warn tests must stay green.
