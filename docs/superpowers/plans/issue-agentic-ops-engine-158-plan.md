# Plan — Verify engine `full_verify` runs pnpm install/lint/typecheck/test cleanly in the agent-runner workspace

Task: issue-agentic-ops-engine-158 · 2026-07-24
Design: `docs/superpowers/specs/issue-agentic-ops-engine-158-design.md`

## Summary of the change

The design (approach A) is: add one `corepack enable && corepack prepare pnpm@9.15.9
--activate` layer to `images/agent-runner/Dockerfile` (before `USER 1000`, with a
world-readable `COREPACK_HOME`) so the base agent-runner image carries pnpm, then
prove the exact `full_verify` command sequence runs green. No config, contract,
workflow, policy, activity, or backend changes.

The command sequence `full_verify` produces for this repo (from `agentops.json`:
`fastVerifyCommands` + `fullVerifyCommands`) is:

```
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:policies-coverage
```

## Steps

### Step 1 — Prove the corepack+pnpm sequence and the repo's verify pass green on the node:22 base (de-risk first)

This planning/build workspace is `node v22.23.1` with `corepack 0.34.6` — the exact
base the agent-runner image derives from (`FROM node:22-slim`), with the same bundled
corepack. Running the sequence here validates two independent risks *before* touching
the Dockerfile:

  1. that `corepack prepare pnpm@9.15.9 --activate` succeeds and yields a working
     `pnpm` (the Dockerfile `RUN` logic), and
  2. that this repo's five verify commands actually exit 0 (the "verify" half of the
     task goal), independent of the container packaging.

