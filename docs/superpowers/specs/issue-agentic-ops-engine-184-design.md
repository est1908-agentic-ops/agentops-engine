# Design — issue-agentic-ops-engine-184: Boot-time managed-project registry load must not crash the whole worker on one bad project

_Date: 2026-08-06_

## Goal

At worker boot, the managed-project registry is loaded once to pre-build ports for every registered
repo. Today a **single** malformed or misconfigured project aborts the entire load, which propagates
to `main()`'s top-level `.catch` and `process.exit(1)` — taking down every healthy project with it.
The goal is to isolate failures per project: skip the bad one(s), log loudly, and boot the worker
with the projects that _are_ valid. The existing, intentional "an **empty** in-cluster registry is
fatal" invariant must be preserved (an all-bad in-cluster registry is a genuine total misconfig and
should still fail fast).

## Background — where it breaks today

A "bad project" can fail at two independent layers, and **both** currently abort the whole batch:

1. **Parse / validation layer** — `FileManagedProjectStore.readAll()`
   (`packages/activities/src/file-managed-project-store.ts:126-265`). Every `<slug>__project.yaml`
   (and optional `<slug>__agentops.json`) is parsed and validated eagerly inside one loop that
   `throw`s on the first invalid file (bad YAML, missing `project`/`repo`/`tokenSecret`, invalid
   `readRepositories`, invalid config JSON, or a zod `InvalidProjectConfigError`). Because
   `get()` / `getByProject()` / `getByLinearTeamKey()` / `list()` all funnel through `readAll()`, a
   bad file for project B also breaks lookups for healthy project A — at boot **and** at request
   time (gateway webhooks, task start).

2. **Token-resolution layer** — `loadManagedProjectRegistry()`
   (`packages/activities/src/resolve-managed-projects.ts:123-135`). Even when every file parses, the
   boot loop calls `resolveOne` → `buildResolvedEntry` per project with no per-project try/catch. A
   project whose Kubernetes Secret is missing/unreadable, whose Secret lacks the requested key, or a
   Linear project missing `linearTokenSecret`/`tokenSecret`, throws and aborts loading of all
   remaining projects.

Both throw sites bubble up through `main()` (`packages/worker/src/main.ts:540`, unguarded) to
`main().catch(... process.exit(1))` (`:717-722`).

Notably the **60s refresh** path is already resilient at the whole-batch level
(`main.ts:557-562`: `refresh().catch(console.warn(...'keeping previous wiring'))`), but it is still
all-or-nothing: one bad project makes the entire refresh fail and freezes updates for every other
project until it is fixed. The same per-project isolation this design adds to boot therefore also
improves refresh.

## Approaches considered

### Approach A — Per-project isolation at both layers (skip + warn), no contract change _(recommended)_
Make each layer tolerate a single bad project instead of aborting the batch:
- `FileManagedProjectStore.readAll()`: wrap the **per-file** body (parse + validate) in try/catch;
  on error, `console.warn` with the slug/reason and `continue` to the next file. The `readdir` call
  itself stays outside the try/catch — a missing/unmounted directory is a whole-registry failure, not
  a per-project one, and must still surface (it flows into the existing empty-registry fail-fast).
- `loadManagedProjectRegistry()`: wrap each `resolveOne(...)` in try/catch; on error, `console.warn`
  with the project/repo and reason, and skip that entry.

- **Trade-off:** puts `console.warn` skip-logging into the `activities` package rather than the boot
  file, and silently changes `list()`/`get()` semantics for _all_ callers (a bad project becomes
  "absent" rather than an error). Mitigated because skip-and-warn is already this repo's established
  resilience idiom (tier refresh, search-attributes, reconcile/self-heal schedules, and the managed-
  project refresh all `catch → console.warn → keep going`), and because the semantic change is a
  strict improvement — an unrelated bad file no longer breaks a healthy lookup for the gateway either.
- **Cost:** small. Two functions edited plus tests. No new packages, no contract change.

### Approach B — Structured partial result (`{ entries, skipped[] }`) surfaced to the caller
Have the load return valid entries alongside a structured list of `{ slug/project, reason }` skips;
the boot code in `main.ts` logs them. To catch parse-layer failures this requires `readAll()` to
collect per-file errors instead of throwing, which means either changing the shared
`ManagedProjectStore` interface (`packages/contracts/src/managed-project-store.ts`) or adding a new
method — and then mirroring the treatment in the Postgres-backed store implementation.

