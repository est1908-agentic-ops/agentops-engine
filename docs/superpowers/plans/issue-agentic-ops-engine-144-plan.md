# Plan — Task issue-agentic-ops-engine-144

GTD task agent whose store of record is a single, human-readable Markdown file (`tasks.md`),
organized into GTD sections. Implements **Approach A** from
`docs/superpowers/specs/issue-agentic-ops-engine-144-design.md`: Markdown *is* the store; a
lenient, stable round-trip parser/serializer round-trips human edits without clobbering them.

The work is a new `packages/gtd` package plus one new contract (`GtdTask`) in
`packages/contracts`. It is additive and orthogonal to the SLDS lifecycle (no workflow, no
Temporal, no determinism-boundary code).

## Steps (ordered)

### Step 1 — Contract first: GTD zod schemas
**Files:** `packages/contracts/src/gtd-task.ts` (new), `packages/contracts/src/index.ts` (add
`export * from './gtd-task';`), `packages/contracts/src/gtd-task.test.ts` (new).

**Changes:**
- `GtdListSchema = z.enum(['inbox','next','waiting','someday','done'])` — new fixed vocabulary
  (canonical GTD lists) added deliberately per the AGENTS.md fixed-vocabulary convention.
- `GtdTaskSchema = z.object({ id, text, list: GtdListSchema, context?, project?, due?, done })`.
  `due` validated as an ISO `YYYY-MM-DD` date string (zod `.regex` + refine, no `Date.now()`).
- `GtdDocumentSchema` = `{ tasks: GtdTask[], preserved: <ordered carrier of raw unrecognized
  blocks with their anchor position> }` so lenient round-tripping is type-safe.
- Export inferred TS types (`GtdList`, `GtdTask`, `GtdDocument`).

**Verify:** `packages/contracts/src/gtd-task.test.ts` asserts: valid task parses; unknown `list`
rejected; bad `due` (`2026-13-40`, `not-a-date`) rejected; document with mixed tasks + preserved
blocks validates. Run `pnpm --filter @agentops/contracts run typecheck` and
`pnpm test -- gtd-task`.

**Why first:** every other module imports these types; getting the shape right de-risks the rest.

### Step 2 — Scaffold `packages/gtd` package
**Files:** `packages/gtd/package.json` (new), `packages/gtd/tsconfig.json` (new),
`packages/gtd/src/index.ts` (new, re-exports the public surface).

