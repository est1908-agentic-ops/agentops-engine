# Pi Backend — Design

Status: draft · 2026-07-03 · Owner: Artem
Milestone: M1, sub-project 2 of 5 (see [claude-backend design](2026-07-03-claude-backend-design.md) for the full decomposition)

## Context

`ModelRefSchema.backend` already enumerates `pi` as a valid value (it has since M0), and ARCHITECTURE.md's Phase 1 gate (§4) explicitly names "Agent Runner Jobs for ≥2 backends (claude, pi) + stub" — even though the later M1–M9 milestone table (§8.1) deferred `pi` to M5 alongside `cursor`. Pulling it into M1 resolves that inconsistency rather than purely adding scope, and gives multi-backend routing (ARCHITECTURE.md's "pluggable everything" principle) a real second data point from day one instead of only after `claude` is battle-tested alone.

## Prerequisite: verify `pi`'s actual CLI contract before implementing

**This is the one thing this doc cannot responsibly design in detail.** Unlike the [claude backend](2026-07-03-claude-backend-design.md), where the invocation shape is grounded in the real `claude` CLI (with exactly one flag — `--effort` — flagged as unverified), this doc has no confirmed specifics for `pi`'s headless invocation. Writing exact flag names here would be guessing, and AGENTS.md's "no secrets/no assumptions baked in as fact" spirit applies just as much to CLI contracts as it does to credentials — a wrong guess baked into a design doc tends to get implemented as if it were verified.

Before implementation starts, confirm against `pi`'s real docs/`--help` output:

