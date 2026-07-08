# M0 Spec — Walking Skeleton

Goal: the complete DevCycle pipeline running end-to-end against **stubs** — no k8s, no real forge, no real agent CLI, zero token spend. M0 exists to get the *semantics* (repair loop, brakes, verdicts, babysit) implemented and regression-guarded before anything real or expensive is attached.

Context you must read first: [ARCHITECTURE.md](ARCHITECTURE.md) §2 (semantics — these are the requirements), §5.9 (package layout), AGENTS.md (hard rules, especially the determinism boundary).

## Non-goals for M0

No Kubernetes, no Docker images, no GitHub/Gitea/Linear adapters, no real backends, no Gateway/webhooks (CLI-triggered only), no UI, no OTel, no Postgres (in-memory stats collection behind an interface).

## Setup

- pnpm workspace, Node 22, TS strict, vitest, zod, `@temporalio/{client,worker,workflow,activity,testing}`.
- Local Temporal: `temporal server start-dev` (document in README) for manual runs; **tests use `TestWorkflowEnvironment`** (time-skipping) and must not require a running server.
- CI (GitHub Actions): lint + typecheck + test + e2e on every PR.

## Packages to create

`contracts`, `policies`, `ports` (interfaces + `memory` adapters), `backends` (interface + `stub`), `workflows`, `activities`, `worker`, `cli` (minimal: `start`, `signal`, `state`). Skip `prompts`, `gateway`, `ui` (placeholder dirs fine).

## Contracts v0 (package `contracts`)

Fixed vocabularies — do not extend without design discussion:

- `Stage = context | assess | design | plan | implement | full_verify | review | pr | pr_babysit | done | failed`
- `TaskStatus = pending | running | blocked | done | failed`
- `BlockReason = needs-clarification | iteration-brake | token-brake | babysit-brake | max-attempts | hook-required-failed`

Schemas (zod), minimum fields:

- `TaskInput`: `{ taskId, project, repo, issueRef?, goal, config: ProjectConfig }`
- `ProjectConfig`: `{ fastVerifyCommands[], fullVerifyCommands[], stages: { assess?: bool, triage?: bool }, routing: Record<Stage, ModelRef>, escalation?: ModelRef, brakes: { maxImplementAttempts=3, maxIterations, maxTokens, maxBabysitRounds } }`
- `StageResult`: `{ stage, source: agent|human|triage, contentHash, tokens, outcome }`
- `Verdict`: `{ kind: pass|fail|unparseable, findings? }`
- `AgentRunRequest` / `AgentRunResult`: see `backends` below
- `RunStats`: `{ taskId, stage, backend, model, tokensIn, tokensOut, wallMs, outcome }`
- `PrFeedback`: `{ ciStatus: pending|green|failed, unresolvedThreads: number, comments[] }` + `feedbackHash(PrFeedback): string`

## Policies (package `policies`) — pure functions, exhaustively tested

Each behavior below comes from ARCHITECTURE.md §2 and must have named unit tests:

1. `parseVerdict(text, sentinel)` — last sentinel match wins; missing/garbled → `unparseable` (never pass, never fail); caller retries bounded times, then treats as **retryable FAIL** — never a human-block.
2. `nextRepairAction(state)` — inputs: attempt count, iteration count, cumulative tokens, full-verify verdict, review verdict, diff-empty?, brakes. Output: `continue | fix | escalate-final-attempt | open-pr-exhausted | block(reason)`. Encoded rules: clean iteration requires BOTH full-verify and review pass; exhausted attempts → `open-pr-exhausted` (with findings), not block; empty diff after N rounds → `block(max-attempts)`; token/iteration brake → `block(...)`; final attempt uses escalation model if configured.
3. `evaluateBrakes(counters, brakes)` — which brake trips first, deterministic.
4. `babysitDecision(feedback, seenHashes, rounds, cap)` — `merge_ready | actionable | waiting | braked`; a feedback set already in `seenHashes` → `waiting`.
5. `preImplementStages(config)` — active linear stage list (assess/triage toggles; triage `TRIVIAL` skips design+plan unless human artifact exists — human artifact always wins).

## Ports (package `ports`)

- `TrackerPort`: `getIssue`, `comment`, `label`; `ScmPort`: `openPr`, `getPrFeedback`, `push` (no-op in memory), `readFile`.
- `memory` adapters: scriptable state for tests (issue fixtures, controllable `PrFeedback` sequence per test — e.g. first poll returns `ciStatus: failed`, next returns green).

## Backends (package `backends`)

- `AgentBackend.run(req: AgentRunRequest): Promise<AgentRunResult>` where result = `{ output, tokensIn, tokensOut, wallMs }`.
- `stub` backend: deterministic scripted responses keyed by `(stage, attempt)`, injectable per test/run: e.g. `implement#1` returns code-ish text; `full_verify#1` → `FULL: FAIL ...`; `implement#2` (fixer) → fixed; `full_verify#2` → `FULL: PASS`; `review#1` → `VERDICT: PASS`. Also failure modes: garbled verdict output, empty diff, token-count inflation (to trip `maxTokens`).

## DevCycle workflow (package `workflows`)

- Sequence per `preImplementStages` then the repair loop (`implement ⇄ full_verify → review`) driven by `nextRepairAction`, then `pr`, then `pr_babysit` loop with a durable timer poll (interval from config) using `babysitDecision`, then `done`.
- Signals: `stop` (requeue semantics: workflow returns with status pending-equivalent), `cancel` (→ failed), `clarify`/`resume` (unblock). Query: `state` (current stage, status, counters) — the CLI and later the UI read this.
- Stage results recorded via an activity (in-memory store keyed by taskId; interface shaped so Postgres can replace it in M4).
- All I/O via activities: `runAgent`, tracker/scm calls, stats write. Activities receive everything they need as arguments (no globals).

## e2e acceptance (the M0 gate)

`pnpm e2e` — vitest suite on `TestWorkflowEnvironment`, no external processes:

1. **Happy path with one repair round:** fake issue → context/design/plan → implement → forced `FULL: FAIL` → fixer round → pass → review pass → PR opened → babysit: first feedback `failed` CI (actionable → fix → push), second feedback green + 0 threads → `done`. Assert: stage order, attempt counts, PR opened exactly once, stats recorded per stage.
2. **Brake + rescue:** stub inflates tokens past `maxTokens` → task blocks with `token-brake` → `resume` signal → continues and completes.
3. **Garbage verdict:** reviewer returns garbage twice → bounded retries → treated as retryable FAIL → fixer round proceeds (never `blocked`).
4. **Exhausted rounds:** all attempts fail review → PR opened anyway with findings posted as comment (assert comment via memory tracker).

## Definition of done

All four e2e scenarios green in CI; `policies` at 100% branch coverage; README quick-start (`pnpm i && pnpm e2e`, manual run against `temporal server start-dev` documented); no package violates the determinism boundary (enforced by eslint rule or import-ban config, not convention).
