# Claude Backend — Design

Status: draft · 2026-07-03 · Owner: Artem
Milestone: M1, sub-project 1 of 4 (see decomposition below)

## Context

M0 shipped the full DevCycle pipeline (`context → design → plan → implement ⇄ full_verify → review → pr → pr_babysit → done`) running entirely against the `stub` `AgentBackend` and in-memory `TrackerPort`/`ScmPort`. M1's done-criterion (ARCHITECTURE.md §8.1) is a real issue becoming a real merge-ready PR. That milestone bundles four largely independent subsystems:

1. **Claude backend** — this doc.
2. GitHub ports (real `TrackerPort`/`ScmPort`).
3. Worktree activities (real git clone/checkout per task).
4. `agentops.json` config loading.

Each is independently designable and shippable; this doc covers only (1). Interfaces below are written so (2)–(4) plug in later without changing this design.

## Goal

Implement `AgentBackend` for the real `claude` CLI so `DevCycle` can drive actual coding work, replacing `StubBackend` at the `backend: 'claude'` routing key — while keeping `packages/backends` testable in CI with zero API calls (AGENTS.md hard rule 5).

## Non-goals (deferred to other sub-projects or later milestones)

- Real workspace creation (worktree activities create `workspaceRef`; this backend only *consumes* an existing directory path).
- Real GitHub issue/PR I/O.
- OTel spans / live log streaming (M4) — this backend returns a single result, no incremental progress reporting yet.
- Running inside a K8s Job / sandboxing (M2). For now this spawns a process on whatever host runs the Temporal worker.
- `RunStats.outcome` reflecting actual backend success/failure — today `dev-cycle.ts` hardcodes `outcome: 'pass'` regardless of backend result; unchanged by this design.
- Product-repo prompt overrides (ARCHITECTURE.md §5.9 point 5) — only the engine's built-in prompt pack is loaded in M1.

## How stages get real prompts (contracts change)

Today `AgentRunRequest.promptRef` is set (`"${stage}.md"`) but unused — `StubBackend` ignores it and keys purely on `(stage, attempt, callIndex)`. A real backend needs actual prompt text, and workflow code cannot read a template file itself (determinism boundary — file I/O is banned in `packages/workflows`). So resolution has to happen in the activity layer, between the workflow's request and the backend call.

**New package `packages/prompts`** (currently a placeholder dir per M0-SPEC):

```
packages/prompts/
  src/
    templates/
      context.md
      design.md
      plan.md
      implement.md
      full_verify.md
      review.md
    render-prompt.ts   # pure: render(template: string, vars: Record<string, unknown>): string
    load-prompt-pack.ts # I/O: reads templates/<ref> relative to this package
    index.ts
```

