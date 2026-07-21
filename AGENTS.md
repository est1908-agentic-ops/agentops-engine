# Working in agentops-engine

Rules for any agent (or human) implementing in this repo. The target development model — the Software Lifecycle Development System (SLDS) — lives in the [README](README.md#the-software-lifecycle-development-system-slds). Before proposing, designing, or implementing any workflow change, read that section first and state whether the change aligns with it or requires the SLDS to change. Dated notes in `docs/superpowers/specs/` are implementation history, not product authority.

## Stack

- Node 22+, **pnpm** workspaces, TypeScript strict mode everywhere.
- Temporal TypeScript SDK (`@temporalio/*`); tests with **vitest** + `@temporalio/testing`.
- Schemas with **zod** in `packages/contracts` — all cross-package data shapes are zod-validated at boundaries.
- Lint/format: eslint + prettier, repo-level config, no per-package overrides.

## Hard rules (violating these = rejected PR)

1. **Determinism boundary.** Code in `packages/workflows` may not do I/O, use `Date.now()`, `Math.random()`, timers, or import from `activities`/`ports`/`backends`. All side effects go through Temporal activities (proxied). Workflow-safe utilities only.
2. **`packages/policies` stays pure.** No Temporal imports, no I/O, no async where avoidable. Pure functions with exhaustive unit tests. This package encodes the battle-tested repair-loop, verdict-parsing, brake, and babysit semantics — behavior changes require updating the corresponding test _and_ a note in the PR description explaining why the semantic is safe to change.
3. **Contracts first.** New data shapes are added to `contracts` with a zod schema before use. No `any`, no structural duplication of a contract type.
4. **Ports, not vendors.** Nothing outside `ports/` may import a forge/tracker SDK or call their APIs. Nothing outside `backends/` may spawn an agent CLI.
5. **No secrets in code or fixtures.** Tokens come from env at runtime; tests use the `stub` backend and `memory` ports.
6. **Every PR runs green locally first**: `pnpm lint && pnpm typecheck && pnpm test`. The e2e suite (`pnpm e2e`) must pass for changes touching workflows, policies, activities, or backends.

## Conventions

- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`).
- Workflow changes start with the SLDS in the [README](README.md#the-software-lifecycle-development-system-slds): preserve its lifecycle and principles, or update it deliberately before changing behavior.
- One package per concern; do not create new top-level packages without documenting the design in the same PR.
- Prompts live in `packages/prompts` as versioned files, never inline strings in code.
- Stage and status names are fixed vocabulary (`StageSchema`/`TaskStatusSchema` in `packages/contracts`) — do not invent synonyms; adding one is a deliberate contract change.
- Docs: the SLDS section of the [README](README.md#the-software-lifecycle-development-system-slds) is the authority for the development lifecycle. Feature-level design notes may add implementation detail but may not contradict it. Update the SLDS in the same PR when the target lifecycle changes.

## Definition of done (any task)

Code + tests + typecheck green, e2e green if applicable, docs updated if behavior/design changed, no TODOs without a linked issue.
