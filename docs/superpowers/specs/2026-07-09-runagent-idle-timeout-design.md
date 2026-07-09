# `runAgent` Idle-Timeout & Live Log Streaming — Design

Status: draft · 2026-07-09 · Owner: Artem

## Context

Investigating `issue-broccoli-113`'s `devCycle` workflow (`debug-devcycle-issue`) found the `context` stage's `runAgent` activity failing with `ProcessCliTimeoutError: pi timed out after 600000ms` on attempt 1, and attempt 2 heading for the identical failure. The underlying k8s Job/pod was healthy the entire time (`active:1, ready:1` right up to the kill) — `K8sJobRunner.run()` (`packages/backends/src/k8s/k8s-job-runner.ts:269-273`) enforces a hard wall-clock deadline and kills the Job once elapsed time exceeds `req.limits.timeoutMs`, regardless of whether the CLI is still making progress. That constant is `600_000` (10 min), hardcoded identically for every stage at `packages/workflows/src/dev-cycle.ts:175` — no per-stage or per-task allowance for naturally longer work (this task's issue body alone is several thousand words of root-cause analysis, on top of whatever repo exploration the `context` stage needed).

A second gap surfaced in the same investigation: there was no way to tell *why* it was slow. `K8sJobRunner`'s Job container redirects the CLI's entire stdout/stderr into files on the workspace PVC (`SHELL_REDIRECT`, `k8s-job-runner.ts:61-62`) rather than to the container's own log stream, so Loki captured nothing for the `agent` container — even though ARCHITECTURE.md §5.4 already documents that Job output should stream to Alloy → Loki. `pi --mode json` already emits newline-delimited JSON progress events to stdout as it works (`pi-backend.ts`'s `parseOutput` reads `message_end`/`agent_end` events from exactly this stream) — that liveness signal exists today, it's just invisible outside the finished artifact file.

## Goal

1. A stage only gets killed for being **actually stuck** (no new output for a while), not for merely running long while still producing output.
2. An operator debugging a live workflow can see real progress — via Temporal heartbeat detail *and* live in Grafana/Loki — instead of just "job active, elapsed Nms."
3. Per-stage timeout budgets are configurable in `ProjectConfig`, since different stages have different natural durations (e.g. `context`/`review` vs `implement`).

## Non-goals

