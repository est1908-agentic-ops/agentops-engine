# Design — Task issue-agentic-ops-engine-130

**[bughunt] GitHub auth token passed via process argv is exposed to co-resident processes**

## Goal

`SpawnGitCommandRunner` (`packages/activities/src/workspace/spawn-git-command-runner.ts`)
authenticates git over HTTPS by prepending a command-line config override to every
invocation:

```
git -c "http.extraHeader=Authorization: Basic <base64(x-access-token:<TOKEN>)>" <args...>
```

Command-line arguments are world-readable on the host: any co-resident process can read
`/proc/<pid>/cmdline` or run `ps -ef`/`ps auxww` and see the full argv while git is
running. The `Basic <base64>` value is not encryption — it decodes trivially to the raw
GitHub installation/PAT token. So for the lifetime of every `git fetch`/`clone`/`push`,
the credential is leaked to anything else running on the same node (sidecars, other
workflow pods sharing a node, a compromised dependency in the same container).

The fix: stop putting the credential in argv while preserving identical git behavior and
the existing `GitCommandRunner` contract. Env vars are already threaded through this
runner (`GIT_TERMINAL_PROMPT=0`), so the change is contained.

## Approaches considered

### A. Pass the config via `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` env vars

Git ≥ 2.31 reads ad-hoc config from the environment: set `GIT_CONFIG_COUNT=1`,
`GIT_CONFIG_KEY_0=http.extraHeader`, `GIT_CONFIG_VALUE_0=Authorization: Basic <base64>`.
This is the exact env-var equivalent of `-c key=value`, so git resolves it identically.
The runner already builds a per-invocation `env` object, so this is a few-line change in
one file plus its test.

- **Trade-off:** the token moves from argv to the child's environment. `/proc/<pid>/environ`
  is readable only by the process owner (mode 0400, owner-only) — not by *co-resident*
  processes running as other users, and never via `ps`. Same-UID processes and root can
  still read it, but that is a strictly smaller and more standard exposure surface than
  world-readable argv, and it matches how git credentials are conventionally passed.
- **Cost/complexity:** minimal. No new files, no on-disk secrets, no cleanup logic. The
  installed git (2.39.5) and the repo's Node 22 baseline both support it.

### B. Write the header to a temp git config file and reference it via `GIT_CONFIG_GLOBAL` (or `-c include.path=`)

Write `[http] extraHeader = ...` to a `0600` temp file, point git at it, delete after.

- **Trade-off:** removes the token from argv, but writes the plaintext credential to disk
  (another exposure vector — backups, disk forensics, a crash before cleanup leaving it
  behind) and adds mandatory create/cleanup lifecycle around every invocation, including
  the error and spawn-failure paths already handled in this runner.
- **Cost/complexity:** higher — temp-file management, cleanup on every exit path, and new
  failure modes (write fails, cleanup skipped). Strictly worse than A on both security and
  complexity.

### C. Credential helper / `GIT_ASKPASS` script

Configure a `credential.helper` or `GIT_ASKPASS` executable that emits the token on stdout.

- **Trade-off:** keeps the token out of argv, but the helper still has to receive the token
  — via env (same as A) or a file (same as B) — so it adds indirection without removing the
  underlying exposure. It also only covers the credential-lookup path; `http.extraHeader`
  works uniformly for App installation tokens where a username/password helper is awkward.
- **Cost/complexity:** highest — a shipped helper script/binary, PATH/permission concerns,
  and a larger behavioral change to how auth is presented to git.

## Chosen approach

**Approach A** — pass `http.extraHeader` through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/
`GIT_CONFIG_VALUE_0` environment variables instead of `-c` on the command line.

Why A over B and C:

- **Eliminates the reported world-readable exposure** (argv via `/proc/<pid>/cmdline` and
  `ps`) with the smallest, most idiomatic change. Env vars are only readable by the same
  UID/root, closing the co-resident-process leak that motivated the bughunt.
- **No new persistent exposure.** Unlike B, nothing plaintext is written to disk; unlike C,
  no new executable is shipped.
- **Behaviorally identical to the current code.** `GIT_CONFIG_*` is the documented env
  equivalent of `-c`, so fetch/clone/push against GitHub behave exactly as before; the
  `GitCommandRunner` interface and all call sites (`worker`, `cli`, `gateway`) are
  untouched.
- **Lowest risk and cost** — one file changed, one test updated, no lifecycle/cleanup code.

B is rejected for adding an on-disk plaintext secret and cleanup burden while solving no
more of the problem. C is rejected as the most complex option that still has to move the
token through env or disk anyway.

## Assumptions

- **Threat model boundary.** The issue is specifically about *argv* being visible to
  *co-resident* (different-user) processes. Env vars readable only by the same UID/root are
  accepted as the residual surface — matching git's own conventions. If full isolation from
  same-UID processes were required, that is a broader infra change (secret store, sandbox)
  outside this bughunt's scope; not undertaken here.