`render` does flat `{{key}}` substitution only — no conditionals/loops/partials. Missing variable referenced in a template → throws `MissingTemplateVariableError` (fail loud, never silently emit a broken prompt — same philosophy as `parseVerdict`'s "never silent pass"). This is deliberately dumber than real Mustache; template authors keep every variable always-populated (empty string if genuinely absent) rather than relying on conditional sections. Revisit only if a concrete template needs branching.

**Contracts change** (`packages/contracts/src/agent-run.ts`):

```ts
export const AgentRunRequestSchema = z.object({
  taskId, stage, attempt, callIndex, backend, model,
  promptRef: z.string().min(1),                                  // unchanged
  promptContext: z.record(z.string(), z.unknown()).default({}),  // NEW
  workspaceRef, limits,
});

// NEW — what backends actually receive, built by the runAgent activity
export const BackendRunRequestSchema = AgentRunRequestSchema
  .omit({ promptRef: true, promptContext: true })
  .extend({ prompt: z.string().min(1) });
export type BackendRunRequest = z.infer<typeof BackendRunRequestSchema>;
```

`AgentBackend.run()` changes signature from `AgentRunRequest` to `BackendRunRequest`. `StubBackend` keeps its exact logic (still keyed on `stage`/`attempt`/`callIndex`, which `BackendRunRequest` still carries) — only its type annotation changes.

**`runAgent` activity** (`packages/activities/src/create-activities.ts`) gains a `prompts: PromptRenderer` dependency and does the resolution:

```ts
async runAgent(req: AgentRunRequest): Promise<AgentRunResult> {
  const backend = deps.backends[req.backend];
  if (!backend) throw new Error(`unknown backend "${req.backend}"`);
  const prompt = deps.prompts.render(req.promptRef, req.promptContext);
  return backend.run({
    taskId: req.taskId, stage: req.stage, attempt: req.attempt, callIndex: req.callIndex,
    backend: req.backend, model: req.model, workspaceRef: req.workspaceRef, limits: req.limits,
    prompt,
  });
},
```

This keeps template file I/O and rendering entirely inside the activity/prompts layer; `packages/backends` never touches the filesystem for prompts, only for spawning the CLI with `cwd: workspaceRef`.

## What goes in `promptContext`

Each stage's agent invocation runs in the *same real git worktree* as every other stage for that task, so prior stages' file changes are already visible on disk — the agent can `git log`/`git diff`/read files itself. `promptContext` only needs to carry what **isn't** recoverable from the workspace:

| Stage | Context keys (beyond `taskId`, `goal`) |
|---|---|
| `context` | `issueBody` (only if `issueRef` set) |
| `design`, `plan`, `implement` (attempt 1) | *(none — goal + workspace state suffice)* |
| `implement` (attempt > 1, repair round) | `fullVerifyFindings`, `reviewFindings` — the prior verdict stages' raw output, since that's conversation text, not something committed to disk |
| `full_verify` | `verifyCommands` — `[...fastVerifyCommands, ...fullVerifyCommands]` joined, so the agent knows exactly what to run and self-report against |
| `review` | *(none — agent runs `git diff` itself)* |

This requires a small, mechanical change to `dev-cycle.ts`'s `runStageAgent`/`runVerdictStage` to build the right `promptContext` per call. It's in scope for this sub-project (same file M0 already owns, not a new subsystem) — everything else in `dev-cycle.ts` is untouched.

Prompt *copy* (the actual wording, where the `FULL:`/`VERDICT:` sentinel instructions live) is an implementation-time detail, not a design decision — written when this is implemented, following the shape above.

## The `ClaudeBackend` class

`packages/backends/src/claude/claude-backend.ts`:

```ts
export interface ClaudeBackendOptions {
  executablePath?: string;        // default: 'claude'
  spawn?: typeof import('node:child_process').spawn;  // injectable for tests
  env?: NodeJS.ProcessEnv;        // default: process.env
  maxTurns?: number;              // default: 30 — inner agentic-loop safety net
}

export class ClaudeBackend implements AgentBackend {
  constructor(opts?: ClaudeBackendOptions);
  run(req: BackendRunRequest): Promise<AgentRunResult>;
}
```

**Invocation:**

```
claude -p --output-format json --model <req.model> --max-turns <maxTurns> --dangerously-skip-permissions
```

spawned with `cwd: req.workspaceRef`, `env` merged from `opts.env`. The prompt is **piped via stdin**, not passed as an argv string — `implement`/`design` prompts can carry large prior-stage context and argv has OS length limits; stdin has none. `child.stdin.write(req.prompt); child.stdin.end()`.

**Timeout:** a timer fires `child.kill('SIGTERM')` at `req.limits.timeoutMs`; if the process hasn't exited 5s later, `SIGKILL`. Timer is cleared on normal exit.

**Output parsing:** `--output-format json` emits one JSON object on stdout at the end:

```json
{ "is_error": false, "result": "<final text>", "usage": {"input_tokens": N, "output_tokens": M}, "duration_ms": D }
```

Mapped to `AgentRunResult`: `output = result`, `tokensIn = usage.input_tokens`, `tokensOut = usage.output_tokens`, `wallMs = duration_ms` (fallback: measured wall-clock if the field is absent).

**Error taxonomy** (this is the part most worth scrutinizing):

| Situation | Behavior |
|---|---|
| Clean exit, valid JSON, `is_error: false` | Return parsed result normally. |
| Clean exit, valid JSON, `is_error: true`, but `result` has text | Return it as `output` anyway — downstream `parseVerdict` will treat missing/garbled sentinels as `unparseable` → bounded retry → retryable FAIL. This backend does not interpret verdict semantics; that's `policies`' job. |
| Exit 0 (or nonzero) but stdout isn't valid JSON | **Do not throw.** Return `{ output: rawStdout \|\| rawStderr, tokensIn: 0, tokensOut: 0, wallMs: elapsed }`. Matches the "never silent pass, never human-block on garbage" rule (M0-SPEC) — a malformed response degrades to an unparseable verdict downstream, not a crashed activity. |
| Process never produced *any* stdout and exited nonzero (CLI itself failed — bad flags, missing binary, crash) | Throw `ClaudeBackendProcessError`. This is an infrastructure failure, not an agent output — let Temporal's activity retry policy handle it. |
| Timeout exceeded | Throw `ClaudeBackendTimeoutError` after the SIGKILL. |
| stderr matches a known auth-failure pattern (e.g. `invalid`/`expired` + `token`/`api key`) | Throw `ClaudeBackendAuthError` — a distinguishable subclass. No special handling consumes this yet (Heal/M6 doesn't exist), but naming it now means M6 doesn't need to touch this file. |

The dividing line: **"the CLI ran and said something" is always a normal result (even if garbage); "the CLI failed to run" is always a thrown error.** This mirrors `parseVerdict`'s own fail-safe design one layer down.

## Required side-effect change: per-call activity timeout

`dev-cycle.ts` currently sets one blanket `proxyActivities({ startToCloseTimeout: '10 minutes' })` for all activities. Real `claude` runs can legitimately exceed 10 minutes on `implement`. This design requires `startToCloseTimeout` to track `req.limits.timeoutMs` (with headroom for process teardown) rather than a fixed constant — either a second `proxyActivities` call scoped to `runAgent` with a longer ceiling, or per-call `Context.current().info` timeout override. Flagging this now so it isn't discovered as a mysterious activity-timeout failure during M1 integration.

## Testing strategy

AGENTS.md hard rule 5: tests use `stub`, never real credentials. `ClaudeBackend` unit tests inject `spawn` with a fake `ChildProcess`-like `EventEmitter` (writable `stdin`, readable `stdout`/`stderr`) — no real binary, no network, runs in CI. Coverage:

- Valid JSON on stdout → correct `AgentRunResult` mapping.
- Malformed stdout → returns raw text, zero tokens, does not throw.
- Timeout exceeded → `SIGTERM` sent, `ClaudeBackendTimeoutError` thrown.
- Nonzero exit with empty stdout → `ClaudeBackendProcessError` thrown.
- stderr auth pattern → `ClaudeBackendAuthError` thrown.
- Prompt is written to stdin, not argv (assert on the fake process's captured stdin writes, not spawn args).

**Real-CLI verification is explicitly out of `pnpm test`/`pnpm e2e`.** A manual, documented script (e.g. `pnpm --filter @agentops/backends run verify:live -- <workspace-dir>`) exercises the real `claude` binary once `CLAUDE_CODE_OAUTH_TOKEN` is set locally — never runs in CI, never asserted in the M1 done-criterion's automated gate. The done-criterion itself ("real issue → real PR") is inherently a manual/one-off verification until M1's other three sub-projects land and get wired together.

## Named risk: `--dangerously-skip-permissions`

Headless operation requires bypassing claude's interactive tool-approval prompts — there's no human in the loop to click "allow." This is the same posture vibeteam proved out and ARCHITECTURE.md §5.4 assumes for the eventual sandboxed K8s Job. **For M1 specifically, this runs unsandboxed on whatever host runs the Temporal worker** (M2 is what adds the Job/NetworkPolicy sandbox). Until M2 lands, this backend should only be pointed at disposable worktrees on a throwaway test repo — not a developer's real working directory, not anything with production credentials reachable from the environment. Worth a one-line callout in the M1 root README when this ships.

## Package/file summary

- **New:** `packages/prompts/` (templates + `render-prompt.ts` + `load-prompt-pack.ts`, unit-tested pure `render`).
- **New:** `packages/backends/src/claude/claude-backend.ts` + `.test.ts`.
- **Changed:** `packages/contracts/src/agent-run.ts` (`promptContext` field, new `BackendRunRequestSchema`).
- **Changed:** `packages/backends/src/agent-backend.ts` (interface takes `BackendRunRequest`), `stub-backend.ts` (type only).
- **Changed:** `packages/activities/src/create-activities.ts` (`prompts` dependency, render-then-call-backend).
- **Changed:** `packages/workflows/src/dev-cycle.ts` (`promptContext` per stage — small, mechanical).
- **Changed:** `packages/worker/src/create-worker.ts` (wire real `prompts` renderer into `ActivityDependencies`; registering `'claude'` in the backends map is deferred to the M1 wiring step once the other sub-projects exist, but the dependency shape should accept it now).

## Open questions carried forward (not blocking this sub-project)

- Product-repo prompt-pack overrides (loading `agentops/prompts/` from the target repo instead of the engine's built-in pack) — deferred until a real product repo exists to override from.
- `RunStats.outcome` currently ignores whether the backend call actually succeeded — should eventually derive from `is_error`/verdict rather than being hardcoded `'pass'` in the workflow. Separate, small fix, not blocking.
- Rate-limit backoff (subscription 5h/week windows, ARCHITECTURE.md §5.5) is out of scope until M5 budget enforcement.
