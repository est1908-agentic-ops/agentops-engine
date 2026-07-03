# Working in agentops-engine

Rules for any agent (or human) implementing in this repo. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before non-trivial work; read [docs/M0-SPEC.md](docs/M0-SPEC.md) before touching anything while M0 is in progress.

## Stack

- Node 22+, **pnpm** workspaces, TypeScript strict mode everywhere.
- Temporal TypeScript SDK (`@temporalio/*`); tests with **vitest** + `@temporalio/testing`.
- Schemas with **zod** in `packages/contracts` — all cross-package data shapes are zod-validated at boundaries.
- Lint/format: eslint + prettier, repo-level config, no per-package overrides.

## Hard rules (violating these = rejected PR)

1. **Determinism boundary.** Code in `packages/workflows` may not do I/O, use `Date.now()`, `Math.random()`, timers, or import from `activities`/`ports`/`backends`. All side effects go through Temporal activities (proxied). Workflow-safe utilities only.
2. **`packages/policies` stays pure.** No Temporal imports, no I/O, no async where avoidable. Pure functions with exhaustive unit tests. This package encodes the battle-tested semantics from ARCHITECTURE.md §2 — behavior changes require updating the corresponding test *and* a note in the PR description explaining why the semantic is safe to change.
3. **Contracts first.** New data shapes are added to `contracts` with a zod schema before use. No `any`, no structural duplication of a contract type.
4. **Ports, not vendors.** Nothing outside `ports/` may import a forge/tracker SDK or call their APIs. Nothing outside `backends/` may spawn an agent CLI.
5. **No secrets in code or fixtures.** Tokens come from env at runtime; tests use the `stub` backend and `memory` ports.
6. **Every PR runs green locally first**: `pnpm lint && pnpm typecheck && pnpm test`. The e2e suite (`pnpm e2e`) must pass for changes touching workflows, policies, activities, or backends.

## Conventions

- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`).
- One package per concern; do not create new top-level packages without an ARCHITECTURE.md update in the same PR.
- Prompts live in `packages/prompts` as versioned files, never inline strings in code.
- Stage and status names are fixed vocabulary (see M0-SPEC §Contracts) — do not invent synonyms.
- Docs: ARCHITECTURE.md is the design authority. If implementation must deviate, change the doc in the same PR and mark the section with the reason.

## Definition of done (any task)

Code + tests + typecheck green, e2e green if applicable, docs updated if behavior/design changed, no TODOs without a linked issue.
