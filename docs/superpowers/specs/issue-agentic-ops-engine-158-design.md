# Verify engine `full_verify` runs pnpm install/lint/typecheck/test cleanly in the agent-runner workspace — Design

Status: draft · 2026-07-24 · Task: issue-agentic-ops-engine-158

## Goal

Guarantee that when the engine dogfoods itself, the `full_verify` stage's command
sequence — `pnpm install --frozen-lockfile` → `pnpm lint` → `pnpm typecheck` →
`pnpm test` → `pnpm test:policies-coverage` (fast + full, from this repo's
`agentops.json`) — actually runs to a clean pass inside the `agent-runner`
workspace, and prove it with an observed run rather than by assumption.

## How `full_verify` actually executes (grounding)

The engine does **not** run verify commands itself. At the `full_verify` stage,
`packages/workflows/src/dev-cycle.ts` concatenates
`config.fastVerifyCommands + config.fullVerifyCommands` and injects them into the
`packages/prompts/templates/full_verify.md` prompt; the agent CLI's own bash tool
executes them inside the stage Job container. That container is built from
`images/agent-runner/Dockerfile` and launched as a K8s Job by
`packages/backends/src/k8s/k8s-job-runner.ts` (`buildAgentJob`), with
`workingDir` = the shared-PVC workspace checkout of the repo.

So "does `full_verify` run cleanly" reduces to: **can the tools referenced by this
repo's verify commands run in the agent-runner container against a checkout of the
repo?**

## The gap this task surfaces

`images/agent-runner/Dockerfile` is `node:22-slim` + `ca-certificates curl git
openssl` + `kubectl` + the two agent CLIs (`claude`, `pi`) installed via
`npm install -g`. It contains **no pnpm**, and does not run `corepack enable`.
The base `node:22-slim` image bundles the `corepack` binary but leaves its shims
uninstalled, so `pnpm` is not on `PATH`.

This repo's `agentops.json` sets **no `image` override**, so its stage Jobs run on
the base image. Therefore the first `full_verify` command,
`pnpm install --frozen-lockfile`, would fail today with `pnpm: command not found`,
and the stage would return `FULL: FAIL` before any lint/typecheck/test ran. Fixing
this gap is the substance of the task; the "verify" is confirming the fixed image
runs the full sequence green.

The `image` / `services` / `initCommands` config fields from
`2026-07-07-product-verify-environment-design.md` are now implemented
(`packages/contracts/src/project-config.ts`), which is what makes the alternatives
below viable to weigh. Note `initCommands` run in the **worker** activity
(`packages/activities/src/workspace/workspace-manager.ts`), not in the agent-runner
Job, so they cannot supply pnpm to the verify step — this rules them out as a fix
path.

## Approaches considered

### A. Add corepack/pnpm to the base `agent-runner` image *(recommended)*

Add one `RUN corepack enable && corepack prepare pnpm@9.15.9 --activate` layer to
`images/agent-runner/Dockerfile` (as root, before the trailing `USER 1000`), with a
world-readable `COREPACK_HOME` so the pinned pnpm is available to UID 1000 at
runtime without a network fetch.

- **Trade-off:** bakes a default pnpm version into a shared image. Mitigated by
  corepack honoring each repo's `packageManager` field — the pinned `9.15.9` is
  only the pre-warmed default; a downstream product pinning a different version
  still resolves correctly (fetching on first use). One extra small image layer.
- **Cost/complexity:** low. One Dockerfile change + a verification run.

### B. Engine declares its own `image` in `agentops.json`

Have this repo ship an `agentops/Dockerfile` extending `agent-runner` +
`corepack enable`, publish it via CI, and set `"image"` in `agentops.json` — the
exact pattern the verify-environment design prescribes for external products.

- **Trade-off:** heaviest. Requires a new published image, a new CI build/push
  target, and a `:latest`-style tag pin — all so the engine can dogfood on a
  near-copy of the base image. Circular: the engine *is* the base image's owner.
- **Cost/complexity:** high; rejected.

### C. Bootstrap pnpm inside the verify commands in `agentops.json`

Prepend `corepack enable` (or use `corepack pnpm ...`) inside this repo's
`fastVerifyCommands`.

- **Trade-off:** no image change, but `corepack enable` as UID 1000 writes shims
  to a root-owned global bin dir and would fail on permissions; it also leaks an
  image deficiency into product verify config and re-runs on every stage. Fragile.
- **Cost/complexity:** low effort but brittle; rejected.

## Chosen approach

**A — add corepack/pnpm to the base `agent-runner` image.** Decisive reasons:

1. The engine dogfoods on the *base* image with no override, so the base image
   must carry pnpm regardless — B and C are extra machinery layered on top of a
   base that is still deficient.
2. pnpm is table-stakes for the dominant JS toolchain; the verify-environment
   design's own `acme` example manually layers `corepack enable` on top of
   `agent-runner`. Putting corepack in the base removes that per-product
   boilerplate for every Node/pnpm product while staying version-correct via
   `packageManager` resolution.
