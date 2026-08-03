# Design — issue-agentic-ops-engine-159: Linear vendor client constructed outside ports/ boundary

Date: 2026-07-23

## Goal

Hard rule #4 in `AGENTS.md` is "Ports, not vendors — nothing outside `ports/` may import a
forge/tracker SDK or call their APIs." The Linear integration violates this: the worker's
composition root constructs the concrete Linear vendor client itself.

At `packages/worker/src/main.ts:90`:

```ts
const tracker = new LinearTrackerPort(new LinearGraphqlClient(entry.linearToken));
```

`LinearGraphqlClient` is the vendor client — a hand-rolled GraphQL client (this repo does not use
`@linear/sdk`) that talks to `https://api.linear.app/graphql`. Constructing it in `packages/worker`
means the code that "calls Linear's API" is being wired together outside `ports/`, which is the
breach. GitHub does this correctly: `createGithubPorts(token, git)` keeps all vendor construction
(`new Octokit`, `graphql.defaults`) private inside `packages/ports/src/github/build-github-ports.ts`;
the worker only passes a token. Linear simply lacks the equivalent factory.

The goal is to confine all Linear vendor-client construction inside `ports/` by giving Linear a
factory mirroring `createGithubPorts`, and to remove the public export that lets the vendor client
be reached from outside the package. This is a structural/boundary fix; no behavior changes.

## Approaches considered

### A. Add a `createLinearTracker(token)` factory in `ports/`, un-export the vendor client (recommended)

Add `packages/ports/src/linear/build-linear-ports.ts` exporting `createLinearTracker(token, fetchImpl?)`,
which internally does `new LinearTrackerPort(new LinearGraphqlClient(token))` and returns a
`TrackerPort`. Stop re-exporting the concrete `LinearGraphqlClient` class from the package barrel
(`index.ts`), keeping only the `LinearClient` / `LinearIssueData` types and the new factory public.
The worker calls `createLinearTracker(entry.linearToken)` and no longer imports `LinearGraphqlClient`
or `LinearTrackerPort`.

- **Trade-off / cost:** Small, symmetric with GitHub. Touches one new file (+ its test), the ports
  barrel, and one line in the worker. Also enforces the boundary at compile time — after un-exporting
  the vendor class, no code outside `ports/` can even name it, so the violation can't silently
  reappear.

### B. Move only the construction into a private worker helper, keep exports as-is

Wrap `new LinearTrackerPort(new LinearGraphqlClient(...))` in a local helper inside `main.ts`. Tidier
call site but the vendor client is still constructed in `packages/worker` and still publicly exported
from `@agentops/ports`. This does not fix the rule-#4 violation at all — it just relocates it a few
lines. Rejected.

### C. Registry-driven unified port factory (`createPortsForEntry(entry, git)`)

Introduce one factory in `ports/` that takes a `ResolvedProjectEntry` and returns the fully-wired
`{ scm, tracker }` for both GitHub and Linear entries, absorbing the `trackerType` branch currently
in `buildActivityDependencies`. Cleanest long-term composition root, but it's a larger refactor:
it pulls the `ResolvedProjectEntry` contract and the `entry.trackerType`/`linearToken`-missing guard
into `ports/`, changes the GitHub wiring path too, and rewrites more of the worker + its tests. More
surface than the bug warrants. Rejected for scope, though A leaves the door open to it later.

## Chosen approach

**Approach A.** It is the minimal change that actually satisfies hard rule #4, and it makes the Linear
adapter structurally identical to the GitHub adapter (a factory that hides vendor construction behind
a token argument). Un-exporting `LinearGraphqlClient` turns the fix from "moved the offending line" into
"the offending line can no longer be written outside `ports/`," which is the real intent of a bughunt
against the boundary. B doesn't fix the violation; C is correct but over-scoped for this issue.

## Assumptions

- **Factory name and shape.** Named `createLinearTracker(token, fetchImpl?)` returning a `TrackerPort`,
  rather than a GitHub-style `createLinearPorts(token)` returning `{ tracker }`. Rationale: Linear only
  provides a tracker in this system (SCM/git are always GitHub, per the Linear-trigger design and the
  comment at `main.ts:81-83`), so a `{ tracker }` wrapper object would be an empty-looking shell. A
  single-port factory reads more honestly. The optional `fetchImpl` passthrough mirrors
  `LinearGraphqlClient`'s existing `fetchImpl = fetch` constructor parameter so the factory stays
  unit-testable without network access, matching how `build-github-ports` is tested.
- **Keep the `LinearClient` / `LinearIssueData` types exported; drop only the concrete class.** GitHub
  exports its `GithubClient` interface but keeps the concrete `createGithubClient` private; I mirror
  that. The types are harmless to expose and may be referenced by callers/tests; the concrete
  `LinearGraphqlClient` constructor is what must not be reachable outside `ports/`.