- **Trade-off:** cleaner separation (store stays log-free, caller decides) and more directly testable
  ("which were skipped"), but it expands a shared contract and forces parallel work in the DB store
  for no boot-time benefit.
- **Cost:** medium; widest blast radius; arguably more than one coherent change.

### Approach C — Coarse boot-level fallback (wrap the whole load in try/catch in `main.ts`)
Wrap `loadManagedProjectRegistry` at `main.ts:540` in a try/catch and fall back to an empty registry
on any failure.

- **Trade-off:** still all-or-nothing — one bad project wipes out **all** projects (empty registry →
  in-cluster fatal path fires anyway). It does not isolate anything and does not meet the goal.
- **Cost:** trivial, but wrong.

## Chosen approach

**Approach A.** It is the only option that actually isolates a _single_ bad project at both layers
where the failure originates, and it fixes the request-time variant (gateway/lookup) as a free side
effect. Approach C is rejected because it does not isolate — it converts "one bad project" into "no
projects," which in-cluster is still fatal. Approach B is rejected for this bug because its extra
value (structured skip data, log-free store) is not needed to satisfy the goal and it drags in a
shared-contract change plus parallel Postgres-store work, exceeding the scope of a targeted bug fix.
The skip-and-warn idiom Approach A uses is already pervasive in this codebase's boot/refresh paths, so
it is consistent rather than novel.

## Design

Scope: one coherent change — "make managed-project registry loading tolerate a single bad project."

### Components / files affected

1. **`packages/activities/src/file-managed-project-store.ts` — `readAll()`** (Layer 1)
   - Factor the per-file work (regex match already skips non-project entries; then parse YAML,
     validate required fields, parse optional `__agentops.json` config, build the `ManagedProject`)
     so it can be guarded per file.
   - Wrap that per-file body in try/catch. On failure: `console.warn` a single line naming the file
     (`entry`) / slug and the underlying message, then `continue`. Do **not** add the entry to
     `byRepo`/`byLinearTeamKey`.
   - Keep `readdir(this.dir)` outside the guard so directory-level failures (mount missing) still
     throw and reach the empty-registry fail-fast.
   - Consequence (intended): `list()`/`get()`/`getByLinearTeamKey()`/`getByProject()` now silently
     omit unparseable projects instead of throwing. A lookup for a _healthy_ project no longer fails
     because some _other_ project's file is malformed; a lookup for the _bad_ project returns `null`
     (treated as "not managed"), which the gateway already handles as "ignore this webhook."

2. **`packages/activities/src/resolve-managed-projects.ts` — `loadManagedProjectRegistry()`** (Layer 2)
   - Wrap the per-project `resolveOne(deps, project.repo)` call in try/catch. On failure:
     `console.warn` naming the project/repo and the reason (missing Secret, missing key, missing
     `linearTokenSecret`, etc.), then skip that project and continue the loop.
   - `resolveManagedProjectEntry` / `resolveManagedProjectEntryByLinearTeamKey` (the single-lookup,
     request-time functions) are left unchanged: a caller asking about one specific project should
     still see the real error, since there is nothing else to isolate it from.

3. **`packages/worker/src/main.ts`** — no functional change required. The boot call at `:540` now
   returns the healthy subset. The existing empty-registry fail-fast in `buildActivityDependencies`
   (`:166-174`) still fires when the surviving registry is empty in-cluster (i.e. _every_ project was
   bad — a real total misconfig). The `console.log` at `:567-574` will naturally report the reduced
   count. (Optional, non-essential: a one-line boot summary of how many projects were skipped; left
   out to keep the change minimal since each skip is already warned individually.)

4. **Tests** (co-located, vitest):
   - `file-managed-project-store.test.ts`: a directory containing one malformed `__project.yaml` (and
     separately one invalid `__agentops.json`) **plus** one valid project now yields exactly the valid
     project from `list()`/`get()` rather than throwing; assert the bad slug is absent. Assert
     `readdir` failure (nonexistent dir) still rejects.
   - `resolve-managed-projects.test.ts`: with a stub store returning two projects where one
     `resolveToken` rejects (and, separately, one Linear project missing `linearTokenSecret`),
     `loadManagedProjectRegistry` returns only the healthy entry instead of rejecting. Existing
     single-lookup tests remain unchanged (they still surface errors).

