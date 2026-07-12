# Throttle Detection Broadening (SP1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Broaden provider-throttle detection so both `claude` and `pi` backends classify two distinct failure classes — `RateLimitError` (transient 429/fair-usage, self-clears in minutes) and `SessionLimitError` (account-wide subscription cap, lasts hours) — instead of today's single `ProviderRateLimitedError` that only matches the z.ai 429 phrasing and is wired only into `pi`.

**Architecture:** One detection module (`provider-rate-limit.ts`) exports two narrow regex matchers + two typed errors. Each backend's output parser checks them in a fixed order (auth → session-limit → rate-limit → generic) *before* the generic throw. This plan does NOT add fallback behavior — it only classifies errors. A `SessionLimitError` still propagates as a generic failure until SP2 (`TierFallbackBackend`) catches it; that is intentional and is no regression (today it is a generic `ProcessCliProcessError` too). The existing same-backend `RateLimitFallbackBackend` is updated only to reference the renamed type.

**Tech Stack:** TypeScript (strict), zod, vitest, pnpm workspaces, Temporal SDK.

**Spec:** `docs/superpowers/specs/2026-07-10-model-tiering-fallback-design.md` (Section 4 — Detection). This is sub-plan **SP1 of 3**:
- SP1 (this plan) — detection broadening.
- SP2 (next) — model tier substrate (contracts migration + `resolveTier` + `TierFallbackBackend` + activity wiring).
- SP3 (next) — DB-backed tiers + control API + Mission Control editor.

**Branch:** create `feat/throttle-detection` off `main`.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `packages/backends/src/provider-rate-limit.ts` | Two typed errors + two narrow matchers | Modify (rename + add) |
| `packages/backends/src/provider-rate-limit.test.ts` | Matcher unit tests | Modify (add session-limit cases) |
| `packages/backends/src/pi/pi-backend.ts` | pi CLI output parser | Modify (wire both detectors) |
| `packages/backends/src/pi/pi-backend.test.ts` | pi parser tests | Modify (rename + add session-limit case) |
| `packages/backends/src/claude/claude-backend.ts` | claude CLI output parser | Modify (wire both detectors) |
| `packages/backends/src/claude/claude-backend.test.ts` | claude parser tests | Modify (add session-limit + rate-limit cases) |
| `packages/backends/src/rate-limit-fallback/rate-limit-fallback-backend.ts` | existing same-backend fallback decorator | Modify (reference renamed type) |
| `packages/backends/src/rate-limit-fallback/rate-limit-fallback-backend.test.ts` | its tests | Modify (reference renamed type) |
| `packages/worker/src/main.ts` | worker wiring (comment only) | Modify (comment wording) |

No new files. The detection module stays a single file — two matchers and two classes is well within one focused unit.

**Naming decision (from spec Open Questions):** `ProviderRateLimitedError` is renamed to `RateLimitError` as a clean flag-day. Only two production files + two test files import the old name (traced below), and this plan lands in one atomic PR, so no compatibility alias is needed. The canonical names going forward are `RateLimitError` / `SessionLimitError`.

---

## Task 1: Add `SessionLimitError` and `isSessionLimitMessage` matcher