- **Full OTel/Tempo span-level instrumentation of CLI cognition** (per-message/per-tool-call spans, matching ARCHITECTURE.md's longer-term tracing vision). Materially bigger — a wrapper binary baked into the agent-runner image, per-backend event-schema mapping, OTel SDK wiring. Worth its own design later; not scoped here.
- **Semantic/backend-specific progress parsing.** Liveness is raw output-file byte growth, not recognized JSONL event types. Simpler, fully generic across `pi`/`claude`/`stub`/future backends, no per-CLI upkeep. Accepted trade-off: a backend that goes silent for one long non-streaming turn could theoretically look idle; the default idle threshold (5 min) is set generously to make this unlikely in practice.
- **Alloy/infra config changes in `agentops-platform`.** Streaming reaches Loki by mirroring into the container's own stdout/stderr, which Alloy already scrapes (`loki.source.kubernetes.pods`) — no new Alloy component, no cross-repo change.
- **Changing `ProcessCliTimeoutError`'s retry classification.** Both new timeout variants (idle and backstop) stay a plain retryable error via the existing fallthrough in `create-activities.ts::runAgent` — Temporal's existing `maximumAttempts: 5` on `agentActivities` governs retries, unchanged.

## Design

### Contracts (`packages/contracts`)

`BackendRunRequest.limits` (`packages/contracts/src/agent-run.ts`) gains `idleTimeoutMs`; the existing `timeoutMs` becomes the overall backstop ceiling:

```ts
limits: z.object({
  maxTokens: z.number().int().positive(),
  idleTimeoutMs: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
})
```

Two shared default constants (used by both workflows below when a stage has no override):

```ts
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000; // 5 min
export const DEFAULT_BACKSTOP_TIMEOUT_MS = 1_800_000; // 30 min
```

`ProjectConfig` (`packages/contracts/src/project-config.ts`) gains an optional per-stage override map, alongside the existing `routing`/`brakes`, using the `StageSchema` already exported from `packages/contracts/src/stage.ts`:

```ts
timeouts: z.record(StageSchema, z.object({
  idleTimeoutMs: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
})).partial().optional()
```

A stage not present in `timeouts`, or a field omitted within it, falls back to the two defaults above. `parseProjectConfig`'s existing shallow-merge-with-defaults logic (`project-config.ts:66-72`, currently merging `stages`/`routing`/`brakes` against `DEFAULT_PROJECT_CONFIG`) gains the same treatment for `timeouts` — otherwise a project supplying an override for one stage would silently lose defaults for every other field, the same class of bug the existing merge already guards against for `routing`.

### `K8sJobRunner` (`packages/backends/src/k8s/k8s-job-runner.ts`)

The poll loop in `run()` keeps its existing `pollIntervalMs` (3s default) cadence and heartbeat-first ordering (unchanged — cancellation must stay noticed just as fast as today). Per tick, before heartbeating:

- `stat()` both `paths.outFile` and `paths.errFile` (missing file → size 0, not an error). If either file's size grew since the previous tick, set `lastProgressAt = this.now()`. Initialized to `start` (job-creation time), so a Job that produces nothing at all for `idleTimeoutMs` after creation is correctly treated as stuck.
- Heartbeat payload gains `idleMs: this.now() - lastProgressAt`, `outputBytes`, `errorBytes` — this is the detail that was missing while debugging `issue-broccoli-113` (the pending-activity view showed `active:1, ready:1` with no way to tell if the CLI itself was doing anything).

The single `elapsedMs > timeoutMs` check (`k8s-job-runner.ts:269`) is replaced by two checks, evaluated in this order:

1. **Idle check** — `this.now() - lastProgressAt > req.limits.idleTimeoutMs` → delete the Job, throw `ProcessCliTimeoutError("${binary} produced no output for ${idleTimeoutMs}ms (idle since elapsed ${lastProgressAt - start}ms)")`.
2. **Backstop check** — `this.now() - start > req.limits.timeoutMs` → delete the Job, throw `ProcessCliTimeoutError("${binary} exceeded overall ${timeoutMs}ms budget despite ongoing output")`.

Both remain `ProcessCliTimeoutError` (no change to `create-activities.ts`'s error classification) — only the message differs, which is what shows up in Temporal's `lastFailure` and is enough to tell the two cases apart during debugging.

### Job container: live streaming to Loki (`buildAgentJob`, `k8s-job-runner.ts`)

`SHELL_REDIRECT`'s plain `exec ... > OUT 2> ERR` becomes a FIFO + `tee` pipeline, so the CLI's output still lands in the artifact files `parseOutput` reads, but is also mirrored to the container's own stdout/stderr (which Alloy already scrapes into Loki — no Alloy config change):

```sh
mkfifo /tmp/agentops-out /tmp/agentops-err
tee "$OUT_FILE" < /tmp/agentops-out &
tee "$ERR_FILE" < /tmp/agentops-err >&2 &
"$0" "$@" < "$PROMPT_FILE" > /tmp/agentops-out 2> /tmp/agentops-err
CODE=$?
wait
exit "$CODE"
```

Deliberately avoids `set -o pipefail` (unsupported by `dash`, not portable across the `/bin/sh` implementations different base images may use) — the CLI runs directly (not through a pipe), its real exit status is captured explicitly in `$CODE`, and the script `wait`s for both background `tee`s to drain their FIFOs before exiting with the CLI's own code. `tee`'s default stdout write for the out-FIFO becomes the container's stdout; the err-FIFO's `tee` is redirected to `>&2` to land on the container's stderr instead. `isAuthError`/`parseOutput` are unaffected — they still read the same `OUT_FILE`/`ERR_FILE` paths as before.

### Workflow wiring

**`packages/workflows/src/dev-cycle.ts`:**

- `agentActivities` proxy (currently `startToCloseTimeout: '30 minutes'`, `dev-cycle.ts:28-31`) → `'35 minutes'`. Gives 5 minutes of headroom over the new 30-minute backstop so `K8sJobRunner`'s own delete-and-throw always completes before Temporal's own `startToCloseTimeout` could force-fail the activity with a less informative error.
- `runStageAgent` (`dev-cycle.ts:147-176`): the hardcoded `limits: { maxTokens: ..., timeoutMs: 600_000 }` becomes a resolver reading the new config — pure computation, no I/O, stays inside the determinism boundary:
  ```ts
  const stageTimeouts = input.config.timeouts?.[stage];
  const limits = {
    maxTokens: input.config.brakes.maxTokens,
    idleTimeoutMs: stageTimeouts?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    timeoutMs: stageTimeouts?.timeoutMs ?? DEFAULT_BACKSTOP_TIMEOUT_MS,
  };
  ```

**`packages/workflows/src/platform.ts`:** not project-scoped (no `ProjectConfig`), so it gets a new `PLATFORM_IDLE_TIMEOUT_MS = DEFAULT_IDLE_TIMEOUT_MS` constant threaded into `limits` alongside the existing `PLATFORM_TIMEOUT_MS = 1_800_000` (unchanged — already at the new backstop default). Its `agentActivities.startToCloseTimeout` (`platform.ts:13-17`) has the exact same 30-min/30-min collision as `dev-cycle.ts` had before this design — pre-existing, just not yet triggered — so it gets the same fix: bumped to `'35 minutes'` for the same headroom reason.

## Testing strategy

- `k8s-job-runner.test.ts`: idle-timeout kill fires when the output file never grows past the injected `now()`'s idle window, even while the fake Job status stays healthy/active; backstop kill fires when output keeps growing but total elapsed exceeds `timeoutMs`; heartbeat payload assertions extended to check `idleMs`/`outputBytes`/`errorBytes`; existing status-poll-hang test (`issue-broccoli-94` regression) unaffected since it exercises the `readNamespacedJobStatus` timeout path, not this one.
- `k8s-job-runner.test.ts` (`buildAgentJob`): container `command` assertion updated for the new FIFO/`tee` script; a new case runs the actual shell fragment against a fake binary via `FakeBatchApi`'s job simulation (or a direct `/bin/sh -c` exec in the test if that's simpler) asserting stdout/stderr both reach the artifact files *and* a captured "container output" sink, and that a non-zero CLI exit code survives through to the container's exit code.
- `dev-cycle.test.ts`: a stage with no `timeouts` override resolves to the two new defaults; a stage with an explicit override in `ProjectConfig.timeouts` resolves to those values instead.
- `contracts` package: schema tests for the new `limits.idleTimeoutMs` field and `ProjectConfig.timeouts`.
- No new e2e scenario needed for the timeout *values* themselves (nothing about brake/repair-loop semantics changes), but the existing devCycle e2e (stub backend) should be checked for any hardcoded `limits`/`timeoutMs` shape assumptions that need updating for the new required field.

## Named risks

- **Byte-growth liveness is coarse.** A backend that buffers a full turn silently (no incremental stdout) for longer than 5 minutes would be misclassified as stuck. Accepted per the non-goals; if this proves to be a real problem for a specific backend, the fix is backend-specific progress parsing (explicitly deferred, not precluded).
- **FIFO/`tee` script correctness across base images.** `mkfifo` and background `tee` are POSIX but worth confirming against whatever minimal image `agent-runner` actually ships (`node:22-slim` per ARCHITECTURE.md §5.4) — not expected to be an issue, but should be smoke-tested against a real Job, not just the fake-API unit tests.
- **35-minute `startToCloseTimeout` (both workflows) is a small workflow-visible behavior change** — a stage that would previously have hard-failed at 30 minutes now has 5 more minutes of Temporal-level ceiling. Immaterial in practice (the internal 30-minute backstop still fires first), called out for completeness.

## Package/file summary

- **Changed:** `packages/contracts/src/agent-run.ts` (+ new default constants, + test), `packages/contracts/src/project-config.ts` (`timeouts` field + merge logic, + test), `packages/backends/src/k8s/k8s-job-runner.ts` (+ test), `packages/workflows/src/dev-cycle.ts` (+ test), `packages/workflows/src/platform.ts`.
- **No new files.**

## Open questions carried forward

- Whether `idleTimeoutMs`/`timeoutMs` defaults (5 min / 30 min) need retuning once this runs against a few more real tasks the size of `issue-broccoli-113` — left as operator-tunable via `ProjectConfig.timeouts` rather than guessed precisely up front.
- Whether stderr should also be teed live, given `isAuthError` only reads it after the fact today — included in this design for consistency/completeness, but could be dropped to reduce Job script complexity if it turns out not to matter in practice.
