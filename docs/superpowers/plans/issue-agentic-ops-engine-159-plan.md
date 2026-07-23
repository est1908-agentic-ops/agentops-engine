# Plan — issue-agentic-ops-engine-159: Linear vendor client constructed outside ports/ boundary

Date: 2026-07-23
Design: `docs/superpowers/specs/issue-agentic-ops-engine-159-design.md` (Approach A)

## Summary

Hard rule #4 ("Ports, not vendors") is violated because `packages/worker/src/main.ts:90`
constructs the concrete Linear vendor client (`new LinearGraphqlClient(...)`) outside `ports/`.
GitHub avoids this via `createGithubPorts(token, git)`, which hides all vendor construction inside
`packages/ports`. Linear lacks the equivalent factory.

Fix (Approach A): add a `createLinearTracker(token, fetchImpl?)` factory inside `ports/` that is the
single place `LinearGraphqlClient` is constructed, stop re-exporting the concrete vendor class from
the package barrel (keeping only the `LinearClient` / `LinearIssueData` types public), and rewire the
worker to call the factory. No behavior change — a structural/boundary fix.

## Files changed, in order

### Step 1 — New: `packages/ports/src/linear/build-linear-ports.ts`

Add the factory that confines Linear vendor construction inside `ports/`, mirroring
`build-github-ports.ts`:

```ts
import type { TrackerPort } from '../tracker-port';
import { LinearGraphqlClient } from './linear-client';
import { LinearTrackerPort } from './linear-tracker-port';

export function createLinearTracker(token: string, fetchImpl?: typeof fetch): TrackerPort {
  return new LinearTrackerPort(new LinearGraphqlClient(token, fetchImpl));
}
```

- Imports `LinearGraphqlClient` / `LinearTrackerPort` via relative paths (in-package, within the
  boundary — allowed).
- `fetchImpl` is optional and passed through to `LinearGraphqlClient`'s existing
  `fetchImpl: typeof fetch = fetch` default, so the factory stays unit-testable without network
  access and matches the vendor client's own signature. (When `fetchImpl` is `undefined`, pass it
  straight through — the client's default parameter handles it.)
- Returns the widened `TrackerPort` type, since Linear provides only a tracker in this system
  (SCM/git are always GitHub — see `main.ts:80-83`), so a GitHub-style `{ tracker }` wrapper would
  be an empty-looking shell.

**Verify:** `pnpm typecheck` compiles the new file with no errors (import paths resolve, return type
matches). Fully exercised by Step 2's test.

### Step 2 — New: `packages/ports/src/linear/build-linear-ports.test.ts`

Mirror `build-github-ports.test.ts` and `linear-client.test.ts`:

1. `createLinearTracker('fake-token')` returns a `LinearTrackerPort` instance (i.e. a `TrackerPort`)
   — proves construction wires the port and makes no network call (the `LinearGraphqlClient`
   constructor only stores the key/fetchImpl).
2. With an injected fake `fetchImpl` (a `vi.fn()` returning a canned Linear GraphQL issue payload,
   following `fakeFetch` in `linear-client.test.ts`), call `tracker.getIssue('linear:ENG-1')` and
   assert it resolves through the vendor client to the Linear GraphQL endpoint — the fake fetch is
   called with `https://api.linear.app/graphql` and the returned `Issue` reflects the payload. This
   confirms the factory wired the client into the port correctly.

Note the ref must be `linear:ENG-1` shape: `LinearTrackerPort.getIssue` runs it through
`requireLinearRef` (`parseTrackerRef`), which requires the `linear:` prefix.

**Verify:** `pnpm --filter @agentops/ports test` (or `pnpm test`) — both cases green.

### Step 3 — Edit: `packages/ports/src/index.ts`

Enforce the boundary at compile time by removing the concrete vendor class from the public surface:

- Replace line 14 `export * from './linear/linear-client';` with a type-only re-export:
  `export type { LinearClient, LinearIssueData } from './linear/linear-client';`
  (drops `LinearGraphqlClient` from the barrel; keeps the harmless types that callers/tests may
  reference).