- **Files touched:** none (verification only).
- **Action:**
  - `corepack enable && corepack prepare pnpm@9.15.9 --activate`
  - `pnpm install --frozen-lockfile`
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm test:policies-coverage`
- **Verify:** every command exits 0. Capture per-command results for the PR
  description. If `--frozen-lockfile` fails on lockfile drift unrelated to the
  toolchain, surface it as a separate finding — do **not** mask it (per design). If
  `pnpm test` / `test:policies-coverage` reveal a pre-existing repo failure unrelated
  to pnpm availability, record it as a finding; the image change is still correct but
  the task's "clean pass" claim must reflect reality.

### Step 2 — Add corepack/pnpm to `images/agent-runner/Dockerfile`

- **File touched:** `images/agent-runner/Dockerfile`.
- **Change:** immediately before the trailing `USER 1000` line (currently line 56),
  insert:
  - `ENV COREPACK_HOME=/opt/corepack` (a world-readable path outside root's HOME so
    UID 1000 can read the warmed cache at runtime).
  - `RUN corepack enable && corepack prepare pnpm@9.15.9 --activate && chmod -R a+rX "$COREPACK_HOME"` —
    run as root (still root at this point, before the `USER 1000` switch) so shim
    installation into the global bin dir and cache warming both succeed, then make the
    cache + shims world-readable so UID 1000 uses the pre-warmed pnpm without a network
    fetch.
  - A short comment explaining *why corepack, not `npm i -g pnpm`*: corepack keeps
    pnpm version resolution driven by each downstream repo's `packageManager` field;
    `9.15.9` is only the pre-warmed default (matches this repo's root `package.json`
    `packageManager`).
- **Placement rationale:** must precede `USER 1000` (root is required for both the
  global shim install and writing `COREPACK_HOME`). Placing it after the CLI
  `npm install -g` lines keeps the existing layer order (rarely-changing OS/tooling
  layers stay cached) and groups it with the other toolchain installs.
- **Verify:**
  - Dockerfile parses / lints — run `hadolint images/agent-runner/Dockerfile` if
    available; otherwise a manual review against the docker/dockerfile:1 syntax already
    declared at the top of the file.
  - The `RUN` command is *identical in effect* to the corepack lines proven green in
    Step 1, so Step 1 is the substantive proof that this layer will build and produce
    a working pnpm. (See Step 3 for why a local `docker build` is not the gate here.)

### Step 3 — Verify the image build path

- **Files touched:** none.
- **Constraint (recorded assumption):** `docker` is **not available** in this
  planning/implementation workspace (`command -v docker` → not found). The
  authoritative image build therefore happens in CI:
  `.github/workflows/ci.yaml` job `build-agent-runner-image` uses
  `docker/build-push-action@v6` against `images/agent-runner/Dockerfile` and pushes
  `agent-runner:${sha}` + `:latest`. A green CI build of that job on the PR is the
  build verification.
- **Verify:**
  - Local: `git diff` shows the Dockerfile edit is well-formed and syntactically
    valid; the added `RUN`/`ENV` mirror Step 1's proven commands.
  - CI: the `build-agent-runner-image` job builds and pushes successfully on the PR.
  - Record in the PR description that the container-as-UID-1000 offline-cache check
    from the design's "verify half" is discharged by (a) Step 1 proving the corepack
    sequence on the identical node:22 base and (b) CI building the image; a full
    in-container UID-1000 run with network denied is only possible where docker is
    available and is noted as the optional post-merge dogfood confirmation.

### Step 4 — Confirm no other files require change

- **Files checked (no change):**
  - `agentops.json` — verify command strings already correct; no `image` override,
    which is exactly why the base image must carry pnpm. No edit.
  - `charts/engine/values.yaml` — image tag mechanism unchanged; no edit (recorded as
    checked, per design).
  - contracts / workflows / policies / activities / backends — out of scope; the stage
    plumbing (`packages/workflows/src/dev-cycle.ts` concatenating verify commands into
    `packages/prompts/templates/full_verify.md`) already does the right thing.
- **Verify:** `git diff --stat` shows exactly one changed file
  (`images/agent-runner/Dockerfile`) plus the two committed docs artifacts
  (design + this plan).

## Sequencing notes

- **Step 1 before Step 2 (deliberate):** the biggest uncertainty is whether the
  corepack incantation works and whether the repo even passes verify. Running it on
  the identical node:22 base *first* de-risks the Dockerfile edit — if
  `corepack prepare pnpm@9.15.9` or any verify command fails, we learn it before
  packaging, and the design's "the gap collapses / becomes pure verification" branch
  can be taken with evidence.
- **Step 3 could in principle come before Step 4**, but Step 4 is a
  no-op confirmation, so its order is immaterial; it is last so the final `git diff
  --stat` reflects the completed edit.
- **Step 2 is a single coherent edit** (one ENV + one RUN + a comment in one file), not
  two steps: the ENV and the RUN are meaningless apart (the RUN's `chmod` targets the
  ENV path) and belong in the same layer-ordering decision.

## Assumptions

- **The gap is real (no pnpm in the base image today).** Confirmed by reading
  `images/agent-runner/Dockerfile`: it installs only the two agent CLIs via
  `npm install -g` and never runs `corepack enable`, so `pnpm` is not on PATH. If Step
  1 or a live run showed pnpm already reachable, the Dockerfile edit collapses to zero
  and the task becomes pure documented verification — but the read confirms it is not.
- **Default pnpm pinned to `9.15.9`**, matching this repo's root `package.json`
  `packageManager` field, so the pre-warmed corepack cache serves the engine's own
  offline runs. Downstream products with a different `packageManager` pin still resolve
  correctly via corepack on first use.
- **`docker` is unavailable in this workspace**, so the local image-build gate is
  Dockerfile validity + Step 1's proof on the identical base; the authoritative build
  is CI's `build-agent-runner-image` job. Assumption made in lieu of asking because the
  run is unattended and no container runtime is present.
- **`COREPACK_HOME=/opt/corepack` with `chmod -R a+rX`** is the concrete mechanism for
  the design's "world-readable corepack home" requirement — chosen so the warmed cache
  and shims are readable by UID 1000 at runtime. Any other world-readable path outside
  root's `$HOME` would work equally; `/opt/corepack` is picked for clarity.
- **npm-registry network access exists at run time** in the cluster (the image already
  `curl`s external URLs and `npm install -g`s at build time), so
  `pnpm install --frozen-lockfile` can fetch deps in a live stage Job. This is an
  existing environmental precondition, not introduced by this change.
