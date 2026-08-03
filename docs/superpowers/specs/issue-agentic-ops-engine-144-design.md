# Design — Task issue-agentic-ops-engine-144

Goal (issue text): *"GDT Агент. Хранить задачи в md файле не json. Я хочу чтобы это было
понятно человеку тоже. Храни все в одном файле. Просто разбей по разделам #Inbox, #Next..."*

## Goal (restated)

Build a **GTD** ("GDT" is a typo for *Getting Things Done*) task agent whose store of
record is a **single, human-readable Markdown file** — not JSON. Tasks are organized into GTD
list sections (`Inbox`, `Next`, `Waiting`, `Someday`, `Done`). A human must be able to open the
file and read/edit it directly, and the agent must round-trip those edits without clobbering
them.

## Scope note (alignment)

This is deliberately called out per repo rules (`AGENTS.md`). The GTD agent is **orthogonal to
the Software Lifecycle Development System** (`docs/software-lifecycle-vision.md`): it does not
add or change any `devCycle` / PR-landing / bug-hunt / self-heal workflow, touches none of the
Temporal determinism boundary, and introduces no development-lifecycle behavior. It is a
self-contained utility feature. Because it adds a new top-level package, this design doc is the
"document the design in the same PR" artifact that `AGENTS.md` requires; it does **not** require
editing the lifecycle vision, since it adds no workflow. This is one coherent change.

## Approaches considered

### A. Markdown as the source of truth (recommended)
A single `tasks.md` is the *only* store. GTD lists are `##` headings; each task is a GitHub-
Flavored-Markdown checkbox list item (`- [ ] text`) with light inline metadata. A pure
parser/serializer round-trips file ⇄ typed model; a thin file-backed store does add/list/
move/complete by reading, mutating the model, and rewriting the file.
- **Trade-off:** No hidden database — the human and the agent edit the same bytes, so the
  parser must be *lenient* (preserve unknown sections and unrecognized lines verbatim) and the
  serializer must be *stable* (minimal, deterministic diffs). More parsing care; zero data-
  duplication risk.

### B. JSON store with a rendered Markdown *view*
Keep the existing JSON-ish habit internally, emit `tasks.md` as a read-only projection.
- **Rejected:** The issue explicitly says *"не json"* ("not json") and *"понятно человеку…
  храни все в одном файле"* — the human is meant to *edit* the Markdown, not read a generated
  mirror. Two-copy designs also invite drift and a sync/merge problem the goal doesn't want.

### C. Markdown body + YAML frontmatter hybrid
Structured fields (ids, dates, contexts) live in per-task YAML; prose lives in the body.
- **Rejected:** Less human-friendly than plain checkbox lists, and the issue's own guidance
  ("just break it into sections #Inbox, #Next…") points at simple headed lists, not frontmatter.
  Frontmatter is also overkill for the small field set GTD needs.

## Chosen approach

**Approach A.** It is the literal reading of the goal (Markdown *is* the store, one file, human-
readable, section-based) and it eliminates the drift/sync failure mode that sinks B, while
staying simpler and more legible than C. The only real cost — writing a tolerant, stable
Markdown round-trip — is bounded and fully unit-testable, which matches this repo's zod-
contract-first, high-test-coverage conventions.

## Design (components / files)