- **Git version support.** `GIT_CONFIG_COUNT` requires git ≥ 2.31. The environment ships
  2.39.5, and the repo already relies on a modern git for `worktree`/`extraHeader`. No
  runtime version guard is added; if git were older the request would fail loudly rather
  than silently unauthenticated, and the baseline is controlled by this project's images.
- **Only this runner is affected.** A repo-wide grep confirms `http.extraHeader` /
  `x-access-token` appears only in `spawn-git-command-runner.ts`. The Octokit-based
  `build-github-ports.ts` passes the token via an HTTP header in-process (not argv) and is
  out of scope.
- **No secret redaction of git output is added here.** The current runner returns raw
  `stdout`/`stderr`; git does not echo `http.extraHeader` values, so this change neither
  worsens nor is required to fix output leakage. Kept out of scope to stay one coherent
  change.

## Design

**Scope:** one coherent change, confined to a single file and its test.

### Files affected

- `packages/activities/src/workspace/spawn-git-command-runner.ts`
  - Stop prepending the `-c http.extraHeader=...` pair to `fullArgs`. When a token is
    present, `args` is passed to `git` unchanged (no argv mutation at all).
  - When a token is present, extend the per-invocation `env` with:
    - `GIT_CONFIG_COUNT: '1'`
    - `GIT_CONFIG_KEY_0: 'http.extraHeader'`
    - `GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + base64('x-access-token:' + token)`
  - `GIT_TERMINAL_PROMPT: '0'` stays as-is. When no token is present, no `GIT_CONFIG_*`
    vars are set (parity with today's "omit override entirely" behavior).
  - Keep the base64 encoding of `x-access-token:<token>` — that is git's expected
    `Authorization: Basic` credential format, not a security control; it is unchanged.

- `packages/activities/src/workspace/spawn-git-command-runner.test.ts`
  - Replace the assertion that argv is prefixed with `-c http.extraHeader=...` with:
    - argv equals the caller's args verbatim (no injected `-c`) when a token is present, and
    - the child `env` carries `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=http.extraHeader`,
      and the correct `GIT_CONFIG_VALUE_0` base64 header.
  - Keep the no-token case asserting plain args **and** that no `GIT_CONFIG_*` vars leak
    into the env.
  - Existing cwd / exit-code / spawn-failure tests are unchanged.

### Data flow (unchanged except for carrier)

Caller supplies `authToken: () => token` at construction (worker/cli/gateway). Per `run()`,
the runner resolves the token and now places the auth header in the child process
environment rather than its command line. Git reads `GIT_CONFIG_*` on startup and applies
the `http.extraHeader` exactly as the former `-c` override did.

### Error handling

Unchanged. The `'error'` (spawn-failed) and `'close'` handlers, the `settled` guard, and
the `GitCommandResult` shape are untouched. No new failure paths are introduced because no
files are created and no cleanup is required.

### Verification

- Update and run the affected unit test (`spawn-git-command-runner.test.ts`).
- `pnpm lint && pnpm typecheck && pnpm test`. The change touches an activity, so `pnpm e2e`
  is run per AGENTS.md; the e2e path against a stub/local git validates that
  fetch/clone/push still authenticate with the credential now supplied via env.

### Self-review

- No placeholders or TBDs.
- No cross-section contradictions: the residual same-UID exposure is stated consistently in
  Approach A, Chosen approach, and Assumptions.
- Single coherent change: one runner file + its test; unrelated hardening (output
  redaction, same-UID isolation) is explicitly deferred with rationale.

## Brainstorm Summary
**Approaches considered:** (A) pass the git auth header via `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` env vars; (B) write it to a `0600` temp git-config file referenced by `GIT_CONFIG_GLOBAL`; (C) use a `credential.helper`/`GIT_ASKPASS` script.
**Chosen approach:** A — move the `http.extraHeader` credential from the `-c` command-line argument into the child process environment.
**Why (decisive reasons):** Smallest, most idiomatic fix that removes the world-readable argv leak (`/proc/<pid>/cmdline`, `ps`); env vars are readable only by the same UID/root, a strictly smaller surface. B adds a plaintext on-disk secret plus cleanup burden; C adds a shipped helper yet still moves the token through env/disk anyway. Behavior and the `GitCommandRunner` contract are unchanged (git 2.39.5 supports `GIT_CONFIG_*`).
**Key risks/assumptions:** Residual exposure to same-UID/root processes is accepted as in-scope threat-model boundary; requires git ≥ 2.31 (env ships 2.39.5); only `spawn-git-command-runner.ts` is affected — the Octokit port passes tokens in-process, not via argv.
