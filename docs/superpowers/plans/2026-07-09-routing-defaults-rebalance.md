# Routing Defaults Rebalance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the engine's default `implement`-stage routing off `claude` onto OpenRouter's DeepSeek V4 Flash (via the `pi` backend), and move the `platform` role's hardcoded model off z.ai's GLM onto the shared `claude`/Sonnet-5 backend — reducing how many consumers hit z.ai's per-account concurrency limit.

**Architecture:** Two independent, non-interacting value changes: `DEFAULT_PROJECT_CONFIG.routing.implement` in `packages/contracts` (a config default, consumed only via `parseProjectConfig` when a real `agentops.json` is loaded — verified this does **not** affect any e2e test, since e2e `TaskInput.config` objects either fully override routing or fall back to `'stub'` directly inside `dev-cycle.ts`, never through `DEFAULT_PROJECT_CONFIG`). And the `PLATFORM_MODEL` constant in `packages/workflows/src/platform.ts`, which **does** need a matching test-fixture update since `e2e/platform-agent.e2e.test.ts` resolves its stub backend by the literal backend name in `PLATFORM_MODEL`.

**Tech Stack:** TypeScript, zod (contracts), Temporal TS SDK + `TestWorkflowEnvironment` (e2e), vitest.

Full design: [docs/superpowers/specs/2026-07-09-routing-defaults-rebalance-design.md](../specs/2026-07-09-routing-defaults-rebalance-design.md).

---

### Task 1: Move `implement`'s default routing to OpenRouter DeepSeek V4 Flash

**Files:**
- Modify: `packages/contracts/src/project-config.ts:41`
- Test: `packages/contracts/src/project-config.test.ts:101`

- [ ] **Step 1: Update the failing assertion first**

In `packages/contracts/src/project-config.test.ts`, change line 101 from:

```ts
    expect(config.routing.implement).toEqual({ backend: 'claude', model: 'claude-sonnet-5', effort: 'high' });
```

to:

```ts
    expect(config.routing.implement).toEqual({ backend: 'pi', model: 'openrouter/deepseek-v4-flash', effort: 'high' });
```

- [ ] **Step 2: Run the test file to confirm it now fails**

```bash
pnpm exec vitest run --config vitest.config.ts packages/contracts/src/project-config.test.ts
```

Expected: FAIL on `fully defaults an empty config`, actual value still `{ backend: 'claude', model: 'claude-sonnet-5', effort: 'high' }`.

- [ ] **Step 3: Update the default**

In `packages/contracts/src/project-config.ts`, inside `DEFAULT_PROJECT_CONFIG.routing` (around line 41), change:

```ts
    implement: { backend: 'claude', model: 'claude-sonnet-5', effort: 'high' },
```

to:

```ts
    implement: { backend: 'pi', model: 'openrouter/deepseek-v4-flash', effort: 'high' },
```

- [ ] **Step 4: Run the test file to confirm it passes**

```bash
pnpm exec vitest run --config vitest.config.ts packages/contracts/src/project-config.test.ts
```

Expected: PASS, all cases in this file green.

- [ ] **Step 5: Run the full contracts package test suite to check for other fallout**

```bash
pnpm exec vitest run --config vitest.config.ts packages/contracts
```

Expected: PASS. (No other test in this file references the `implement` default — `deep-merges a partial routing override` at line 112 supplies its own explicit `implement` override and is unaffected.)

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/project-config.ts packages/contracts/src/project-config.test.ts
git commit -m "feat: default implement routing to OpenRouter DeepSeek V4 Flash

Frees the implement stage (highest-volume devCycle stage) from
z.ai/claude subscription contention. Model string verified live
against a real pi CLI install (v0.80.2): pi --list-models deepseek
confirms openrouter/deepseek-v4-flash is a real cataloged model, and
pi --print --model openrouter/deepseek-v4-flash round-tripped a real
OpenRouter completion. See
docs/superpowers/specs/2026-07-09-routing-defaults-rebalance-design.md."
```

---

### Task 2: Move the `platform` role's model to the shared Claude backend

**Files:**
- Modify: `packages/workflows/src/platform.ts:19-24`
- Modify: `e2e/helpers.ts:52`
- Test: `e2e/platform-agent.e2e.test.ts` (existing suite, no new cases needed)

- [ ] **Step 1: Change `PLATFORM_MODEL` first (this will break the e2e test on purpose)**

In `packages/workflows/src/platform.ts`, replace lines 19-24:

```ts
// This role isn't scoped to one project, so there's no ProjectConfig to route
// through -- fixed here at the same reasoning-heavy tier devCycle uses for
// design/review. 'platform' (not 'pi') as the backend key: it's the pi CLI,
// but a distinct worker backend entry with this role's own ServiceAccount/secrets
// (see packages/worker/src/main.ts buildBackends).
const PLATFORM_MODEL = { backend: 'platform', model: 'zai/glm-5.2', effort: 'high' as const };
```

with:

```ts
// This role isn't scoped to one project, so there's no ProjectConfig to route
// through -- fixed here at the same reasoning-heavy tier devCycle uses for
// design/review. Shares the 'claude' backend devCycle stages use (no
// dedicated ServiceAccount/secret for this role) -- see
// docs/superpowers/specs/2026-07-09-routing-defaults-rebalance-design.md.
const PLATFORM_MODEL = { backend: 'claude', model: 'claude-sonnet-5', effort: 'high' as const };
```

- [ ] **Step 2: Run the platform e2e suite to confirm it now fails**

```bash
pnpm exec vitest run --config vitest.e2e.config.ts e2e/platform-agent.e2e.test.ts
```

Expected: FAIL, every case throwing `createActivities.runAgent: unknown backend "claude"` — `e2e/helpers.ts`'s `buildTestEnv` only registers `stub` and `platform` backend names today, not `claude`.

- [ ] **Step 3: Register `claude` instead of `platform` in the e2e test harness**

In `e2e/helpers.ts`, change line 52 from:

```ts
    backends: { stub, platform: stub, ...opts.extraBackends },