### Data flow (after)

`boot → loadManagedProjectRegistry(deps)`
  → `store.list()` → `readAll()` parses each file, **skipping + warning** on any bad file →
  returns only parseable `ManagedProject`s
  → loop resolves each; **skipping + warning** on any token/field failure →
  returns only fully-resolved `ResolvedProjectEntry[]`
  → `buildActivityDependencies(...)`: if the surviving list is empty **and** in-cluster → still throws
  (unchanged invariant); otherwise builds wiring for the healthy projects and the worker boots.

### Error handling & logging

- Idiom: `console.warn` per skipped project, mirroring the existing refresh/tier/schedule catches, so a
  genuinely broken project is visible in logs without blocking startup.
- Whole-registry / infrastructure errors (directory not mounted, `readdir` failure) are **not**
  swallowed — they remain throws and route into the intentional empty-registry fail-fast.
- Accepted trade-off: because `FileManagedProjectStore` re-reads the directory on every lookup (no
  cache), a persistently-bad file will emit a warn on each request-time read (e.g. every gateway
  webhook), not just once at boot. This is noisy but acceptable and strictly better than crashing;
  de-duplicating these warns is explicitly out of scope for this fix.

## Assumptions

- **Skip-and-warn vs. hard-fail for a bad project.** The issue title is explicit that one bad project
  must not crash the worker, so the correct behavior is to skip it and boot the healthy ones. I assume
  losing one project's coverage (until its config/Secret is fixed) is preferable to losing all
  coverage — consistent with every other boot-resilience path in `main.ts`.
- **Empty-registry invariant stays.** I assume the existing in-cluster "empty registry is fatal" guard
  (`buildActivityDependencies`, `main.ts:166-174`) is deliberate and must be preserved. Skipping bad
  projects can legitimately drive the surviving set to empty; when it does in-cluster, failing fast is
  still correct.
- **`console.warn` in the `activities` package is acceptable.** The repo already logs at the boot/
  resilience layer via `console.*`; I assume extending that one level down into the store/loader (as
  opposed to threading a logger or returning structured skip data — Approach B) is acceptable for this
  bug and does not warrant a contract change.
- **Request-time semantic change is desired, not just tolerated.** Making `readAll()` per-file
  resilient also stops one bad project from breaking gateway lookups for other projects. I assume this
  side effect is wanted (it is the same "one bad project shouldn't hurt others" principle) rather than
  something to guard against.
- **No SLDS impact.** Per AGENTS.md this is a boot-robustness bug fix, not a change to the Software
  Lifecycle Development System's lifecycle or principles; it aligns with the SLDS and does not require
  updating it.

## Self-review

- No placeholders or TBDs.
- No contradictions: the empty-registry fail-fast is preserved in every section; the "skip + warn"
  behavior is applied consistently at both layers; request-time behavior change is called out as
  intended in both the Design and Assumptions.
- Scope: one coherent change (per-project isolation in registry loading). It touches two source
  functions in `packages/activities` plus their tests; `main.ts` needs no functional edit. No contract
  or DB-store changes are pulled in.

## Brainstorm Summary
**Approaches considered:** (A) isolate each bad project at both the file-parse layer and the token-resolution layer with skip-and-warn, no contract change; (B) return a structured `{ entries, skipped[] }` partial result, which requires widening the shared `ManagedProjectStore` contract and mirroring it in the Postgres store; (C) a coarse boot-level try/catch that falls back to an empty registry.
**Chosen approach:** A — per-project skip-and-warn in `FileManagedProjectStore.readAll` and `loadManagedProjectRegistry`.
**Why (decisive reasons):** Only A actually isolates a *single* bad project (C collapses to "no projects," which in-cluster is still fatal; B drags in a shared-contract + DB-store change for value this bug doesn't need). A reuses the repo's existing boot-resilience idiom and fixes the request-time/gateway variant for free.
**Key risks/assumptions:** `list()`/`get()` now silently omit unparseable projects instead of throwing (intended, strictly better); the intentional in-cluster empty-registry fail-fast is preserved; `console.warn` in the `activities` package is acceptable; a persistently-bad file warns on every re-read (noisy but acceptable, de-dup out of scope).
