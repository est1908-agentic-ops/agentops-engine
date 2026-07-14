# Design — Task issue-agentic-ops-engine-104

**Title:** [bughunt] whiteboxBugHunt files issues without the required 'agentops' label

## Goal

`whiteboxBugHunt` (`packages/workflows/src/whitebox-bughunt.ts`) runs the whitebox bughunt
agent and files a GitHub issue for each finding via the `createIssue` activity. Today it tags
those issues with `labels: ['bug', 'whitebox']` (line 42). It never applies the gateway's
**trigger label** (`'agentops'` by default). The gateway only starts a DevCycle when an issue
carries that trigger label (`packages/gateway/src/parse-issue-labeled.ts`, matching
`triggerLabel` = `process.env.TRIGGER_LABEL ?? 'agentops'` set in
`packages/gateway/src/main.ts:75`). As a result, every bug the bughunt files is orphaned: the
issue exists but the engine never picks it up to actually fix it, defeating the point of the
bughunt. The fix is to ensure filed findings carry the trigger label so they enter the
DevCycle pipeline.

## Background / current behavior

- `whiteboxBugHunt` is the **only** caller of the `createIssue` activity
  (`packages/workflows/src/activities-api.ts:58`, impl at
  `packages/activities/src/create-activities.ts:294`). The activity passes `req.labels`
  straight through to `deps.tracker.createIssue`.
- The gateway trigger label default `'agentops'` is a **magic string hardcoded in the gateway**
  (`main.ts:75`); there is no shared constant. Nothing in `contracts`/`policies` defines it.
- `dev-cycle.ts` propagates labels from the *triggering* issue onto its PR
  (`dev-cycle.ts:400`), so human/gateway-triggered flows already carry `agentops`. Only the
  bughunt's self-filed issues are missing it — it is the one place that mints brand-new issues
  from scratch.