```

to:

```ts
    backends: { stub, claude: stub, ...opts.extraBackends },
```

(Nothing else in the repo looks up a backend literally named `'platform'` after Step 1 — confirmed via `grep -rn "backend: 'platform'"` across `packages/` and `e2e/` before this change.)

- [ ] **Step 4: Run the platform e2e suite to confirm it passes**

```bash
pnpm exec vitest run --config vitest.e2e.config.ts e2e/platform-agent.e2e.test.ts
```

Expected: PASS, all 4 cases (`answers a pure question...`, `starts a child devCycle...`, `skips a proposed fix...`, `retries once on unparseable output...`).

- [ ] **Step 5: Run the full e2e suite to check for other fallout**

```bash
pnpm e2e
```

Expected: PASS. (No other e2e test passes `extraBackends: { claude: ... }` — confirmed via grep; the new default `claude: stub` mapping only affects tests that were previously unable to resolve a `claude`-named backend at all, i.e. none today besides the platform suite.)

- [ ] **Step 6: Commit**

```bash
git add packages/workflows/src/platform.ts e2e/helpers.ts
git commit -m "feat: route platform role through shared claude backend instead of z.ai

Removes the platform role (every platform-question run) from z.ai's
concurrent-session count. Reuses the same 'claude' backend devCycle
stages already use, per explicit choice to skip standing up a
dedicated isolated backend instance for this role. See
docs/superpowers/specs/2026-07-09-routing-defaults-rebalance-design.md."
```

---

### Task 3: Open the PR, pass CI, and resolve the Bugbot review

**Files:** none (integration / review).

> Sequential and partly asynchronous — CI and Bugbot run on the remote PR.
> **HARD GATE: Do not mark this task complete until CI is green.**
> **Known repo caveat:** Bugbot has not responded on the last 2 PRs in
> `agentops-engine` despite retriggers (`bugbot run`) — if it produces no
> review after one retrigger and a reasonable wait (~10 minutes), do not
> block indefinitely on it; note this in your final summary instead of
> treating it as an open gate.

- [ ] **Step 1: Sync the latest `main`**

```bash
git fetch origin
git merge origin/main
pnpm lint && pnpm typecheck && pnpm test && pnpm e2e   # resolve conflicts + commit first if any; fix fallout
```

- [ ] **Step 2: Push and open the PR**

```bash
git status --short && git rev-parse --abbrev-ref HEAD   # clean tree, on feature branch (not main)
git push -u origin HEAD
gh pr create --base main --fill --title "routing: move implement to OpenRouter, platform to Claude"
```

- [ ] **Step 3: Subagent code review**

REQUIRED SUB-SKILL: `requesting-code-review`. Dispatch a code reviewer subagent (BASE_SHA = merge-base with `main`, HEAD_SHA = HEAD). Fix Critical and Important findings, commit, push, then proceed.

- [ ] **Step 4: Make every CI check pass**

```bash
gh pr checks --watch
```
On failure: `gh run view --log-failed`, reproduce locally, fix, commit, push, re-watch. Do not proceed while red.

- [ ] **Step 5: Wait for the Bugbot review**

```bash
gh pr view --json reviews,comments
gh pr comment --body "bugbot run"   # only if it hasn't reviewed yet
```

Per the known caveat above: if Bugbot still hasn't posted after one retrigger and ~10 minutes, proceed to Step 7 and note it rather than waiting indefinitely.

- [ ] **Step 6: Address each Bugbot comment (if any appear)**

REQUIRED SUB-SKILL: `receiving-code-review`. Verify before acting — reply to false positives; TDD-fix real findings, commit each referencing the finding, push once.

**Then mark each addressed thread resolved:**

```bash
gh api graphql -f query='query($o:String!,$r:String!,$p:Int!){repository(owner:$o,name:$r){pullRequest(number:$p){reviewThreads(first:100){nodes{id isResolved path comments(first:1){nodes{body}}}}}}}' -F o=<owner> -F r=<repo> -F p=<number>
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=<thread-id>
```

**After pushing:** return to Step 4 (re-watch CI), then Step 5 (wait for re-review). Loop until Bugbot reports no unresolved comments, or the known-caveat exception applies.

- [ ] **Step 7: Final verification**

```bash
gh pr checks                          # all green
gh pr view --json reviews,comments    # no comment left unaddressed (or documented Bugbot-silent caveat)
pnpm lint && pnpm typecheck && pnpm test && pnpm e2e   # suite green locally
```
Confirm no unresolved review threads remain (or the Bugbot-silent caveat is explicitly noted), then mark this task complete.