- Add `export * from './linear/build-linear-ports';`.
- Leave line 15 (`export * from './linear/linear-tracker-port';`) as-is — `LinearTrackerPort` is a
  port, not a vendor client; keeping it exported is harmless and the worker stops importing it anyway.

**Verify:** `pnpm typecheck` across the workspace. After this step, any remaining
`LinearGraphqlClient` import from `@agentops/ports` (e.g. the not-yet-edited worker) will fail to
compile — that expected failure is what Step 4 resolves, and confirms the boundary is now enforced.
Also confirm `linear-client.test.ts` still compiles: it imports `LinearGraphqlClient` via the
relative path `./linear-client` (in-package), which is untouched.

### Step 4 — Edit: `packages/worker/src/main.ts`

Rewire the worker to the factory:

- In the `@agentops/ports` import block (lines 44-54), remove `LinearGraphqlClient` and
  `LinearTrackerPort`, add `createLinearTracker`.
- Change line 90 from
  `const tracker = new LinearTrackerPort(new LinearGraphqlClient(entry.linearToken));`
  to
  `const tracker = createLinearTracker(entry.linearToken);`
- Leave the surrounding `entry.trackerType !== 'linear'` branch and the `linearToken`-missing guard
  (lines 84-91) unchanged — the guard is a worker-wiring concern tied to the registry entry.

**Verify:** `pnpm typecheck` clean (the Step 3 expected failure now resolves).
`pnpm --filter @agentops/worker test` — `main.test.ts` still passes (it only asserts a linear entry
produces a non-`Memory` tracker/scm, which still holds).

### Step 5 — Full definition-of-done gate

Run the repo's required checks.

**Verify:**
- `pnpm lint && pnpm typecheck && pnpm test` — all green.
- `pnpm e2e` — green (change touches `ports` + worker wiring; run per hard rule #6).
- Grep check: `rg 'LinearGraphqlClient' packages/worker` returns nothing, and
  `rg 'new LinearGraphqlClient' packages` returns only `build-linear-ports.ts` (and the in-package
  `linear-client.test.ts`) — confirming vendor construction is confined to `ports/`.

## Sequencing rationale

The order is deliberately **create the factory + its test first (Steps 1–2)**, then **remove the
export (Step 3)**, then **rewire the worker (Step 4)**:

- Steps 1–2 are purely additive and independently verifiable — the factory and its test pass before
  anything else changes, de-risking the core of the change.
- Step 3 (un-export) is placed before Step 4 intentionally: it produces a *known, expected* compile
  failure in the still-old worker, which is direct evidence that the boundary is now enforced at
  compile time (the whole point of the bughunt). Step 4 immediately resolves it.
- **Could Steps 3 and 4 be reordered?** Yes — rewiring the worker first would avoid the transient
  broken typecheck. I did not, because seeing the un-export break the old call site is the clearest
  confirmation the fix is structural, not cosmetic. The transient state is never committed (a single
  commit covers the whole change), so there is no risk.

## Assumptions (resolved without human input)

All open questions are settled by the design doc (Approach A); restated here as the decisions this
plan implements:

- **Factory shape:** `createLinearTracker(token: string, fetchImpl?: typeof fetch): TrackerPort` —
  a single-port factory returning `TrackerPort`, not a GitHub-style `{ tracker }` object, because
  Linear has no SCM in this system. `fetchImpl` is an optional passthrough for testability, mirroring
  `LinearGraphqlClient`'s constructor.
- **Exports:** keep `LinearClient` / `LinearIssueData` types exported from the barrel; drop only the
  concrete `LinearGraphqlClient` class (mirrors GitHub keeping `GithubClient` public but
  `createGithubClient` private). `LinearGraphqlClient` remains a module-level export of
  `linear-client.ts` so the factory and existing `linear-client.test.ts` can import it via relative
  path within the package.
- **No contract/behavior change:** `ResolvedProjectEntry`, `parseTrackerRef` routing,
  `createProjectScopedPorts`, and the worker's `linearToken`-missing guard are untouched. No SLDS or
  README update required (the boundary rule is being enforced, not altered), and no new contract is
  introduced.
- **Single commit:** the whole change ships as one `fix:` commit, so the transient typecheck break
  between Steps 3 and 4 is never a committed state.