**Files:**
- Modify: `packages/backends/src/provider-rate-limit.ts`
- Test: `packages/backends/src/provider-rate-limit.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these cases to the existing `describe('isProviderRateLimitMessage', ...)` block's sibling in `packages/backends/src/provider-rate-limit.test.ts`. First update the import line at the top of the file from:

```ts
import { isProviderRateLimitMessage } from './provider-rate-limit';
```

to:

```ts
import { isProviderRateLimitMessage, isSessionLimitMessage } from './provider-rate-limit';
```

Then append a new `describe` block at the end of the file:

```ts
describe('isSessionLimitMessage', () => {
  it('matches the real Claude subscription session-limit phrasing from issue-broccoli-94', () => {
    expect(isSessionLimitMessage("You've hit your session limit · resets 9:30am (UTC)")).toBe(true);
  });

  it('matches a session-limit message with a reset time', () => {
    expect(isSessionLimitMessage('session limit reached. resets at 2026-07-10T09:30:00Z')).toBe(true);
  });

  it('does not match "session limit" without a reset phrase', () => {
    expect(isSessionLimitMessage('session limit exceeded, contact support')).toBe(false);
  });

  it('does not match an unrelated rate-limit message', () => {
    expect(isSessionLimitMessage('429 Too Many Requests: rate limit exceeded')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run --config vitest.config.ts packages/backends/src/provider-rate-limit.test.ts`
Expected: FAIL — `isSessionLimitMessage is not a function` (not exported yet).

- [ ] **Step 3: Add the matcher to the detection module**

In `packages/backends/src/provider-rate-limit.ts`, the file currently is:

```ts
export class ProviderRateLimitedError extends Error {}

// Deliberately narrower than "contains 429" alone -- a bare 429 without one
// of these phrases stays a generic backend error, since not every 429 a CLI
// surfaces is this specific throttle-and-recover class of failure. See
// docs/superpowers/specs/2026-07-08-provider-rate-limit-fallback-design.md.
export function isProviderRateLimitMessage(message: string): boolean {
  return /\b429\b/.test(message) && /(fair usage policy|rate limit|request frequency)/i.test(message);
}
```

Append the new class + matcher after the existing ones (do not remove anything yet — the rename is Task 2):

```ts
// Account-wide subscription cap (e.g. the Claude Code CLI "You've hit your
// session limit · resets 9:30am (UTC)" from issue-broccoli-94). Lasts hours,
// not minutes, so a same-backend retry is pointless -- this is the class SP2's
// TierFallbackBackend catches to advance to a different credential domain.
// Narrow on purpose: requires BOTH "session limit" and a "reset" phrase so a
// generic outage that happens to mention sessions isn't misclassified.
export function isSessionLimitMessage(message: string): boolean {
  return /session limit/i.test(message) && /reset/i.test(message);
}
```

And add the typed error class above it:

```ts
export class SessionLimitError extends Error {}
```

(Place `SessionLimitError` next to `ProviderRateLimitedError` at the top of the file for symmetry.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run --config vitest.config.ts packages/backends/src/provider-rate-limit.test.ts`
Expected: PASS — all existing `isProviderRateLimitMessage` cases plus the 4 new `isSessionLimitMessage` cases.

- [ ] **Step 5: Commit**

```bash
git add packages/backends/src/provider-rate-limit.ts packages/backends/src/provider-rate-limit.test.ts
git commit -m "feat(backends): add SessionLimitError + isSessionLimitMessage matcher"
```

---

## Task 2: Rename `ProviderRateLimitedError` → `RateLimitError` (clean flag-day)

**Files:**
- Modify: `packages/backends/src/provider-rate-limit.ts`
- Modify: `packages/backends/src/pi/pi-backend.ts`
- Modify: `packages/backends/src/pi/pi-backend.test.ts`
- Modify: `packages/backends/src/rate-limit-fallback/rate-limit-fallback-backend.ts`
- Modify: `packages/backends/src/rate-limit-fallback/rate-limit-fallback-backend.test.ts`

This is a mechanical rename with no behavior change. Existing tests are the safety net. There is no new test to write — the assertion is "the whole backends suite still passes after the rename."

- [ ] **Step 1: Rename the class and matcher in the detection module**

In `packages/backends/src/provider-rate-limit.ts`, rename:

```ts
export class ProviderRateLimitedError extends Error {}
```

to:

```ts
// Self-clearing provider throttle (minutes): a 429 that names fair-usage /
// rate-limit / request-frequency. The retry-it-out class -- SP2's activity
// layer maps this to a retryable ApplicationFailure with a nextRetryDelay.
export class RateLimitError extends Error {}
```

And rename the function `isProviderRateLimitMessage` → `isRateLimitMessage` (keep the regex and the comment body identical; only the identifier changes). Update the comment's doc reference to point at the new spec too — replace the line:

```ts
// docs/superpowers/specs/2026-07-08-provider-rate-limit-fallback-design.md.
```

with:

```ts
// docs/superpowers/specs/2026-07-10-model-tiering-fallback-design.md (Section 4).
```

- [ ] **Step 2: Update `pi-backend.ts` imports and call site**

In `packages/backends/src/pi/pi-backend.ts`, the import (line 4):

```ts
import { isProviderRateLimitMessage, ProviderRateLimitedError } from '../provider-rate-limit';
```

becomes:

```ts
import { isRateLimitMessage, RateLimitError } from '../provider-rate-limit';
```

And the call site (~line 87-88):

```ts
        if (isProviderRateLimitMessage(message)) {
          throw new ProviderRateLimitedError(message);
        }
```

becomes:

```ts
        if (isRateLimitMessage(message)) {
          throw new RateLimitError(message);
        }
```

(Do not add session-limit wiring here yet — that is Task 3. Keep this task a pure rename.)

- [ ] **Step 3: Update the pi-backend test references**

In `packages/backends/src/pi/pi-backend.test.ts`:

- Import (line 7): `import { ProviderRateLimitedError } from '../provider-rate-limit';` → `import { RateLimitError } from '../provider-rate-limit';`
- Test name (~line 125): `'throws ProviderRateLimitedError (not ProcessCliProcessError) when the error message matches a provider rate-limit pattern'` → `'throws RateLimitError (not ProcessCliProcessError) when the error message matches a provider rate-limit pattern'`
- Assertion (~line 150): `expect(error).toBeInstanceOf(ProviderRateLimitedError);` → `expect(error).toBeInstanceOf(RateLimitError);`

- [ ] **Step 4: Update the `RateLimitFallbackBackend` references**

In `packages/backends/src/rate-limit-fallback/rate-limit-fallback-backend.ts`:

- Import (line 4): `import { ProviderRateLimitedError } from '../provider-rate-limit';` → `import { RateLimitError } from '../provider-rate-limit';`
- The class doc comment (~line 8) references `ProviderRateLimitedError` in prose — update the word to `RateLimitError`.
- The catch guard (~line 29): `if (!(err instanceof ProviderRateLimitedError)) {` → `if (!(err instanceof RateLimitError)) {`
- The `details` object's `event` field stays `'provider-rate-limited'` (it's an observability tag, not a type name) — leave it.

In `packages/backends/src/rate-limit-fallback/rate-limit-fallback-backend.test.ts`:

- Import (line 4): `import { ProviderRateLimitedError } from '../provider-rate-limit';` → `import { RateLimitError } from '../provider-rate-limit';`
- Test name (~line 48): `'heartbeats and retries once against the fallback model on ProviderRateLimitedError'` → `'heartbeats and retries once against the fallback model on RateLimitError'`
- Two `mockRejectedValueOnce(new ProviderRateLimitedError('429 Fair Usage Policy'))` (~lines 51, 78) → `new RateLimitError('429 Fair Usage Policy')`

- [ ] **Step 5: Run the full backends suite + typecheck**

Run:
```bash
pnpm exec vitest run --config vitest.config.ts packages/backends
pnpm --filter @agentops/backends run typecheck
```
Expected: all backends tests PASS; typecheck clean. No reference to `ProviderRateLimitedError` / `isProviderRateLimitMessage` remains.

- [ ] **Step 6: Verify nothing else references the old names**

Run: `grep -rn "ProviderRateLimitedError\|isProviderRateLimitMessage" packages/`
Expected: no output (empty). If any match remains, update it.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(backends): rename ProviderRateLimitedError -> RateLimitError"
```

---

## Task 3: Wire both detectors into the `pi` backend (session-limit before rate-limit)

**Files:**
- Modify: `packages/backends/src/pi/pi-backend.ts`
- Test: `packages/backends/src/pi/pi-backend.test.ts`

- [ ] **Step 1: Write the failing test for the session-limit case**

In `packages/backends/src/pi/pi-backend.test.ts`, update the import to bring in `SessionLimitError`:

```ts
import { RateLimitError, SessionLimitError } from '../provider-rate-limit';
```

Add this test inside the existing `describe(...)` block, next to the rate-limit test (mirror its structure — it uses `fakeChildProcess()`, emits a `message_end` event with `stopReason: 'error'`, and asserts the thrown error type):

```ts
  it('throws SessionLimitError when the error message matches a session-limit pattern', async () => {
    const { child } = fakeChildProcess();
    const errorMessage = "You've hit your session limit · resets 9:30am (UTC)";
    const sessionLimitJsonl = JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage },
    });
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end(sessionLimitJsonl);
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ProcessCliRunner(createPiCliSpec(), { spawn: spawnFn as never });

    let error: unknown;
    try {
      await backend.run(baseRequest);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(SessionLimitError);
    expect(error).not.toBeInstanceOf(RateLimitError);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run --config vitest.config.ts packages/backends/src/pi/pi-backend.test.ts`
Expected: FAIL — the session-limit message currently throws `RateLimitError`? No — it throws `ProcessCliProcessError` (it does not match `isRateLimitMessage` because there is no `429`). So the failure is `expected SessionLimitError, received ProcessCliProcessError`.

- [ ] **Step 3: Wire the session-limit check into `parseOutput`**

In `packages/backends/src/pi/pi-backend.ts`, update the import (Task 2 left it as `import { isRateLimitMessage, RateLimitError } from '../provider-rate-limit';`). Extend it:

```ts
import { isRateLimitMessage, isSessionLimitMessage, RateLimitError, SessionLimitError } from '../provider-rate-limit';
```

The `stopReason` error block currently reads (after Task 2's rename):

```ts
      if (lastAssistantMessage?.stopReason === 'error' || lastAssistantMessage?.stopReason === 'aborted') {
        const message =
          lastAssistantMessage.errorMessage || `pi turn ended with stopReason "${lastAssistantMessage.stopReason}"`;
        if (isRateLimitMessage(message)) {
          throw new RateLimitError(message);
        }
        throw new ProcessCliProcessError(message);
      }
```

Insert the session-limit check **before** the rate-limit check (session-limit is the more severe, account-wide class and should win any ambiguity):

```ts
      if (lastAssistantMessage?.stopReason === 'error' || lastAssistantMessage?.stopReason === 'aborted') {
        const message =
          lastAssistantMessage.errorMessage || `pi turn ended with stopReason "${lastAssistantMessage.stopReason}"`;
        if (isSessionLimitMessage(message)) {
          throw new SessionLimitError(message);
        }
        if (isRateLimitMessage(message)) {
          throw new RateLimitError(message);
        }
        throw new ProcessCliProcessError(message);
      }
```

- [ ] **Step 4: Run the pi-backend tests to verify they pass**

Run: `pnpm exec vitest run --config vitest.config.ts packages/backends/src/pi/pi-backend.test.ts`
Expected: PASS — the new session-limit case plus the existing rate-limit and generic-error cases.

- [ ] **Step 5: Commit**

```bash
git add packages/backends/src/pi/pi-backend.ts packages/backends/src/pi/pi-backend.test.ts
git commit -m "feat(backends): classify session-limit errors in pi backend"
```

---

## Task 4: Wire both detectors into the `claude` backend (the incident fix's detection gap)

**Files:**
- Modify: `packages/backends/src/claude/claude-backend.ts`
- Test: `packages/backends/src/claude/claude-backend.test.ts`

This is the core of issue #27's gap #1 ("not detected"): the incident's `claude reported is_error: You've hit your session limit` currently throws a generic `ProcessCliProcessError`. After this task it throws `SessionLimitError`.

- [ ] **Step 1: Write the failing tests**

In `packages/backends/src/claude/claude-backend.test.ts`, add the import (it does not currently import from `provider-rate-limit`):

```ts
import { RateLimitError, SessionLimitError } from '../provider-rate-limit';
```

The existing `is_error: true` test at ~line 171 asserts `ClaudeBackendProcessError`. That one stays (it's a generic `is_error`, not a throttle). Add two new tests next to it, mirroring the auth test's use of `streamJson(...)`:

```ts
  it('throws SessionLimitError when is_error:true carries the Claude subscription session-limit phrasing', async () => {
    const { child } = fakeChildProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end(
          streamJson({ is_error: true, result: "You've hit your session limit · resets 9:30am (UTC)", usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 5 }),
        );
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ProcessCliRunner(createClaudeCliSpec(), { spawn: spawnFn as never });

    let error: unknown;
    try {
      await backend.run(baseRequest);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(SessionLimitError);
    expect(error).not.toBeInstanceOf(ClaudeBackendProcessError);
  });

  it('throws RateLimitError when is_error:true carries a 429 rate-limit phrasing', async () => {
    const { child } = fakeChildProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end(
          streamJson({ is_error: true, result: '429 Too Many Requests: rate limit exceeded, retry later', usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 5 }),
        );
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ProcessCliRunner(createClaudeCliSpec(), { spawn: spawnFn as never });

    let error: unknown;
    try {
      await backend.run(baseRequest);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).not.toBeInstanceOf(ClaudeBackendProcessError);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run --config vitest.config.ts packages/backends/src/claude/claude-backend.test.ts`
Expected: FAIL — both currently throw `ClaudeBackendProcessError` (a `ProcessCliProcessError`), not the typed throttle errors.

- [ ] **Step 3: Wire the detectors into claude's `parseOutput`**

In `packages/backends/src/claude/claude-backend.ts`, add the import near the existing `process-cli-runner` import:

```ts
import { isRateLimitMessage, isSessionLimitMessage, RateLimitError, SessionLimitError } from '../provider-rate-limit';
```

The `is_error` block currently reads:

```ts
      if (parsed.is_error) {
        const message = `claude reported is_error: ${parsed.result}`;
        // A 401 / expired / revoked credential is reported here, in the JSON
        // result on stdout -- not on stderr, so the stderr-only isAuthError()
        // check below never catches it. Without this, a dead credential looks
        // like a generic (retryable) process error: it gets retried pointlessly
        // and its cause is buried. Classify it as an auth error so runAgent can
        // fail fast and non-retryably.
        if (AUTH_ERROR_PATTERN.test(parsed.result)) {
          throw new ProcessCliAuthError(message);
        }
        throw new ProcessCliProcessError(message);
      }
```

Insert the two throttle checks **after** the auth check and **before** the generic throw (auth is the most actionable and stays first; session-limit before rate-limit for the same severity-ordering reason as pi):

```ts
      if (parsed.is_error) {
        const message = `claude reported is_error: ${parsed.result}`;
        // A 401 / expired / revoked credential is reported here, in the JSON
        // result on stdout -- not on stderr, so the stderr-only isAuthError()
        // check below never catches it. Without this, a dead credential looks
        // like a generic (retryable) process error: it gets retried pointlessly
        // and its cause is buried. Classify it as an auth error so runAgent can
        // fail fast and non-retryably.
        if (AUTH_ERROR_PATTERN.test(parsed.result)) {
          throw new ProcessCliAuthError(message);
        }
        // A subscription session cap ("You've hit your session limit · resets
        // 9:30am") is account-wide on claude-credentials and lasts hours -- a
        // same-backend retry is pointless. Classify it so SP2's TierFallbackBackend
        // can advance to a different credential domain (claude -> pi). This is the
        // gap issue-broccoli-94 hit: today it is a generic ProcessCliProcessError
        // that just re-hits the cap 5x and dies.
        if (isSessionLimitMessage(parsed.result)) {
          throw new SessionLimitError(message);
        }
        // A self-clearing 429 (minutes). SP2 maps this to a retryable wait.
        if (isRateLimitMessage(parsed.result)) {
          throw new RateLimitError(message);
        }
        throw new ProcessCliProcessError(message);
      }
```

- [ ] **Step 4: Run the claude-backend tests to verify they pass**

Run: `pnpm exec vitest run --config vitest.config.ts packages/backends/src/claude/claude-backend.test.ts`
Expected: PASS — the two new throttle cases plus the existing generic-is_error and auth cases.

- [ ] **Step 5: Commit**

```bash
git add packages/backends/src/claude/claude-backend.ts packages/backends/src/claude/claude-backend.test.ts
git commit -m "feat(backends): classify session-limit + rate-limit errors in claude backend"
```

---

## Task 5: Update the worker comment and run the full suite

**Files:**
- Modify: `packages/worker/src/main.ts` (comment wording only)

- [ ] **Step 1: Update the stale comment in `wrapWithRateLimitFallback`**

In `packages/worker/src/main.ts`, the comment above `wrapWithRateLimitFallback` (~line 194) reads:

```ts
// Reacts to a real provider-side rate limit (ProviderRateLimitedError),
```

Update the type name in the prose:

```ts
// Reacts to a real provider-side rate limit (RateLimitError),
```

(No behavioral change — `wrapWithRateLimitFallback` catches whatever the inner backend throws; the existing `RateLimitFallbackBackend` was already updated in Task 2 to reference `RateLimitError`. This is purely keeping the comment honest.)

- [ ] **Step 2: Run the full repo test suite + typecheck + lint**

Run:
```bash
pnpm typecheck
pnpm test
pnpm lint
```
Expected: all green. `SessionLimitError` is thrown by both backends but, by design (SP1 scope), is not yet caught by any fallback — it propagates as a generic activity error, identical to today's `ProcessCliProcessError` behavior. Confirm no test regressed.

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/main.ts
git commit -m "docs(worker): reference RateLimitError in fallback wiring comment"
```

---

## Task 6: Open the PR, pass CI, and resolve the Bugbot review

**Files:** none (integration / review).

> Sequential and partly asynchronous — CI and Bugbot run on the remote PR.
> **HARD GATE: Do not mark this task complete until ALL Bugbot comments are
> resolved (fixed or replied to) AND CI is green. Check with
> `gh pr view --json reviews,comments` before claiming done.**

- [ ] **Step 1: Sync the latest `main`**

```bash
git fetch origin
git merge origin/main
pnpm lint && pnpm typecheck && pnpm test   # resolve conflicts + commit first if any; fix fallout
```

- [ ] **Step 2: Push and open the PR**

```bash
git status --short && git rev-parse --abbrev-ref HEAD   # clean tree, on feature branch (not main)
git push -u origin HEAD
gh pr create --base main --fill --title "feat(backends): broaden throttle detection (RateLimitError + SessionLimitError)"
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

- [ ] **Step 6: Address each Bugbot comment**

REQUIRED SUB-SKILL: `receiving-code-review`. Verify before acting — reply to false positives; TDD-fix real findings, commit each referencing the finding, push once.

**Then mark each addressed thread resolved** (completion is gated on the unresolved-thread count, not just on having replied/fixed):

```bash
# List unresolved threads, then resolve each addressed one by id:
gh api graphql -f query='query($o:String!,$r:String!,$p:Int!){repository(owner:$o,name:$r){pullRequest(number:$p){reviewThreads(first:100){nodes{id isResolved path comments(first:1){nodes{body}}}}}}}' -F o=est1908-agentic-ops -F r=agentops-engine -F p=<number>
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=<thread-id>
```

**After pushing:** return to Step 4 (re-watch CI), then Step 5 (wait for re-review). Loop until Bugbot reports no unresolved comments.

- [ ] **Step 7: Final verification**

```bash
gh pr checks                          # all green
gh pr view --json reviews,comments    # no comment left unaddressed
pnpm lint && pnpm typecheck && pnpm test   # suite green locally
```
Confirm no unresolved review threads remain, then mark this task complete.
