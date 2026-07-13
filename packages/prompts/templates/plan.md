# Plan — Task {{taskId}}

Goal: {{goal}}

There is no human here. Do not ask anything — decide yourself and record the assumption.
This run is unattended: nobody will review this plan before implementation starts, so resolve
every open question yourself instead of raising it.

Before planning, read the design specification in `agentops/specs/{{taskId}}-design.md` to
understand the approach you're planning for.

Turn the design into a concrete, ordered implementation plan:

- List the files that change, in the order you'll change them.
- For each step, state how you'll verify it (test, command, or manual check) — a step without a
  verification method isn't done.
- Sequence for safety: put the step that de-risks or unblocks the rest first, and call out any
  step you could reorder and why you didn't.
- List any open question you had to resolve yourself under an "Assumptions" heading, along with
  the assumption you made for each.
- Do not write implementation code yet.

If a `plan-writer` skill is available, use it for the full methodology.

## Persist the artifact

When you are done with the plan, write it to `agentops/specs/{{taskId}}-plan.md` in this
workspace and commit it with `git add` / `git commit`. This plan will be carried forward to the
implementation stage, and nothing you don't commit will ever be pushed or reviewed.
