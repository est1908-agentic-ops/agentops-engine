# Design — Task self-heal-2026-08-11t19-00-00z-platform-fix-1

## Goal

The Claude Code CLI surfaces two account-wide subscription caps. We already recognize the
per-session one ("You've hit your **session limit** · resets 9:30am (UTC)") and classify it as
`SessionLimitError`, which lets `TierFallbackBackend` fall back to another tier/credential domain
and, once tiers are exhausted, fail non-retryably. We do **not** recognize the newer weekly cap
("You've hit your **weekly limit** · resets <time> (UTC)"). That message currently falls through
to a generic `ProcessCliProcessError`, which the activity layer treats as retryable — so every
30-minute self-heal cycle re-hits the same throttled backend and burns Temporal's full 5x retry
budget against a cap that lasts hours/days. This change broadens the detection so the weekly cap
is classified identically to the session cap, plus regression test coverage.

## Approaches considered

1. **Broaden the shared `isSessionLimitMessage` matcher.** Change its regex from
   `session limit` to a `(session|weekly) limit` alternation, keeping the existing mandatory
   "reset" phrase guard. Both `claude-backend.ts` and `pi-backend.ts` already route through this
   one helper, so both inherit the fix; `claude-backend.ts` keeps throwing `SessionLimitError`
   unchanged. Cost: ~1 line of regex + a comment refresh + tests. Trade-off: the helper's name
   ("session") no longer literally spans everything it matches, a minor readability wart.

2. **Add a separate `isWeeklyLimitMessage` helper + a new `WeeklyLimitError` class.** More
   explicit, but `TierFallbackBackend`, `resolve-tier`, and the activity mapping all treat weekly
   and session caps *identically* (account-wide, lasts hours, fall back then fail non-retryably).
   A new error class would require the tier-fallback backend and activity mapping to catch a
   second type for zero behavioral difference, plus a contracts touch. Rejected as pure churn
   with no semantic payoff.

3. **Generalize to a broad quota matcher** — e.g. match any `\w+ limit` + a reset phrase.
   Rejected: the existing code comments deliberately keep this class *narrow* ("so a generic
   outage that happens to mention sessions isn't misclassified"). A catch-all `\w+ limit` would
   sweep in unrelated messages ("rate limit", "usage limit exceeded, contact support") and
   misroute them into the fall-back-then-fail-non-retryably path. Over-broad, against the
   documented design intent.

## Chosen approach

**Approach 1 — broaden the shared matcher.** It fixes the reported gap with the smallest,
most-contained change, and because both Claude and Pi backends already share
`isSessionLimitMessage`, the fix propagates without touching each call site. Approach 2 adds an
error type that every downstream consumer would have to treat as a synonym of the existing one —
churn with no behavior change. Approach 3 violates the explicit "narrow on purpose" design
constraint recorded in the source comments and risks misclassifying generic failures. The only
cost of Approach 1 is that the helper name still says "session" while it now also matches
"weekly"; I mitigate that with an updated comment rather than a rename (see Assumptions).

## Assumptions

- **Classification, not a new error type.** The weekly cap has the same operational semantics as
  the session cap (account-wide, lasts hours/days, same-backend retry is pointless), so it maps to
  the existing `SessionLimitError` / `SessionLimitExhaustedError` machinery. Assumed correct — no
  new error class.
- **Keep the helper name `isSessionLimitMessage`.** Renaming (e.g. to `isSubscriptionCapMessage`)
  would ripple through `claude-backend.ts`, `pi-backend.ts`, and their imports for cosmetic gain.
  I keep the name and update its doc comment to state it now covers both caps. This keeps the
  change to one coherent concern.
- **Reset guard stays mandatory.** The weekly message ("… · resets <time> (UTC)") satisfies the
  existing `\breset` guard, so I keep requiring a reset phrase to avoid misclassifying a bare
  "weekly limit" mention. Assumed the real CLI message always includes the reset clause (it does
  in the observed phrasing).
- **Pi backend inheriting the fix is desired.** `pi-backend.ts` uses the same helper; broadening
  it means Pi also recognizes a weekly-cap message. This is consistent and beneficial, so I do not
  special-case Claude only.

## Design

### Files changed

- **`packages/backends/src/provider-rate-limit.ts`** — the only production logic change.
  - `isSessionLimitMessage`: replace `/session limit/i` with `/(session|weekly) limit/i` while
    keeping the `&& /\breset/i` guard.
  - Refresh the `SessionLimitError` class comment and the function comment to note both the
    "session limit" and "weekly limit" CLI phrasings are matched and classified together.
- **`packages/backends/src/claude/claude-backend.ts`** — no logic change; the `is_error` branch
  already calls `isSessionLimitMessage(...)` → `throw new SessionLimitError(...)`. Update the
  inline comment at that branch (currently only cites "session limit · resets") to mention the
  weekly-limit phrasing as well, so the code reads truthfully. (Comment-only touch, satisfies the
  goal's naming of this file.)

### Tests

- **`packages/backends/src/provider-rate-limit.test.ts`** — add to the `isSessionLimitMessage`
  describe block:
  - matches the real weekly phrasing: `"You've hit your weekly limit · resets 9:30am (UTC)"` → `true`.
  - a weekly-limit variant with an explicit reset timestamp → `true`.
  - negative guard: `"weekly limit exceeded, contact support"` (no reset phrase) → `false`, mirroring
    the existing session-limit negative case, to lock in the narrow-on-purpose behavior.
- **`packages/backends/src/claude/claude-backend.test.ts`** — add a case alongside the existing
  session-limit test (line ~229) asserting that an `is_error: true` result carrying the weekly-limit
  phrasing throws `SessionLimitError`, proving end-to-end classification through `parseOutput`.

### Data flow (unchanged, now triggered by the weekly message)

`claude-backend.parseOutput` sees `is_error: true` → `isSessionLimitMessage` now returns `true`
for the weekly message → throws `SessionLimitError` → `TierFallbackBackend` walks the tier chain
to the next credential domain → if all exhausted, throws `SessionLimitExhaustedError` → the
activity maps that to a **non-retryable** `ApplicationFailure`, ending the pointless 5x retry loop.

### Error handling / risk

No new failure modes. The change can only *reclassify* a message that today is a generic
`ProcessCliProcessError` into a `SessionLimitError`. The mandatory reset-phrase guard and the
tight `(session|weekly)` alternation bound the blast radius; a message must say "weekly limit" (or
"session limit") *and* mention a reset to be reclassified. Existing session-limit and rate-limit
tests remain unchanged and must stay green.

### Scope

This is one coherent change: broaden a single classifier so an already-handled failure class also
recognizes its weekly-cap variant, plus regression tests. No contract, workflow, or SLDS changes.

## Brainstorm Summary
**Approaches considered:** Broaden the shared `isSessionLimitMessage` regex to also match "weekly limit"; or add a separate `WeeklyLimitError` type; or a broad catch-all `\w+ limit` matcher.
**Chosen approach:** Broaden the shared matcher to `(session|weekly) limit` while keeping the mandatory reset-phrase guard.
**Why (decisive reasons):** Weekly and session caps have identical operational semantics (account-wide, lasts hours → fall back then fail non-retryably), so they map to the existing `SessionLimitError` path with no downstream churn; both Claude and Pi backends share the helper so both are fixed at once. A new error type is pure churn; a catch-all violates the code's documented "narrow on purpose" intent.
**Key risks/assumptions:** Reset-phrase guard stays mandatory to avoid misclassifying bare mentions; helper keeps its "session" name (comment-updated, not renamed) to stay one coherent change; Pi backend inheriting the fix is intended.