1. **Non-interactive/headless invocation** — the equivalent of `claude -p` / `codex exec`. Does it read the prompt from stdin, a file argument, or only an inline argv string (which would reopen the ARG_MAX concern the claude backend's design resolved via stdin)?
2. **Structured output** — is there a `--output-format json`-equivalent that reports token usage and a clean final-text field, or is stdout plain text only (in which case token accounting degrades to "unknown," same as this doc's fallback path below)?
3. **Auth mechanism** — ARCHITECTURE.md §5.5 documents `claude`/`cursor-agent`/`codex` auth lanes in detail but says nothing about `pi`. Is it a subscription CLI (OAuth token file, like `claude setup-token`) or API-key-only? This determines whether `pi` even belongs in the "subscription lane" cost model §5.5 describes, or is API-lane-only (routed through LiteLLM later, direct key for now).
4. **Permission/autonomy bypass flag** — the equivalent of `--dangerously-skip-permissions`, required for unattended operation.
5. **Turn/iteration limit flag** and **exit code conventions** on success/failure/timeout.

Until these are confirmed, treat everything CLI-specific below as a placeholder shape, not a specification. Once confirmed, this doc should be updated in the same PR as the implementation (AGENTS.md's "docs updated if behavior/design changed" rule), and ARCHITECTURE.md §5.5 should gain a `pi` row alongside the existing three.

## Goal

A second real `AgentBackend`, registered as `'pi'`, so `agentops.json` routing can send any stage to either `claude` or `pi` from M1 onward — and so the shared process-CLI backend skeleton gets extracted now, while there are two concrete implementations to generalize from, rather than guessed at with only one.

## Non-goals

- Everything the [claude-backend design](2026-07-03-claude-backend-design.md)'s non-goals list already covers (OTel, K8s sandboxing, `RunStats.outcome` fidelity, prompt overrides) — identical reasoning, not repeated here.
- Resolving the four verification questions above — that's a spike, not a design decision; this doc structures around the fact that they're open, it doesn't answer them.
- Any `pi`-specific prompt tuning (different backends may respond better to differently-worded prompts) — M1 uses the same `packages/prompts` templates for every backend; per-backend prompt variants are a real future concern but explicitly out of scope until there's evidence one backend needs it.

## Shared base: `ProcessCliBackend`

Both `ClaudeBackend` and `PiBackend` need the identical skeleton: spawn a CLI, pipe the prompt via stdin, enforce `req.limits.timeoutMs` with SIGTERM→SIGKILL, collect stdout/stderr, and apply the same three-way error taxonomy (ran-and-said-something vs. auth-failure vs. process-failure) the claude-backend doc already specified. With a second concrete backend arriving in the same milestone, this is exactly the point at which extracting the shared piece is justified — not before (one implementation generalizing from itself is speculation), not after (that's living with duplicated timeout/lifecycle logic in two places that must change in lockstep).

`packages/backends/src/process-cli-backend.ts`:

```ts
export interface ProcessCliBackendOptions {
  executablePath: string;
  spawn?: typeof import('node:child_process').spawn; // injectable, same DI pattern as before
  env?: NodeJS.ProcessEnv;
  timeoutKillGraceMs?: number; // default 5000, same as claude-backend's hardcoded grace period
}

export abstract class ProcessCliBackend implements AgentBackend {
  constructor(protected opts: ProcessCliBackendOptions) {}

  protected abstract buildArgs(req: BackendRunRequest): string[];
  protected abstract parseOutput(stdout: string, stderr: string, elapsedMs: number): AgentRunResult;
  protected abstract isAuthError(stderr: string): boolean;

  async run(req: BackendRunRequest): Promise<AgentRunResult> {
    // spawn(executablePath, buildArgs(req), {cwd: req.workspaceRef, env}), pipe req.prompt to stdin,
    // timeout -> SIGTERM/SIGKILL -> ProcessCliTimeoutError, nonzero exit + empty stdout -> ProcessCliProcessError,
    // isAuthError(stderr) -> ProcessCliAuthError, otherwise parseOutput(...) — identical control flow to the
    // claude-backend design's "Error taxonomy" table, now written once instead of twice.
  }
}
```

`ClaudeBackend` (retrofit — see that doc's package/file summary, already updated to reference this) and `PiBackend` each become a small subclass supplying three methods: how to build argv from a `BackendRunRequest`, how to parse this CLI's specific output shape into `AgentRunResult`, and how to recognize this CLI's auth-failure signature in stderr. The generic timeout/spawn/error-classification machinery lives once, in the base class, unit-tested once against a fake injected `spawn` — subclass tests only need to cover `buildArgs`/`parseOutput`/`isAuthError`, not re-verify the timeout/SIGKILL machinery per backend.

```ts
export class PiBackend extends ProcessCliBackend {
  constructor(opts?: { executablePath?: string; spawn?: ...; env?: NodeJS.ProcessEnv }) {
    super({ executablePath: opts?.executablePath ?? 'pi', ...opts });
  }
  protected buildArgs(req: BackendRunRequest): string[] { /* pending prerequisite verification above */ }
  protected parseOutput(stdout: string, stderr: string, elapsedMs: number): AgentRunResult { /* pending */ }
  protected isAuthError(stderr: string): boolean { /* pending */ }
}
```

If, once verified, `pi` turns out not to support structured usage output at all (question 2 above), `parseOutput` degrades gracefully: `tokensIn`/`tokensOut` report `0` rather than throwing or guessing — same "never fabricate a number you don't have" posture as everywhere else in these designs. That would mean `RunStats`/budget tracking undercounts `pi` runs specifically; worth a named risk once confirmed one way or the other, not before.

## Registration & routing

`PiBackend` registers under the key `'pi'` in the same `backends: Record<string, AgentBackend>` map `ClaudeBackend` registers `'claude'` into (`ActivityDependencies.backends`, wired at worker startup — the exact call site is the shared M1 wiring step both backend docs already defer). No contract change needed for routing itself: `ModelRefSchema.backend` already accepts `'pi'`, so any stage in `agentops.json`'s `routing` can point at it immediately. [`DEFAULT_PRODUCT_CONFIG`](2026-07-03-agentops-config-loading-design.md) keeps defaulting every stage to `claude` — `pi` being registered and available is a separate question from which backend a product routes to by default; that stays an explicit per-product choice until there's evidence (from `EvalRun`, M7+) about which backend is actually better for which stage.

## Auth

Deferred to the prerequisite verification above (question 3). Whatever the mechanism, it follows the same posture as `claude`: read from an env var at construction, fail fast at startup if missing rather than surfacing as a confusing failure on first use, never embedded in code or test fixtures.

## Testing strategy

Same DI philosophy as everywhere else in this set of designs — `ProcessCliBackend`'s `spawn` is injectable, so its own tests (timeout, SIGKILL, the ran-vs-failed-to-run split) run once against a fake process, in CI, with no real binary. `PiBackend`'s tests are narrow once the base class exists: given a fake process emitting `pi`'s actual (once-verified) output shape, does `parseOutput` map it correctly; given a fake auth-failure stderr, does `isAuthError` catch it. No network, no real `pi` installation required for `pnpm test`/`pnpm e2e`. Real-CLI verification is a manual script, same posture as the claude backend's `verify:live` — never part of the automated M1 gate.

## Named risks

- **Every risk in this doc traces back to the same root cause: no verified ground truth about `pi`'s CLI.** Until the prerequisite spike runs, any estimate of how much of this design survives contact with the real tool is itself a guess. Treat implementation time for this sub-project as unknown, not "the same as claude-backend minus what's shared" — it could be identical in shape or could reveal `pi` doesn't support something this design assumes (structured output, a permission-bypass flag, stdin prompts).
- **Two CLIs now share unattended, `--dangerously-skip-permissions`-equivalent autonomy on the same host** (M1's unsandboxed posture, per the claude-backend doc's named risk — applies identically here, doubled).

## Package/file summary

- **New:** `packages/backends/src/process-cli-backend.ts` + `.test.ts` (shared base, extracted alongside this sub-project).
- **Changed:** `packages/backends/src/claude/claude-backend.ts` — retrofit onto `ProcessCliBackend` (see that doc's package/file summary).
- **New:** `packages/backends/src/pi/pi-backend.ts` + `.test.ts`.
- **Changed:** wherever `ActivityDependencies.backends` is constructed for a real run — registers `'pi'` alongside `'claude'` and `'stub'`.
- **Changed (once confirmed):** ARCHITECTURE.md §5.5 gains a `pi` auth-lane row.

## Open questions carried forward

- All five prerequisite-verification questions above — blocking implementation, not blocking design review.
- Whether `pi` needs its own prompt-pack variant — deferred until there's evidence one is needed.
- Per-stage `claude` vs. `pi` routing recommendations — that's `EvalRun`/`BudgetReport` territory (M7/M9), not an M1 decision.
