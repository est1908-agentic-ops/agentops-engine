# K8s Job Runner — Design

Status: draft · 2026-07-03 · Owner: Artem
Milestone: M2, sub-project 4 of 5 (see [decomposition](2026-07-03-m2-decomposition.md))

## Context

`runAgent` today (`packages/activities/src/create-activities.ts`) calls `AgentBackend.run(req)` in-process; the only implementation that actually executes a CLI is `ProcessCliBackend` (`packages/backends/src/process-cli-backend.ts`), which `child_process.spawn`s the binary on the worker host and pipes `req.prompt` to its stdin. ARCHITECTURE.md §5.9 decision #2 anticipated this exact seam: "Workflows never know *how* agents run; swapping local-spawn for Jobs... touches one activity" — in the code as it exists today, that seam is one level lower than "activity": it's the `AgentBackend` implementation. `runAgent` itself (the activity) doesn't change at all; what changes is which `AgentBackend` gets registered for `claude`/`pi` at composition-root time (M2 wiring's concern), and a new implementation of that interface needs to exist (this sub-project's concern).

`ProcessCliBackend` currently couples two things that need to separate: **what the CLI needs** (`buildArgs`, `parseOutput`, `isAuthError` — `ClaudeBackend`/`PiBackend`'s concern) and **how it's executed** (spawn locally vs. launch a K8s Job). This sub-project pulls those apart.

## Goal

An `AgentBackend` implementation that runs the same CLI invocation as today, but as a K8s Job in the `dev-agents` namespace instead of a local child process — same `AgentRunResult` contract out, so nothing above `packages/backends` changes.

## Non-goals

- Wiring which backend gets used when (in-cluster vs local) — [M2 wiring](2026-07-03-m2-wiring-design.md)'s job.
- The image/chart this launches against — [engine image & chart](2026-07-03-engine-image-and-chart-design.md)'s job; this doc only pins the contract (image name convention, PVC mount path) it depends on.
- Streaming logs to Loki/Tempo — that's OTel/Alloy, M4.
- `agent-pi` in-cluster — no second image in M2 (per decomposition doc).

## Design

### Refactor: extract `CliSpec` from `ProcessCliBackend`

```ts
// packages/backends/src/cli-spec.ts (new)
export interface CliSpec {
  image: string;                                                        // e.g. "ghcr.io/<org>/agentops-engine/agent-claude:v1"
  binary: string;                                                       // e.g. "claude" — the in-container executable
  buildArgs(req: BackendRunRequest): string[];
  parseOutput(stdout: string, stderr: string, elapsedMs: number): AgentRunResult;
  isAuthError(stderr: string): boolean;
}
```

`ClaudeBackend`/`PiBackend` stop being `AgentBackend` implementations themselves and become `CliSpec` implementations (their existing `buildArgs`/`parseOutput`/`isAuthError` bodies move over unchanged; `image`/`binary` are new fields). `ProcessCliBackend` is renamed `ProcessCliRunner`, takes a `CliSpec` by constructor injection instead of being subclassed, and its `run()` body is otherwise identical to today (still ignores `spec.image` — irrelevant to local execution). This is a mechanical refactor with no behavior change for the local-dev path; existing `ClaudeBackend`/`PiBackend` unit tests move to test the `CliSpec` objects directly (assert `buildArgs`/`parseOutput`/`isAuthError` outputs, no process involved), and `ProcessCliRunner` keeps its own tests (injected `spawn`, unchanged from today's `ProcessCliBackend` tests).

### New: `K8sJobRunner`

```ts
// packages/backends/src/k8s/k8s-job-runner.ts
export interface K8sJobRunnerOptions {
  namespace: string;                    // "dev-agents"
  workspacePvcName: string;             // matches charts/engine's "workspace-tasks" PVC
  workspaceMountPath: string;           // "/workspace/tasks", matches the worker's own mount
  batchApi: BatchV1ApiLike;             // narrow interface, injectable — see Testing strategy
  coreApi: CoreV1ApiLike;
  pollIntervalMs?: number;              // default 3000
}

export interface BatchV1ApiLike {
  createNamespacedJob(namespace: string, body: V1Job): Promise<{ body: V1Job }>;
  readNamespacedJobStatus(name: string, namespace: string): Promise<{ body: V1Job }>;
  deleteNamespacedJob(name: string, namespace: string, opts?: { propagationPolicy?: string }): Promise<void>;
}
export interface CoreV1ApiLike {
  readNamespacedPersistentVolumeClaimStatus?: never; // not needed — reading result via mounted file, not the log API
}

export class K8sJobRunner implements AgentBackend {
  constructor(private readonly spec: CliSpec, private readonly opts: K8sJobRunnerOptions) {}
  async run(req: BackendRunRequest): Promise<AgentRunResult>;
}
```

**`run(req)`:**

1. Resolve the task's workspace subpath under the shared PVC (`req.workspaceRef` is already an absolute path inside the mounted volume, per `WorkspaceManager` — the same path is valid inside the Job pod because it mounts the identical PVC at the identical mount root).
2. Write `req.prompt` to `<req.workspaceRef>/.agentops/prompt-<stage>-<attempt>-<callIndex>.txt`, and a dedicated `output-....json` / `error-....log` pair as the *expected* output location — plain `fs.writeFile`, this activity code runs in the worker pod which already has the PVC mounted.
3. Build a `V1Job`: one container, `image: spec.image`, `workingDir: req.workspaceRef`, `command: ["/bin/sh", "-c", 'exec "$0" "$@" < "$PROMPT_FILE" > "$OUT_FILE" 2> "$ERR_FILE"', spec.binary, ...spec.buildArgs(req)]`. Passing `buildArgs`' output as positional `"$@"` parameters (not string-interpolated into the shell command) means no argument — including anything derived from `req.prompt` indirectly — is ever re-parsed by the shell; only the fixed redirection skeleton is shell syntax. `PROMPT_FILE`/`OUT_FILE`/`ERR_FILE` set as container env vars pointing at the paths from step 2, `volumeMounts` on `opts.workspacePvcName` at `opts.workspaceMountPath`. `restartPolicy: Never`, `backoffLimit: 0` (the workflow's own repair loop is the retry policy — a Job-level retry would double-run a paid CLI invocation), `ttlSecondsAfterFinished: 300`, `securityContext: { runAsNonRoot: true, allowPrivilegeEscalation: false }`, auth env (`CLAUDE_CODE_OAUTH_TOKEN` etc.) via `envFrom.secretRef` (secret name is a further constructor option, not shown above — added during implementation once the platform components doc names it).
4. `createNamespacedJob`, then poll `readNamespacedJobStatus` every `pollIntervalMs`, calling Temporal's `Context.current().heartbeat()` on each poll. This requires the `runAgent` activity's `proxyActivities` options in `packages/workflows` to set a `heartbeatTimeout` (currently absent) — a required, small wiring change called out here since it's this sub-project's need, even though the exact value (proposal: `req.limits.timeoutMs`'s poll-interval multiple, e.g. `3 * pollIntervalMs`) is decided in [M2 wiring](2026-07-03-m2-wiring-design.md).
5. On `heartbeat()` throwing (activity cancellation — Temporal's mechanism for `stop`/`cancel` signals and timeout): `deleteNamespacedJob(name, namespace, { propagationPolicy: 'Background' })`, then rethrow. This is the "cancel-kills-Job" behavior ARCHITECTURE.md §5.4 names explicitly.
6. On `status.succeeded === 1` or `status.failed === 1`: read `OUT_FILE`/`ERR_FILE` off the shared PVC (same `fs.readFile` the worker already has access to — **not** the K8s pod-logs API, which has retention/size limits and would require a second client method; reading the files the container itself wrote to the PVC is strictly simpler and matches exactly what `ProcessCliBackend` does with its in-memory `stdout`/`stderr` buffers today). Call `spec.parseOutput(stdout, stderr, elapsedMs)`, same as the local path. If `spec.isAuthError(stderr)` — throw the same `ProcessCliAuthError`-equivalent (kept, renamed if needed, in the shared module).
7. Job cleanup on success/failure is handled by `ttlSecondsAfterFinished` — no manual delete call needed on the non-cancelled path.

### Contract this sub-project depends on (owned by [engine image & chart](2026-07-03-engine-image-and-chart-design.md))

- PVC name `workspace-tasks`, mount path matching what the worker Deployment uses for `WorkspaceManager`'s `workspacesDir`.
- Namespace `dev-agents`.
- RBAC already granting the worker's ServiceAccount `create/get/list/watch/delete` on `jobs` — this sub-project's code assumes those permissions exist, doesn't grant them itself.

## Testing strategy

- `CliSpec` implementations (`ClaudeBackend`/`PiBackend`, post-refactor): existing unit tests carry over unchanged in spirit, now asserting against plain objects/functions instead of a running process.
- `ProcessCliRunner`: existing `ProcessCliBackend` tests carry over, injected `spawn`, constructed with a fake `CliSpec`.
- `K8sJobRunner`: `batchApi`/`coreApi` are injected fakes (in-memory `Map`-backed implementations of the narrow interfaces above, same DI pattern as `spawn`/`GitCommandRunner` elsewhere in this codebase) — no real cluster, no `@kubernetes/client-node` network calls in tests. Coverage: builds the expected `V1Job` shape (command array, volume mounts, security context) from a `BackendRunRequest`; polls until a fake status flips to `succeeded`, reads prompt/output files from a real temp directory (same "real filesystem, fake network" split `WorkspaceManager`'s tests use); on a simulated heartbeat cancellation, asserts `deleteNamespacedJob` was called with `propagationPolicy: 'Background'` and the original error is rethrown; `isAuthError` path throws the auth error instead of returning a result.
- No test spawns a real K8s API server. A manual `verify:live` script against a real `kind`/`k3d` cluster (same posture as `claude-backend`'s deferred manual verification) is the integration-level check, folded into [M2 wiring](2026-07-03-m2-wiring-design.md)'s runbook.

## Named risks

- **Stdin-via-file-redirect must behave identically to stdin-via-pipe for `claude`/`pi`.** Both should be indistinguishable to the CLI (it just reads stdin), but this is exactly the kind of assumption worth a manual smoke test before trusting it in the real pipeline — called out in the wiring doc's runbook rather than assumed here.
- **Output-file-on-shared-PVC instead of pod-logs API is a real dependency on RWO/same-node PVC sharing holding.** If the cluster ever needs multi-node (ARCHITECTURE.md §9's existing risk), this exact mechanism needs revisiting alongside `WorkspaceManager`'s — not a new risk, an existing one this design inherits rather than works around.
- **`backoffLimit: 0` + `ttlSecondsAfterFinished: 300` means a crashed poll loop (worker restart mid-Job) could leave a Job to clean itself up via TTL, but the activity itself would be retried by Temporal from scratch** — a second Job for the same `(taskId, stage, attempt, callIndex)` could run concurrently with an orphaned one for up to 5 minutes. Acceptable for M2 (low volume, single test repo); worth a `Job` naming scheme that makes duplicates detectable (`name: agentops-<taskId>-<stage>-<attempt>-<callIndex>`, which also makes `createNamespacedJob` idempotently fail-fast on a genuine duplicate) rather than a bigger reconciliation mechanism.

## Package/file summary

- **New:** `packages/backends/src/cli-spec.ts`, `packages/backends/src/k8s/k8s-job-runner.ts` + `.test.ts`, `packages/backends/src/k8s/fake-batch-api.ts` (test double).
- **Changed:** `packages/backends/src/process-cli-backend.ts` → renamed `process-cli-runner.ts`, refactored to take an injected `CliSpec`.
- **Changed:** `packages/backends/src/claude/claude-backend.ts`, `packages/backends/src/pi/pi-backend.ts` — become `CliSpec` objects, not classes implementing `AgentBackend`.
- **Changed:** `packages/backends/package.json` — new dependency `@kubernetes/client-node`.
- **Changed:** `packages/workflows/src/activities-api.ts` — `heartbeatTimeout` added to `runAgent`'s `proxyActivities` options.

## Open questions carried forward

- Exact `heartbeatTimeout` value — proposed as a multiple of `pollIntervalMs`, finalized in M2 wiring alongside the rest of the in-cluster activity options.
- Job naming/idempotency as a duplicate-Job safeguard — named above as a risk, not designed in full; revisit if it causes a real incident.