- Determinism boundary (AGENTS.md hard rule #1): `packages/workflows` cannot read `process.env`
  or do I/O, so the workflow cannot read `TRIGGER_LABEL` directly. The value must come from a
  workflow-safe source (a constant, or from `resolveRepoConfig`'s already-fetched config, or be
  applied inside an activity).

## Approaches considered

### A. Add the label at the call site, sourced from a shared constant (recommended)
Introduce a single exported constant `DEFAULT_TRIGGER_LABEL = 'agentops'` in
`packages/contracts` (workflow-safe: pure value, no I/O), reference it from both the gateway
default (`main.ts`) and the bughunt labels array so
`labels: [DEFAULT_TRIGGER_LABEL, 'bug', 'whitebox']`.

- **Trade-off:** Fixes the bug and removes the magic-string duplication that is the root cause
  of drift. Slightly wider than a one-line edit (touches contracts + gateway + workflow) but
  each touch is trivial and the change stays coherent.
- **Cost/complexity:** Low. One new constant, one export, three call sites, plus test updates.

### B. Enforce the trigger label inside the `createIssue` activity
Make `createIssue` (activities package, which *can* read env) always union the trigger label
into `req.labels` before calling the tracker, sourced from `process.env.TRIGGER_LABEL ??
DEFAULT_TRIGGER_LABEL`.

- **Trade-off:** Most robust in theory — any future `createIssue` caller is auto-covered, and it
  can honor a custom `TRIGGER_LABEL`. But it silently mutates caller-supplied labels (surprising
  for a generic "create issue" primitive), and it couples the engine worker to a gateway-owned
  env var that the engine worker does not currently set — so in practice it would resolve to the
  same `'agentops'` default anyway, buying little over A while adding hidden behavior.
- **Cost/complexity:** Low-medium, but adds implicit semantics and a cross-service env coupling.

### C. Thread the trigger label through project config / `resolveRepoConfig`
Add a `triggerLabel` field to `ProjectConfig`, resolve it in `resolveRepoConfig`, and have the
workflow read `config.triggerLabel`.

- **Trade-off:** Makes the label per-project configurable. But the trigger label is a single
  gateway-wide env, not a per-project setting, so this models a flexibility that does not exist
  and expands the contract surface (new zod field, migration, docs) far beyond the bug.
- **Cost/complexity:** High relative to the defect. Over-engineered.

## Chosen approach — A

Approach A fixes the actual defect (filed issues lack the trigger label) at the site that owns
the labels, while eliminating the duplicated `'agentops'` magic string that let gateway and
bughunt drift apart in the first place. It respects the determinism boundary (a constant is a
pure workflow-safe value) and AGENTS.md's "no structural duplication / contracts-first"
conventions by putting the shared value in `contracts`.

- **B rejected:** overloads a generic activity with implicit label mutation and couples the
  engine worker to a gateway env var it doesn't set; the robustness it promises collapses to the
  same default constant in this deployment, so the extra hidden behavior isn't earned.
- **C rejected:** models per-project configurability that doesn't exist; large contract/doc
  surface for a one-line semantic bug.

## Assumptions

- **The "required" label is the gateway trigger label, default `'agentops'`.** The issue title
  names `'agentops'` verbatim and the gateway triggers on exactly that label; I assume the
  intent is that bughunt-filed issues must be pickup-eligible by the DevCycle engine.
- **The default value `'agentops'` is the correct one to hardcode.** Since the workflow cannot
  read `TRIGGER_LABEL` and the engine worker does not set it, I use the same default the gateway
  uses. If an operator overrides `TRIGGER_LABEL` on the gateway, bughunt issues would still be
  labeled `'agentops'` — this residual gap is out of scope for this bug and would be Approach C
  territory; I note it rather than solve it.
- **Existing `['bug', 'whitebox']` labels stay.** They are additive metadata; the fix prepends
  the trigger label rather than replacing them. Trigger label goes first for readability.
- **No dedup/behavioral change intended.** `dedupeFingerprint` and everything else in the
  `createIssue` call are untouched; only the labels array changes.

## Design — what changes

1. **`packages/contracts`** — add and export `DEFAULT_TRIGGER_LABEL = 'agentops'` (e.g. in
   `tracker-types.ts`, which already holds `CreateIssueInput`/`Issue`, exported via
   `src/index.ts`). Single source of truth for the default trigger label.
2. **`packages/workflows/src/whitebox-bughunt.ts`** — import `DEFAULT_TRIGGER_LABEL` from
   `@agentops/contracts` and change the `createIssue` call's labels to
   `[DEFAULT_TRIGGER_LABEL, 'bug', 'whitebox']`.
3. **`packages/gateway/src/main.ts`** — change `triggerLabel: process.env.TRIGGER_LABEL ??
   'agentops'` to fall back to `DEFAULT_TRIGGER_LABEL`, so gateway and bughunt share one
   default and can't drift.

### Data flow after the fix
bughunt agent → `parseFindings` → for each finding, `createIssue({ labels:
['agentops','bug','whitebox'], ... })` → tracker creates a GitHub issue carrying `agentops` →
gateway's issue-labeled/opened webhook matches `triggerLabel` → DevCycle starts on the filed
bug. The loop closes.

### Error handling / edge cases
- No new failure modes: labels is already a `string[]` passed through unchanged shapes; adding
  an element needs no contract/schema change beyond the new exported constant.
- Dedup path unaffected — a deduped finding short-circuits before `tracker.createIssue`, so
  labels are irrelevant there (matches current behavior).

### Tests
- **`packages/workflows/src/whitebox-bughunt.test.ts`** — extend the existing "files a finding"
  test to assert `createIssue` is called with `labels` containing `'agentops'` (and still
  `'bug'`, `'whitebox'`). This is the regression guard for this bug.
- If a gateway test asserts the literal default label, update it to reference the constant; a
  quick check shows the gateway default isn't currently asserted, so likely no change needed.
- Run `pnpm lint && pnpm typecheck && pnpm test`; `pnpm e2e` since workflows are touched.

## Self-review

- No placeholders or TBDs.
- No contradictions: every section treats the fix as "add the shared trigger-label constant to
  bughunt's filed-issue labels."
- Scope: one coherent change — fix the missing label and remove the magic-string duplication
  that caused it. It deliberately does **not** add per-project label config (Approach C) or
  activity-level label injection (Approach B).

## Brainstorm Summary
**Approaches considered:** (A) add the trigger label at the bughunt call site via a shared
`DEFAULT_TRIGGER_LABEL` constant in contracts; (B) inject the label inside the `createIssue`
activity from env; (C) make the label per-project config in `ProjectConfig`.
**Chosen approach:** A — add `agentops` to the filed-issue labels, sourced from a new shared
constant used by both gateway and bughunt.
**Why (decisive reasons):** Fixes the real defect at the label's owning site, respects the
workflow determinism boundary (a pure constant), and kills the duplicated `'agentops'` magic
string that caused the drift. B overloads a generic activity and couples the worker to a
gateway env it doesn't set; C models per-project flexibility that doesn't exist.
**Key risks/assumptions:** The "required" label is the gateway trigger label defaulting to
`'agentops'`; the workflow can't read `TRIGGER_LABEL`, so a non-default gateway override remains
an out-of-scope residual gap. Existing `bug`/`whitebox` labels are kept; dedup behavior is
unchanged.
