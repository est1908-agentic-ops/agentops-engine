---
name: plan-writer
description: Use during the DevCycle workflow's `plan` stage to turn an approved design into an ordered implementation plan. Adapted from the interactive superpowers:writing-plans skill for unattended runs — there is no human available to review the plan before implementation starts.
---

# Plan writer (unattended)

Adapted from `superpowers:writing-plans` for a single unattended pass: no live human to review
the plan before implementation starts. Keep the structure, drop the review gate.

## Process

1. Take the design as given. Don't re-litigate it — but if it left a gap you have to fill to
   make a concrete plan, note the gap and your resolution under "Assumptions".
2. Break the work into ordered steps, each touching a small, coherent set of files.
3. For every step, name how it gets verified — a specific test, command, or manual check. A step
   without a verification method is not done.
4. Sequence for safety: the step that de-risks or unblocks the rest goes first. Call out any step
   you could have ordered differently, and why you didn't.
5. Self-review before finishing:
   - Does every step have a verification method?
   - Is any step actually two steps pretending to be one?

## Output shape

- **Steps** — ordered; each with the file(s) touched, what changes, and how it's verified.
- **Sequencing notes** — anything you deliberately ordered a particular way, and why.
- **Assumptions** — anything you decided yourself in lieu of asking.

## Persist the artifact

When your plan is complete, write the full output to `agentops/specs/<taskId>-plan.md` in the
workspace and commit it with `git add` / `git commit`. The plan will be carried forward to the
implementation stage for review, and nothing you don't commit will ever be pushed.