- **`LinearGraphqlClient` stays a module-level export of `linear-client.ts`** (so the new factory and
  the existing `linear-client.test.ts` can import it via relative path inside the package). Only the
  *package barrel* re-export is removed. In-package relative imports are within the boundary and are
  allowed.
- **No contract or behavior change.** `ResolvedProjectEntry`, `parseTrackerRef` routing, and
  `createProjectScopedPorts` are untouched. The `linearToken`-missing guard stays in the worker
  (it is a worker-wiring concern tied to the registry entry, not something to push into `ports/`
  under approach A).

## Design

### Files changed

- **New — `packages/ports/src/linear/build-linear-ports.ts`**
  Exports `createLinearTracker(token: string, fetchImpl?: typeof fetch): TrackerPort`. Body:
  `new LinearTrackerPort(new LinearGraphqlClient(token, fetchImpl))`. This is the single place Linear's
  vendor client is constructed. Imports `LinearGraphqlClient` and `LinearTrackerPort` via relative
  paths within the package. Mirrors `build-github-ports.ts`.

- **New — `packages/ports/src/linear/build-linear-ports.test.ts`**
  Mirrors `build-github-ports.test.ts`: asserts `createLinearTracker(token)` returns a
  `LinearTrackerPort` instance (a `TrackerPort`), and, using an injected fake `fetchImpl`, that a
  tracker call (e.g. `getIssue` on a `linear:`-shaped ref) routes through the vendor client to the
  Linear GraphQL endpoint — confirming the factory wired the client to the port correctly without
  real network access.

- **Edit — `packages/ports/src/index.ts`**
  Replace the blanket `export * from './linear/linear-client'` (line 14) with a type-only re-export
  (`export type { LinearClient, LinearIssueData } from './linear/linear-client'`) so the concrete
  `LinearGraphqlClient` class is no longer part of the package's public surface, and add
  `export * from './linear/build-linear-ports'`. The `LinearTrackerPort` re-export (line 15) may
  remain — it is a port, not a vendor client — but the worker no longer needs to import it.

- **Edit — `packages/worker/src/main.ts`**
  Replace the `LinearGraphqlClient, LinearTrackerPort` imports (lines 48-49) with `createLinearTracker`.
  Change line 90 from `new LinearTrackerPort(new LinearGraphqlClient(entry.linearToken))` to
  `createLinearTracker(entry.linearToken)`. The surrounding `entry.trackerType === 'linear'` branch and
  the `linearToken`-missing guard (lines 84-89, 91) are unchanged.

### Data flow (unchanged in behavior)

`loadManagedProjectRegistry` → `ResolvedProjectEntry[]` → `buildActivityDependencies` branches on
`trackerType`; for a linear entry it now calls `createLinearTracker(entry.linearToken)` instead of
hand-constructing the client → the resulting `TrackerPort` is passed into `createProjectScopedPorts`
exactly as before. Ref-shape dispatch (`parseTrackerRef`, `byLinearTeamKey`) is untouched.

### Error handling

No new failure modes. The worker keeps its existing `throw` when a linear entry lacks `linearToken`
(before the factory is called). `LinearGraphqlClient`'s existing request-level error handling
(non-2xx, GraphQL `errors`, empty `data`) is unchanged since the class body is not modified.

### Verification

Existing tests continue to pass: `main.test.ts:71` only asserts the linear entry produces a
non-`Memory` tracker/scm, which still holds. New `build-linear-ports.test.ts` covers the factory.
Definition of done: `pnpm lint && pnpm typecheck && pnpm test` green; e2e green (touches ports +
worker wiring). No behavior change, so no SLDS/README update required; the boundary rule is being
enforced, not altered.

## Scope

This is one coherent change: give Linear a `ports/`-internal construction factory and remove the
export that allowed the boundary breach. No unrelated work is bundled in.

## Brainstorm Summary
**Approaches considered:** (A) add a `createLinearTracker` factory in `ports/` mirroring `createGithubPorts` and un-export the concrete vendor client; (B) wrap the construction in a private worker helper but keep exports; (C) a larger registry-driven unified port factory covering both GitHub and Linear.
**Chosen approach:** A.
**Why (decisive reasons):** It's the minimal fix that actually satisfies hard rule #4 and makes Linear structurally identical to GitHub. B just relocates the violation without fixing it; C is correct but over-scoped for this bug. Un-exporting `LinearGraphqlClient` enforces the boundary at compile time so the breach can't silently return.
**Key risks/assumptions:** Factory is `createLinearTracker(token, fetchImpl?)` returning a `TrackerPort` (Linear has no SCM in this system); the `LinearClient`/`LinearIssueData` types stay exported, only the concrete class is hidden; no contract or behavior change, so existing tests and routing are untouched.