### Contract first (`packages/contracts`)
- `src/gtd-task.ts` — new zod schemas, exported from `src/index.ts`:
  - `GtdListSchema` = fixed vocabulary enum `['inbox','next','waiting','someday','done']`
    (canonical GTD lists; the `Done` list captures completed items). New fixed vocabulary,
    added deliberately per the "fixed vocabulary" convention.
  - `GtdTaskSchema` = `{ id, text, list, context?, project?, due? (ISO date), done (bool) }`.
  - `GtdDocumentSchema` = ordered lists of tasks plus a carrier for *preserved unknown blocks*
    (raw text the parser didn't recognize), so lenient round-tripping is type-safe.

### New package `packages/gtd`
- `src/markdown-store.ts` — **pure** functions `parse(md): GtdDocument` and
  `serialize(doc): string`. No I/O, no clock, exhaustively unit-tested (parse→serialize→parse
  is idempotent; unknown sections/lines survive verbatim; human-written tasks without an id are
  accepted). This is the risky core and is kept side-effect-free so it can be tested like a
  `policies`-style pure module.
- `src/gtd-store.ts` — file-backed CRUD over one Markdown file: `add`, `list`, `move`,
  `complete`. Reads the file (missing file ⇒ empty document with the canonical section
  skeleton), mutates the typed model, serializes, and writes **atomically** (temp file +
  rename) to avoid corrupting the human's file on a crash. File path from arg or `$GTD_FILE`,
  default `./tasks.md`.
- `src/main.ts` — the agent/CLI surface: `gtd add "<text>" [--list next] [--context @home]
  [--project +x] [--due 2026-07-20]`, `gtd list [--list next]`, `gtd move <id> <list>`,
  `gtd done <id>`. Flag parsing mirrors the existing `packages/cli` style.
- `src/*.test.ts` — vitest unit tests for the parser/serializer and store; no network, no
  secrets, temp-dir filesystem only.
- `package.json` / `tsconfig.json` — standard workspace package wiring; depends only on
  `@agentops/contracts` and Node builtins.

### On-disk format (`tasks.md`)
```markdown
# GTD

## Inbox
- [ ] Buy milk

## Next
- [ ] Ship the release @laptop +release !2026-07-20 ^k2p9

## Waiting
- [ ] Reply from Alice

## Someday
- [ ] Learn Rust

## Done
- [x] Set up repository ^a1b2
```
- Inline tokens: `@context`, `+project`, `!YYYY-MM-DD` (due), and a short trailing `^id`.
- `[x]` vs `[ ]` encodes completion; the `Done` section is the resting place for completed work.

### Data flow
CLI command → `gtd-store` reads `tasks.md` → `markdown-store.parse` → typed `GtdDocument`
(zod-validated) → mutate → `markdown-store.serialize` → atomic write. `list` renders without
writing.

### Error handling
- Missing file: treated as an empty document; first write creates it with canonical sections.
- Malformed / unrecognized lines and unknown `##` sections: **preserved verbatim** so agent
  writes never destroy human edits.
- Atomic write (temp + rename) prevents partial/corrupt files.
- Unknown `--list` value or bad `--due` date: rejected by zod at the boundary with a clear error.

## Assumptions

- **"GDT" means "GTD" (Getting Things Done).** The `#Inbox`/`#Next` sections are canonical GTD
  lists, so I read the typo as GTD and use the standard list set (`Inbox`, `Next`, `Waiting`,
  `Someday`, `Done`).
- **This is a new standalone feature, not a change to an existing store.** No current
  JSON-backed "task list" in this repo matches GTD tasks (the JSON artifacts under `.agentops/`
  are agent stage outputs, unrelated), so nothing is migrated; the agent is additive.
- **Sections beyond the issue's `#Inbox, #Next` are needed.** The issue trails off with "…"; I
  include the standard `Waiting`/`Someday`/`Done` to make GTD usable, and preserve any other
  sections a human adds.
- **Stable identity via an unobtrusive `^id`.** To let the agent reliably move/complete a
  specific task, a short caret id is appended on write; tasks a human types without one are
  still accepted (matched by text) and get an id on the next write.
- **Delivery surface is a CLI/agent command in a new `packages/gtd` package**, not a Temporal
  workflow — the goal is a personal task tool, not a lifecycle workflow, and this keeps it clear
  of the determinism boundary.
- **File location** defaults to `./tasks.md`, overridable via `$GTD_FILE`.

## Self-review
- No placeholders or TBDs.
- No contradictions: Markdown is the single source of truth throughout; JSON is explicitly not
  used for storage (the `GtdTask` zod *schema* validates in-memory shapes only).
- Scope is one coherent change: a new `packages/gtd` package + its `GtdTask` contract. It does
  not bundle unrelated engine work and does not alter the SLDS lifecycle.

## Brainstorm Summary
**Approaches considered:** (A) Markdown file as the single source of truth with a lenient
round-trip parser; (B) keep JSON internally and render a read-only Markdown view; (C) Markdown
body plus per-task YAML frontmatter.
**Chosen approach:** (A) — one human-editable `tasks.md` with GTD sections is the store of record.
**Why (decisive reasons):** The goal literally says "not json / one file / human-readable /
split by #Inbox, #Next" — B reintroduces JSON and a drift/sync problem, C is heavier and less
legible. A's only cost (a tolerant, stable Markdown round-trip) is bounded and unit-testable.
**Key risks/assumptions:** "GDT"→GTD; new additive `packages/gtd` + `GtdTask` contract, no
migration; parser must preserve human-written/unknown content verbatim and writes must be
atomic; feature is orthogonal to the SLDS lifecycle (flagged, no vision change needed).
