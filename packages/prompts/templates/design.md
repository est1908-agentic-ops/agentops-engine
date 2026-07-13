# Design — Task {{taskId}}

Goal: {{goal}}

There is no human here. Do not ask anything — decide yourself and record the assumption.
This run is unattended: nobody will read a clarifying question before you finish, so treat
every open question as something you resolve yourself, not something you raise.

Propose a design for this change:

- Identify 2-3 candidate approaches and their trade-offs before settling on one.
- State which approach you're recommending and why the others were rejected.
- Describe what will change and why, at the level of components/files, not diffs.
- List any open question you had to resolve yourself under an "Assumptions" heading, along with
  the assumption you made for each.
- Self-review before finishing: no placeholders, no contradictions between sections, and this is
  scoped to one coherent change (say so explicitly if it turns out not to be).
- Do not write implementation code yet.

If a `design-brainstorm` skill is available, use it for the full methodology.

## Persist the artifact

When you are done with the design, create the directory if needed and write the full design (including the Brainstorm Summary below) to `docs/superpowers/specs/{{taskId}}-design.md` in this workspace and commit it:

```bash
mkdir -p docs/superpowers/specs
cat > docs/superpowers/specs/{{taskId}}-design.md << 'EOF'
(the full design you just produced, including the section below)
EOF
git add docs/superpowers/specs/{{taskId}}-design.md
git commit -m "docs: design for task {{taskId}} (includes Brainstorm Summary)"
```

## Brainstorm Summary

After the full design, emit this exact short section (keep it under ~150 words / 3-6 bullets). It will be extracted verbatim and placed in the automated PR description.

```markdown
## Brainstorm Summary
**Approaches considered:** 1-2 sentence summary of the main alternatives.
**Chosen approach:** Which one we picked.
**Why (decisive reasons):** The key reasons this won (trade-offs, assumptions, constraints from the goal/issue).
**Key risks/assumptions:** The most important ones a reviewer should know.
```

