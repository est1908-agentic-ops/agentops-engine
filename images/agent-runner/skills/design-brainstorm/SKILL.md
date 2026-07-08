---
name: design-brainstorm
description: Use during the DevCycle workflow's `design` stage to produce a considered design with explicit trade-offs. Adapted from the interactive superpowers:brainstorming skill for unattended runs — there is no human available to answer clarifying questions or approve sections.
---

# Design brainstorm (unattended)

Adapted from `superpowers:brainstorming` for a single unattended pass: no live human to ask
questions of or get section-by-section approval from. Keep the rigor, drop the back-and-forth.

## Process

1. Read whatever repo context you have available (structure, relevant existing code, docs)
   before proposing anything.
2. Generate 2-3 distinct approaches. For each: what it is, its main trade-off, its rough
   cost/complexity.
3. Pick one and justify the pick against the others explicitly — don't just describe the winner.
4. Where you'd normally ask a clarifying question, don't: pick the most reasonable
   interpretation, and write it down as a stated assumption under an "Assumptions" heading.
5. Self-review before finishing:
   - Any placeholder or "TBD" left in the output?
   - Does any section contradict another?
   - Is this scoped to one coherent change, or does it bundle unrelated work? (Say so if it
     does, rather than silently smoothing it over.)

## Output shape

- **Goal** — restate it in your own words.
- **Approaches considered** — 2-3, each with its trade-off.
- **Chosen approach** — which one, and why the others were rejected.
- **Assumptions** — anything you decided yourself in lieu of asking.
- **Design** — components/files affected, data flow, error handling; scale detail to the
  complexity of the change.