3. It is the smallest, most contained change and it directly discharges the task
   goal (full_verify runs clean) rather than deferring it behind a new image
   pipeline.

B is rejected as disproportionate and circular; C is rejected as permission-fragile
and a config/image separation-of-concerns violation.

## Assumptions

- **The gap is real and unfixed.** `agent-runner` has no pnpm today (confirmed by
  reading the Dockerfile). If a live run shows pnpm is already reachable, the code
  change collapses to zero and the task becomes a pure documented verification —
  the design still holds, minus the Dockerfile edit.
- **Pin default pnpm to `9.15.9`**, matching this repo's root `package.json`
  `packageManager` field, so the pre-warmed corepack cache serves the engine's own
  runs offline. (Downstream products with a different pin still resolve via
  corepack.)
- **Registry/network access to the npm registry exists** in the cluster (the image
  already `curl`s external URLs and installs global npm packages at build time), so
  `pnpm install --frozen-lockfile` can fetch dependencies at run time. This is an
  environmental precondition, not something this change introduces.
- **Scope is confirmed single and coherent:** one image capability fix plus its
  verification. No workflow/contract/policy behavior changes.

## Design

### Files affected

- **`images/agent-runner/Dockerfile`** — add, before `USER 1000`:
  an `ENV COREPACK_HOME=<world-readable path>` and a `RUN corepack enable &&
  corepack prepare pnpm@9.15.9 --activate` layer (plus ensuring the corepack-home
  and its cache are readable by UID 1000). Placement matters: corepack shim
  installation and cache warming both require root, so they must precede the
  `USER 1000` switch. A short comment explains why corepack (not a raw
  `npm i -g pnpm`) — it keeps pnpm version resolution driven by each repo's
  `packageManager` field.
- **`charts/engine/values.yaml`** — no change required; the image tag mechanism is
  unchanged. (Listed only to record that it was checked.)
- **No changes** to `agentops.json`, contracts, workflows, policies, activities, or
  backends. The verify command strings and stage plumbing already do the right
  thing; only the container's toolchain was missing.

### Verification plan (the "verify" half of the task)

Build the amended `agent-runner` image locally and, in a container run as UID 1000
with `WORKDIR /workspace` bind-mounted to a clean checkout of this repo, run the
exact concatenated sequence the `full_verify` stage produces:

```
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:policies-coverage
```

Success criterion: every command exits `0`, mirroring what the agent's bash tool
would observe before emitting `FULL: PASS`. Capture the output and record the
result (pass/fail per command) in the PR description. If `--frozen-lockfile` fails
on a lockfile drift unrelated to the toolchain, that is a separate finding to
surface, not something this change masks.

### Error handling / edge cases

- **corepack cache ownership:** if the warmed cache lands under root's HOME it is
  invisible to UID 1000 at runtime, forcing a network fetch (or failing offline).
  The `COREPACK_HOME` env + readable perms addresses this; the verification run is
  what proves it (run as UID 1000, ideally with network denied on the pnpm step to
  confirm the pre-warmed cache is used).
- **Version drift:** if the repo bumps `packageManager`, corepack auto-resolves the
  new version on first use; the baked default only affects offline warmth, not
  correctness.

### Testing strategy

- No unit/e2e test changes: the change is image contents, which the vitest/e2e
  harnesses (stub backend, memory ports) do not and cannot exercise — consistent
  with the verify-environment design's own "no new e2e scenario" conclusion for
  container-runtime behavior.
- The authoritative test is the documented image build + command-sequence run
  above. Optionally, a follow-up dogfood `full_verify` run against a trivial PR
  confirms the end-to-end path once the image is published, but that is deployment,
  not part of this change.

## Self-review

- No placeholders or TBDs.
- No section contradicts another: the gap (no pnpm), the fix (corepack in base
  image), and the verification (run the five commands green) are consistent.
- Scope is one coherent change — a single image capability addition plus its
  verification. It deliberately does **not** touch config schema, workflows, or
  policies.

## Brainstorm Summary
**Approaches considered:** (A) add corepack/pnpm to the base `agent-runner` image; (B) have the engine declare its own extended `image` in `agentops.json` and publish it via CI; (C) prepend a `corepack enable` bootstrap into the repo's verify commands.
**Chosen approach:** (A) add `corepack enable && corepack prepare pnpm@9.15.9 --activate` to `images/agent-runner/Dockerfile`, then verify the full command sequence runs green.
**Why (decisive reasons):** The engine dogfoods on the *base* image with no `image` override, so the base must carry pnpm regardless — making B/C extra machinery over a still-deficient base. corepack keeps pnpm version resolution driven by each repo's `packageManager` field, and putting it in the base removes per-product boilerplate. Smallest, most contained fix that directly discharges the goal.
**Key risks/assumptions:** Confirmed gap — `agent-runner` ships no pnpm today; if a live run shows otherwise the code change is nil and it becomes pure verification. corepack cache must be readable by UID 1000 (world-readable `COREPACK_HOME`) or offline runs break. Assumes npm-registry network access at run time (an existing precondition).
