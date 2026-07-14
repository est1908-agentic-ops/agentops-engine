# Plan — Task issue-agentic-ops-engine-104

**Title:** [bughunt] whiteboxBugHunt files issues without the required 'agentops' label

**Design:** `docs/superpowers/specs/issue-agentic-ops-engine-104-design.md` (Approach A —
add a shared `DEFAULT_TRIGGER_LABEL = 'agentops'` constant in `contracts`, apply it to
bughunt's filed-issue labels, and use it for the gateway default).

## Summary of the change

The root cause is a duplicated magic string: the gateway triggers DevCycles only on issues
carrying `'agentops'` (`gateway/src/main.ts:75`), but `whiteboxBugHunt` files issues with
`labels: ['bug', 'whitebox']` (`whitebox-bughunt.ts:42`) and never applies that label, so
every filed bug is orphaned. The fix introduces one shared constant and references it from
both sites so they cannot drift, and prepends it to the bughunt labels array.

## Files that change (in order)

### 1. `packages/contracts/src/tracker-types.ts` — add the shared constant
- Add `export const DEFAULT_TRIGGER_LABEL = 'agentops';`
- `tracker-types.ts` is already re-exported from `packages/contracts/src/index.ts`, so no
  index edit is required. (Verified: `index.ts` ends with `export * from './tracker-types';`.)
- **Why first:** this is the de-risking / unblocking step — both downstream edits import this
  symbol, so introducing it first means each subsequent file compiles against a real export
  rather than a forward reference. It is also the lowest-risk edit (pure additive constant, no
  behavior change on its own).
- **Verify:** `pnpm --filter @agentops/contracts typecheck` (or repo-root `pnpm typecheck`)
  compiles; grep confirms the new export exists.

### 2. `packages/workflows/src/whitebox-bughunt.ts` — apply the label at the call site
- Add `DEFAULT_TRIGGER_LABEL` to the existing `@agentops/contracts` import path. Note: this
  file currently imports only from `@agentops/policies` and `@temporalio/workflow`, so add a
  new `import { DEFAULT_TRIGGER_LABEL } from '@agentops/contracts';` line.
- Change the `createIssue` call (line ~42) labels from `['bug', 'whitebox']` to
  `[DEFAULT_TRIGGER_LABEL, 'bug', 'whitebox']` (trigger label first, per design assumption).
- Everything else in the `createIssue` call (repo, project, title, body, dedupeFingerprint) is
  untouched — no behavioral change beyond the added label.
- **Determinism note:** a constant import is a pure workflow-safe value; no `process.env`/I/O
  is introduced, so AGENTS.md hard rule #1 (workflow determinism) is respected.
- **Verify:** unit test updated in step 4; `pnpm typecheck` compiles the import.

### 3. `packages/gateway/src/main.ts` — share the default so gateway can't drift
- Change `triggerLabel: process.env.TRIGGER_LABEL ?? 'agentops'` (line 75) to
  `triggerLabel: process.env.TRIGGER_LABEL ?? DEFAULT_TRIGGER_LABEL`.
- Add `DEFAULT_TRIGGER_LABEL` to the existing `import ... from '@agentops/contracts'` line
  (the file already imports `ResolvedProjectEntry` from `@agentops/contracts`, so extend that
  import rather than adding a new statement). `DEFAULT_TRIGGER_LABEL` is a runtime value (not a
  type), so it must be a value import, not a `import type`.
- Behavior is identical (`'agentops'` either way) — this step exists purely to kill the
  duplicated literal that caused the original drift.
- **Verify:** `pnpm typecheck`; `pnpm --filter @agentops/gateway test` still green.

### 4. `packages/workflows/src/whitebox-bughunt.test.ts` — regression guard
- Extend the existing `'runs the bughunt agent and files a finding'` test to assert the
  `createIssue` call's `labels` contain `'agentops'`, `'bug'`, and `'whitebox'`. Use
  `expect.arrayContaining(['agentops', 'bug', 'whitebox'])` on
  `createIssue.mock.calls[0][0].labels` so the assertion is order-independent and survives if
  the array is later reordered.
- Keep the existing `toHaveBeenCalledTimes(1)` / `result.filed === 1` assertions.
- **Verify:** `pnpm --filter @agentops/workflows test` — the new assertion fails before step 2
  and passes after (confirm by running the test once before touching source if practical, else
  rely on the arrayContaining assertion as the guard).

## Final verification (whole task)

Run from repo root, in order:
1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test`
4. `pnpm e2e` — required because `packages/workflows` is touched (AGENTS.md rule 6).

Definition of done: all four green; `whitebox-bughunt.test.ts` asserts the `agentops` label;
no remaining hardcoded `'agentops'` literal outside the new constant (grep
`grep -rn "'agentops'" packages/ --include=*.ts | grep -v tracker-types` returns only test
fixtures / unrelated strings, not a second source-of-truth default).

## Reordering notes
- Steps 2 and 3 are independent of each other and could be swapped; both only depend on step 1.
  Kept in this order (workflow before gateway) because the workflow edit is the actual bug fix
  and the gateway edit is the supporting de-duplication.
- Step 4 (test) is written after the source change so the assertion targets the final shape;
  it could be written first as true TDD, but the arrayContaining assertion is simple enough
  that authoring it alongside/after step 2 carries no risk of masking the bug.
- Step 1 must stay first — it is the only step every other step compiles against.

## Assumptions (resolved here, no human available)
- **The "required" label is the gateway trigger label, default `'agentops'`.** Confirmed by
  the issue title and `parse-issue-labeled.ts` matching `triggerLabel`. Adopted from the design.
- **Hardcoding `'agentops'` in the constant is correct.** The workflow cannot read
  `TRIGGER_LABEL` (determinism boundary) and the engine worker does not set it, so the shared
  default matches the gateway default. A non-default gateway `TRIGGER_LABEL` override leaving
  bughunt issues labeled `'agentops'` is a known, out-of-scope residual gap (Approach C
  territory) — noted, not solved.
- **Existing `['bug', 'whitebox']` labels are kept**, trigger label prepended (additive).
- **No dedup / other behavioral change** — only the labels array changes.
- **`tracker-types.ts` is the right home** for the constant: it already holds
  `CreateIssueInput`/`Issue`/`CreateIssueResult` and is already exported from the barrel, so no
  new export wiring is needed. Chosen over a new file to avoid an extra module + index edit.