**Changes:**
- `package.json`: `name: "@agentops/gtd"`, `private`, `main`/`types` → `src/index.ts`,
  `scripts.typecheck: "tsc -p tsconfig.json --noEmit"`, `build`, and a
  `gtd: "tsx src/main.ts"` run script (mirrors `@agentops/cli`'s `engine` script). Dependency:
  `@agentops/contracts: "workspace:*"` only (plus Node builtins).
- `tsconfig.json`: extend `../../tsconfig.base.json`, `outDir: dist`, `rootDir: src`,
  `include: ["src"]` — identical to `packages/policies`.
- `index.ts`: initially re-exports the store API added in later steps (kept minimal to start).
- Run `pnpm install` so the workspace links `@agentops/gtd`.

**Verify:** `pnpm install` succeeds and links the package; `pnpm --filter @agentops/gtd run
typecheck` passes on the (empty) skeleton. `pnpm -r run typecheck` still green.

**Why here:** the package must exist and typecheck before code lands in it; doing it as its own
step keeps a green baseline before the risky parser work.

### Step 3 — Pure Markdown round-trip: `parse` / `serialize`
**Files:** `packages/gtd/src/markdown-store.ts` (new),
`packages/gtd/src/markdown-store.test.ts` (new). Wire exports into `src/index.ts`.

**Changes:**
- `parse(md: string): GtdDocument` — pure, no I/O, no clock. Maps `##` section headings to GTD
  lists; parses `- [ ]` / `- [x]` checkbox items; extracts inline tokens `@context`, `+project`,
  `!YYYY-MM-DD` (due), trailing `^id`. Unknown `##` sections and any unrecognized lines are
  captured verbatim into `preserved` with their position so they survive. Tasks without an `^id`
  are accepted (id left empty; assigned on next serialize).
- `serialize(doc: GtdDocument): string` — deterministic, minimal output: canonical section order
  (`Inbox`, `Next`, `Waiting`, `Someday`, `Done`), stable token ordering, preserved blocks
  re-emitted at their anchors. Assigns a short caret id to any task missing one — id derived
  deterministically (e.g. `sha256` of text+list prefix from `@agentops/contracts`) so the pure
  module stays clock/`Math.random`-free.
- Result of `parse` is validated with `GtdDocumentSchema` before return.

**Verify:** `packages/gtd/src/markdown-store.test.ts` (vitest) covers:
1. round-trip idempotence — `parse → serialize → parse` is a fixed point on the design's sample
   `tasks.md`;
2. `serialize(parse(x))` is stable (second serialize == first);
3. unknown `## Projects` section + a free-text note line survive verbatim;
4. a human-written `- [ ] Buy milk` (no id) parses and gains a stable id on serialize;
5. `!2026-07-20`, `@laptop`, `+release` extracted into the typed fields and re-emitted.
Run `pnpm test -- markdown-store`.

**Why here:** this is the riskiest core (the design's one real cost). It is pure and
exhaustively unit-tested before any file I/O depends on it, so bugs surface in isolation.

### Step 4 — File-backed store: `gtd-store.ts`
**Files:** `packages/gtd/src/gtd-store.ts` (new), `packages/gtd/src/gtd-store.test.ts` (new).
Wire exports into `src/index.ts`.

**Changes:**
- CRUD over one Markdown file using `parse`/`serialize`: `add`, `list`, `move`, `complete`.
- File path resolution: explicit arg → `$GTD_FILE` → default `./tasks.md`.
- Missing file ⇒ empty `GtdDocument` with canonical section skeleton; first write creates it.
- `list` reads and renders without writing.
- Writes are **atomic**: write to a temp file in the same dir, then `fs.rename` over the target.
- `complete` sets `done` + moves the task to the `Done` list; `move` re-parents by id.

**Verify:** `packages/gtd/src/gtd-store.test.ts` uses a temp dir (`fs.mkdtemp`), no network, no
secrets: add→list returns the task; move changes its section; complete marks `[x]` and lands it
in `Done`; a pre-seeded file with a human-added unknown section round-trips through an `add`
without losing that section; a temp artifact is not left behind after an atomic write. Run
`pnpm test -- gtd-store`.

**Why here:** depends on Step 3's pure core; isolating I/O + atomicity here keeps the parser
tests filesystem-free.

### Step 5 — Agent/CLI surface: `main.ts`
**Files:** `packages/gtd/src/main.ts` (new), `packages/gtd/src/main.test.ts` (new).

**Changes:**
- Commands: `gtd add "<text>" [--list next] [--context @home] [--project +x] [--due 2026-07-20]`,
  `gtd list [--list next]`, `gtd move <id> <list>`, `gtd done <id>`.
- Flag parsing mirrors `packages/cli/src/main.ts` `parseFlags` (extract a small helper; reuse
  the same `--key value` shape). Bad `--list` / `--due` rejected by zod at the boundary with a
  clear error message.
- Thin: parses argv, calls `gtd-store`, prints results. `main()` guarded so it only runs when
  invoked directly (importable for tests).

**Verify:** `packages/gtd/src/main.test.ts` drives the exported command handlers against a temp
`$GTD_FILE`: `add` then `list` shows the item; invalid `--due` throws a clear error; `--list
bogus` rejected. Manual smoke: `GTD_FILE=/tmp/tasks.md pnpm --filter @agentops/gtd run gtd add
"Buy milk"` then `... gtd list` prints it and the on-disk `tasks.md` is human-readable. Run
`pnpm test -- main` (gtd).

**Why last:** it is the thinnest layer and depends on everything above.

### Step 6 — Final full verification + docs check
**Files:** none (or a one-line README pointer under `packages/gtd/` if useful).

**Changes:** confirm the design doc already committed on this branch satisfies the AGENTS.md
"document the design in the same PR" requirement (it does — no lifecycle-vision edit needed
since no workflow changes). No `docs/software-lifecycle-vision.md` change required.

**Verify:** run the repo definition-of-done gate from the workspace root:
`pnpm install && pnpm lint && pnpm typecheck && pnpm test`. `pnpm e2e` is **not** required —
this change touches none of workflows/policies/activities/backends. All green = done.

## Sequencing notes

- **Contract before package (Step 1 before 2).** The contract lives in the existing
  `packages/contracts`, which already builds; landing the schema + its test first gives a green,
  reviewable checkpoint and fixes the types every later step imports. Reordering (package first)
  would leave the package importing a not-yet-existing type.
- **Pure core before I/O (Step 3 before 4).** Deliberate: the round-trip parser is the only real
  risk in the design. Keeping it pure and testing it exhaustively before the file layer means
  parser bugs never hide behind filesystem flakiness.
- **CLI last (Step 5).** It is the thinnest layer; nothing depends on it, so it cannot unblock
  anything by moving earlier.
- **Could Steps 3 and 4 merge?** No — that would be two steps pretending to be one (pure logic
  vs. atomic file I/O have different verification methods: fixed-point unit tests vs. temp-dir
  filesystem tests). Kept separate.

## Assumptions

- **"GDT" means "GTD" (Getting Things Done).** Inherited from the design; the `#Inbox`/`#Next`
  sections are canonical GTD lists.
- **New standalone `packages/gtd` + `GtdTask` contract; no migration.** No existing JSON store
  maps to GTD tasks (`.agentops/` artifacts are unrelated agent stage outputs).
- **Section set is `Inbox`, `Next`, `Waiting`, `Someday`, `Done`.** The issue trails off after
  `#Inbox, #Next`; the standard GTD set makes it usable, and any *other* human-added section is
  preserved verbatim rather than dropped.
- **Stable identity via a short trailing `^id`.** Assigned on write; human-typed tasks without
  one are accepted (matched by text) and get an id on the next serialize.
- **Ids are derived deterministically** (from `sha256` of text+list) so `markdown-store` stays
  pure — no `Math.random()`/clock — which keeps its tests deterministic. (Resolved gap: the
  design says "short caret id" but not how to generate it without a clock; deterministic hashing
  is the pure choice.)
- **`preserved` carrier shape.** The design names it but not its structure; I model it as an
  ordered list of raw blocks each with an anchor (before/after which section, or trailing) so
  serialize can re-emit them in place. (Resolved gap.)
- **Delivery is a CLI/agent command**, not a Temporal workflow; file defaults to `./tasks.md`,
  overridable via `$GTD_FILE`.
- **No new vitest alias needed.** Tests live inside `packages/gtd/src/**/*.test.ts` (already
  matched by `vitest.config.ts` `include`) and import only relative modules + the already-aliased
  `@agentops/contracts`, so `vitest.config.ts` needs no `@agentops/gtd` alias.
