# Software Lifecycle Development System (SLDS)

This document is the source of truth for how Agentic Ops develops, repairs, and
improves software. It defines the target lifecycle. The current implementation
may be incomplete, but every upcoming change must move toward this model or
update this document deliberately.

## Software development cycle

Humans define the product vision, architecture, intent, and ideas. The SLDS
turns that direction into working software:

- `devCycle` implements human-defined intent as a merge-ready change.
- Autonomous recurring workflows, such as bug hunting and self-healing,
  continuously discover improvements and turn aligned findings into
  merge-ready PRs through the same development cycle.
- Autonomous work may proceed only when it is aligned with the product vision
  and architecture. Work that would change either requires a human decision
  first.

`devCycle` turns an issue into a merge-ready pull request:

**Issue → Context → Assess → Design → Plan → Implement ↔ Verify ↔ Review → PR →
Babysit ↔ Repair → Merge-ready**

Stages may be skipped when policy determines they add no value. Verification
failures, review findings, CI failures, and PR comments return the change to the
repair loop.

## Development workflows

- **Issue development (`devCycle`)** — turns an issue into a verified, reviewed,
  merge-ready PR.
- **PR repair (`devCyclePrRepair`)** — responds to review feedback on an existing
  PR, verifies the repair, and babysits it back to merge-ready.
- **Bug hunting (`whiteboxBugHunt`)** — inspects source code, deduplicates
  findings, and files issues that enter the issue development lifecycle.
- **Self-healing (`selfHeal`)** — inspects failed platform runs, diagnoses
  actionable failures, and starts issue development workflows for proposed
  fixes.
- **Platform assistance (`platform`, `platformChat`)** — investigates the
  running system using operational evidence and can initiate development work.
- **Project workflows** — use configured built-in workflows where possible;
  projects may provide custom Temporal workflows when their lifecycle cannot be
  expressed by configuration.

## System principles

- **One connected system.** Findings become issues, issues become PRs, PR
  feedback becomes repairs, and platform failures become new development work.
- **One quality bar.** Every code-producing path converges on implementation,
  verification, review, and PR babysitting.
- **Durable autonomy.** Workflows are resumable, observable, bounded by brakes,
  and able to wait for human input without losing progress.
- **Humans set intent and authority.** Agents execute the lifecycle continuously;
  project policy determines approval and merge authority.
- **Reuse before invention.** New capabilities should compose existing workflows
  and stages rather than create parallel delivery pipelines.
- **Extensible by projects.** Configuration is preferred; custom workflows are
  used only when the lifecycle shape is genuinely project-specific.

## Evolving this vision

Every workflow change must define its trigger, outcome, quality gates, and how
its output re-enters the wider development system. Feature-level design notes
may add implementation detail, but must remain consistent with this document. A
change to the lifecycle itself requires updating this document in the same PR.
