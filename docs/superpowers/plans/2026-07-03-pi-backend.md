# Pi Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the process-spawning skeleton `ClaudeBackend` already implements into a shared `ProcessCliBackend` base, retrofit `ClaudeBackend` onto it with zero behavior change, and add a second real backend, `PiBackend`, registered under `'pi'`.

**Architecture:** `ProcessCliBackend` owns everything backend-agnostic: spawn, stdin piping, timeout/SIGTERM/SIGKILL, and the three-way error split ("ran and said something" vs. "failed to run" vs. "auth failure"). Each concrete backend supplies exactly three methods: `buildArgs`, `parseOutput`, `isAuthError`.

**Tech Stack:** TypeScript strict, `node:child_process`, vitest.

**Prerequisite:** [claude-backend plan](2026-07-03-claude-backend.md) must be merged first — this plan retrofits the `ClaudeBackend` class it creates.

**Design doc:** [docs/superpowers/specs/2026-07-03-pi-backend-design.md](../specs/2026-07-03-pi-backend-design.md)

**Honesty note carried over from the design doc:** unlike `claude`, there is no verified specification for `pi`'s headless CLI contract available while writing this plan. Task 1 is a mandatory research spike, not a formality — its findings can require changing the concrete `buildArgs`/`parseOutput`/`isAuthError` code written in Task 4. That's the entire point of extracting `ProcessCliBackend` first: those three methods are the *only* code that would need to change.

---

### Task 1: Verify `pi`'s CLI contract (spike — do not skip)

**Files:**
- Modify: `docs/superpowers/specs/2026-07-03-pi-backend-design.md` (record findings)

- [ ] **Step 1: Capture what the CLI actually says about itself**

```bash
pi --help
pi --version
```

If `pi` isn't installed locally, find its official documentation (README, docs site) instead. Capture the full output/relevant doc excerpt.

- [ ] **Step 2: Answer the five prerequisite questions from the design doc**

Working from the captured output/docs, answer each of the design doc's "Prerequisite" questions:

1. Non-interactive/headless invocation — flag name, and whether the prompt is read from stdin, a file arg, or inline argv only.
2. Structured output — is there a `--output-format json`-equivalent reporting token usage and a final-text field, or is stdout plain text only?
3. Auth mechanism — subscription-CLI-style (OAuth token file) or API-key-only?
4. Permission/autonomy bypass flag — the equivalent of `--dangerously-skip-permissions`.
5. Turn/iteration limit flag and exit code conventions on success/failure/timeout.

- [ ] **Step 3: Record the findings and reconcile with the working hypothesis**

Replace the design doc's "Prerequisite: verify `pi`'s actual CLI contract before implementing" section's five numbered questions with your five answers (keep the section, just turn questions into answers with the evidence/source).

If any answer **matches** this plan's working hypothesis (mirrors `claude`'s shape: `-p`, `--output-format json`, `--model`, `--max-turns`, `--dangerously-skip-permissions`, optional `--effort`, stdin-piped prompt) — proceed to Task 2 unchanged.

If any answer **contradicts** the hypothesis — note the discrepancy in the design doc now, and adjust the corresponding code block in Task 4 (`buildArgs`/`parseOutput`/`isAuthError`) accordingly before writing it. Do not implement Task 4's hypothesis-code if you know it's already wrong.

- [ ] **Step 4: Commit the findings**

```bash
git add docs/superpowers/specs/2026-07-03-pi-backend-design.md
git commit -m "docs: record verified pi CLI contract findings"
```

---

### Task 2: Extract `ProcessCliBackend`

**Files:**
- Create: `packages/backends/src/process-cli-backend.ts`
- Test: `packages/backends/src/process-cli-backend.test.ts`

This extracts the generic spawn/timeout/error-classification skeleton out of `ClaudeBackend` (Task 6 of the claude-backend plan) into a reusable abstract base — same logic, same tests-worth-of-behavior, just parameterized by three abstract methods instead of hardcoded to `claude`'s shape.

- [ ] **Step 1: Write the failing tests**

These are the same scenarios `claude-backend.test.ts` already covers, but exercised through a minimal concrete test subclass instead of `ClaudeBackend` — this is what proves the extraction preserves behavior generically, not just for `claude`.

```ts
// packages/backends/src/process-cli-backend.test.ts
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRunResult, BackendRunRequest } from '@agentops/contracts';
import {
  ProcessCliBackend,
  ProcessCliAuthError,
  ProcessCliProcessError,
  ProcessCliTimeoutError,
} from './process-cli-backend';

const baseRequest: BackendRunRequest = {
  taskId: 't1',
  stage: 'implement',
  attempt: 1,
  callIndex: 1,
  backend: 'test-cli',
  model: 'model-x',
  workspaceRef: '/tmp/ws',
  limits: { maxTokens: 1000, timeoutMs: 5000 },
  prompt: 'do the thing',
};

class TestCliBackend extends ProcessCliBackend {
  protected buildArgs(req: BackendRunRequest): string[] {
    return ['--run', req.model];
  }
  protected parseOutput(stdout: string, stderr: string, elapsedMs: number): AgentRunResult {
    try {
      const parsed = JSON.parse(stdout) as { text?: string; tokens?: number };
      if (typeof parsed.text !== 'string') throw new Error('no text');
      return { output: parsed.text, tokensIn: parsed.tokens ?? 0, tokensOut: 0, wallMs: elapsedMs };
    } catch {
      return { output: stdout || stderr, tokensIn: 0, tokensOut: 0, wallMs: elapsedMs };
    }
  }
  protected isAuthError(stderr: string): boolean {
    return /unauthorized/i.test(stderr);
  }
}

function fakeChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: { write: (chunk: string) => void; end: () => void };
    kill: (signal?: string) => void;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const stdinWrites: string[] = [];
  child.stdin = {
    write: (chunk: string) => stdinWrites.push(chunk),
    end: () => {},
  };
  const killedSignals: (string | undefined)[] = [];
  child.kill = (signal?: string) => killedSignals.push(signal);
  return { child, killedSignals, stdinWrites };
}

describe('ProcessCliBackend', () => {
  it('spawns with buildArgs output and pipes the prompt via stdin', async () => {
    const { child, stdinWrites } = fakeChildProcess();
    const calls: { command: string; args: string[] }[] = [];
    const spawnFn = vi.fn((command: string, args: string[]) => {
      calls.push({ command, args });
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ text: 'ok', tokens: 5 }));
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new TestCliBackend({ executablePath: 'test-cli', spawn: spawnFn as never });

    const result = await backend.run(baseRequest);

    expect(calls[0]).toEqual({ command: 'test-cli', args: ['--run', 'model-x'] });
    expect(stdinWrites.join('')).toBe('do the thing');
    expect(result).toEqual({ output: 'ok', tokensIn: 5, tokensOut: 0, wallMs: expect.any(Number) });
  });

  it('delegates malformed output to parseOutput\'s own fallback (never throws on garbage)', async () => {
    const { child } = fakeChildProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end('not json');
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new TestCliBackend({ executablePath: 'test-cli', spawn: spawnFn as never });

    const result = await backend.run(baseRequest);

    expect(result.output).toBe('not json');
  });

  it('throws ProcessCliAuthError when isAuthError matches stderr', async () => {
    const { child } = fakeChildProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end('');
        child.stderr.end('401 unauthorized');
        child.emit('close', 1);
      });
      return child;
    });
    const backend = new TestCliBackend({ executablePath: 'test-cli', spawn: spawnFn as never });

    await expect(backend.run(baseRequest)).rejects.toThrow(ProcessCliAuthError);
  });

  it('throws ProcessCliProcessError on nonzero exit with no stdout', async () => {
    const { child } = fakeChildProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end('');
        child.stderr.end('fatal error');
        child.emit('close', 1);
      });
      return child;
    });
    const backend = new TestCliBackend({ executablePath: 'test-cli', spawn: spawnFn as never });

    await expect(backend.run(baseRequest)).rejects.toThrow(ProcessCliProcessError);
  });

  it('throws ProcessCliTimeoutError and sends SIGTERM when the process hangs', async () => {
    const { child, killedSignals } = fakeChildProcess();
    const spawnFn = vi.fn(() => child); // never closes
    const backend = new TestCliBackend({ executablePath: 'test-cli', spawn: spawnFn as never, killGraceMs: 10 });

    await expect(
      backend.run({ ...baseRequest, limits: { maxTokens: 1000, timeoutMs: 20 } }),
    ).rejects.toThrow(ProcessCliTimeoutError);
    expect(killedSignals).toContain('SIGTERM');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/backends/src/process-cli-backend.test.ts`
Expected: FAIL — `Cannot find module './process-cli-backend'`.

- [ ] **Step 3: Implement**

```ts
// packages/backends/src/process-cli-backend.ts
import { spawn as nodeSpawn } from 'node:child_process';
import type { AgentRunResult, BackendRunRequest } from '@agentops/contracts';
import type { AgentBackend } from './agent-backend';

export class ProcessCliProcessError extends Error {}
export class ProcessCliTimeoutError extends Error {}
export class ProcessCliAuthError extends Error {}

export interface ProcessCliBackendOptions {
  executablePath: string;
  spawn?: typeof nodeSpawn;
  env?: NodeJS.ProcessEnv;
  killGraceMs?: number;
}

export abstract class ProcessCliBackend implements AgentBackend {
  protected readonly executablePath: string;
  private readonly spawnFn: typeof nodeSpawn;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly killGraceMs: number;

  constructor(opts: ProcessCliBackendOptions) {
    this.executablePath = opts.executablePath;
    this.spawnFn = opts.spawn ?? nodeSpawn;
    this.env = opts.env;
    this.killGraceMs = opts.killGraceMs ?? 5000;
  }

  protected abstract buildArgs(req: BackendRunRequest): string[];
  protected abstract parseOutput(stdout: string, stderr: string, elapsedMs: number): AgentRunResult;
  protected abstract isAuthError(stderr: string): boolean;

  async run(req: BackendRunRequest): Promise<AgentRunResult> {
    const args = this.buildArgs(req);
    const start = Date.now();
    const child = this.spawnFn(this.executablePath, args, {
      cwd: req.workspaceRef,
      env: this.env ?? process.env,
    });
    child.stdin?.write(req.prompt);
    child.stdin?.end();

    return new Promise<AgentRunResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), this.killGraceMs);
        settle(() => reject(new ProcessCliTimeoutError(`${this.executablePath} timed out after ${req.limits.timeoutMs}ms`)));
      }, req.limits.timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (err: Error) => {
        settle(() => reject(new ProcessCliProcessError(`failed to spawn ${this.executablePath}: ${err.message}`)));
      });

      child.on('close', (exitCode: number | null) => {
        settle(() => {
          const wallMs = Date.now() - start;

          if (this.isAuthError(stderr)) {
            reject(new ProcessCliAuthError(stderr.trim()));
            return;
          }
          if (stdout.trim().length === 0 && (exitCode ?? 1) !== 0) {
            reject(new ProcessCliProcessError(`${this.executablePath} exited ${exitCode} with no output: ${stderr.trim()}`));
            return;
          }
          resolve(this.parseOutput(stdout, stderr, wallMs));
        });
      });
    });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/backends/src/process-cli-backend.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Export it**

`packages/backends/src/index.ts`:

```ts
export * from './agent-backend';
export * from './stub/stub-backend';
export * from './process-cli-backend';
export * from './claude/claude-backend';
```

- [ ] **Step 6: Commit**

```bash
git add packages/backends/src/process-cli-backend.ts packages/backends/src/process-cli-backend.test.ts packages/backends/src/index.ts
git commit -m "feat(backends): extract ProcessCliBackend shared base from ClaudeBackend"
```

---

### Task 3: Retrofit `ClaudeBackend` onto `ProcessCliBackend`

**Files:**
- Modify: `packages/backends/src/claude/claude-backend.ts`

This is a pure refactor — `claude-backend.test.ts` (already written, already merged) must pass **unchanged**. If any existing test needs editing to pass, that's a sign the retrofit changed behavior, not just structure — stop and fix the implementation, not the test.

- [ ] **Step 1: Replace the implementation**

```ts
// packages/backends/src/claude/claude-backend.ts
import type { AgentRunResult, BackendRunRequest } from '@agentops/contracts';
import {
  ProcessCliBackend,
  ProcessCliAuthError,
  ProcessCliProcessError,
  ProcessCliTimeoutError,
  type ProcessCliBackendOptions,
} from '../process-cli-backend';

// Re-exported under the original names so claude-backend.test.ts's
// `rejects.toThrow(ClaudeBackendTimeoutError)`-style assertions keep working —
// these are the exact same classes the shared base actually throws.
export { ProcessCliProcessError as ClaudeBackendProcessError };
export { ProcessCliTimeoutError as ClaudeBackendTimeoutError };
export { ProcessCliAuthError as ClaudeBackendAuthError };

export interface ClaudeBackendOptions {
  executablePath?: string;
  spawn?: ProcessCliBackendOptions['spawn'];
  env?: NodeJS.ProcessEnv;
  maxTurns?: number;
  killGraceMs?: number;
}

interface ClaudeJsonResult {
  is_error?: boolean;
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  duration_ms?: number;
}

const AUTH_ERROR_PATTERN = /(invalid|expired).{0,30}(api key|token)/i;

export class ClaudeBackend extends ProcessCliBackend {
  private readonly maxTurns: number;

  constructor(opts: ClaudeBackendOptions = {}) {
    super({
      executablePath: opts.executablePath ?? 'claude',
      spawn: opts.spawn,
      env: opts.env,
      killGraceMs: opts.killGraceMs,
    });
    this.maxTurns = opts.maxTurns ?? 30;
  }

  protected buildArgs(req: BackendRunRequest): string[] {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--model',
      req.model,
      '--max-turns',
      String(this.maxTurns),
      '--dangerously-skip-permissions',
    ];
    if (req.effort) {
      args.push('--effort', req.effort);
    }
    return args;
  }

  protected parseOutput(stdout: string, stderr: string, elapsedMs: number): AgentRunResult {
    let parsed: ClaudeJsonResult | undefined;
    try {
      parsed = JSON.parse(stdout) as ClaudeJsonResult;
    } catch {
      parsed = undefined;
    }

    if (!parsed || typeof parsed.result !== 'string') {
      return { output: stdout || stderr, tokensIn: 0, tokensOut: 0, wallMs: elapsedMs };
    }

    return {
      output: parsed.result,
      tokensIn: parsed.usage?.input_tokens ?? 0,
      tokensOut: parsed.usage?.output_tokens ?? 0,
      wallMs: parsed.duration_ms ?? elapsedMs,
    };
  }

  protected isAuthError(stderr: string): boolean {
    return AUTH_ERROR_PATTERN.test(stderr);
  }
}
```

- [ ] **Step 2: Run the existing test suite unchanged to confirm no behavior changed**

Run: `pnpm exec vitest run packages/backends/src/claude/claude-backend.test.ts`
Expected: PASS (all 8 tests, same file, zero edits).

- [ ] **Step 3: Full backends package typecheck**

Run: `pnpm --filter @agentops/backends run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/backends/src/claude/claude-backend.ts
git commit -m "refactor(backends): retrofit ClaudeBackend onto ProcessCliBackend"
```

---

### Task 4: `PiBackend`

**Files:**
- Create: `packages/backends/src/pi/pi-backend.ts`
- Test: `packages/backends/src/pi/pi-backend.test.ts`

**Before writing this task's code, re-read Task 1's recorded findings.** The code below is the working hypothesis (mirrors `ClaudeBackend`'s shape exactly, with executable name `pi`) — if Task 1 found a real discrepancy, adapt `buildArgs`/`parseOutput`/`isAuthError` below accordingly before implementing; everything else in this task (test structure, the base-class wiring) is unaffected either way.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/backends/src/pi/pi-backend.test.ts
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { BackendRunRequest } from '@agentops/contracts';
import { PiBackend } from './pi-backend';
import { ProcessCliAuthError, ProcessCliProcessError, ProcessCliTimeoutError } from '../process-cli-backend';

const baseRequest: BackendRunRequest = {
  taskId: 't1',
  stage: 'implement',
  attempt: 1,
  callIndex: 1,
  backend: 'pi',
  model: 'pi-default',
  workspaceRef: '/tmp/ws',
  limits: { maxTokens: 1000, timeoutMs: 5000 },
  prompt: 'do the thing',
};

function fakeChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: { write: (chunk: string) => void; end: () => void };
    kill: (signal?: string) => void;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const stdinWrites: string[] = [];
  child.stdin = { write: (chunk: string) => stdinWrites.push(chunk), end: () => {} };
  const killedSignals: (string | undefined)[] = [];
  child.kill = (signal?: string) => killedSignals.push(signal);
  return { child, killedSignals, stdinWrites };
}

describe('PiBackend', () => {
  it('spawns pi with the expected flags and pipes the prompt via stdin', async () => {
    const { child, stdinWrites } = fakeChildProcess();
    const calls: { command: string; args: string[] }[] = [];
    const spawnFn = vi.fn((command: string, args: string[]) => {
      calls.push({ command, args });
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ is_error: false, result: 'ok', usage: { input_tokens: 3, output_tokens: 4 }, duration_ms: 7 }));
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new PiBackend({ spawn: spawnFn as never });

    const result = await backend.run(baseRequest);

    expect(calls[0].command).toBe('pi');
    expect(calls[0].args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--model',
      'pi-default',
      '--max-turns',
      '30',
      '--dangerously-skip-permissions',
    ]);
    expect(stdinWrites.join('')).toBe('do the thing');
    expect(result).toEqual({ output: 'ok', tokensIn: 3, tokensOut: 4, wallMs: 7 });
  });

  it('returns raw text with zero tokens when stdout is not valid JSON (never throws)', async () => {
    const { child } = fakeChildProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end('not json');
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new PiBackend({ spawn: spawnFn as never });

    const result = await backend.run(baseRequest);

    expect(result.output).toBe('not json');
    expect(result.tokensIn).toBe(0);
  });

  it('throws ProcessCliAuthError when stderr matches the auth-failure pattern', async () => {
    const { child } = fakeChildProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end('');
        child.stderr.end('Error: expired token');
        child.emit('close', 1);
      });
      return child;
    });
    const backend = new PiBackend({ spawn: spawnFn as never });

    await expect(backend.run(baseRequest)).rejects.toThrow(ProcessCliAuthError);
  });

  it('throws ProcessCliProcessError on nonzero exit with no stdout', async () => {
    const { child } = fakeChildProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end('');
        child.stderr.end('fatal: bad flag');
        child.emit('close', 1);
      });
      return child;
    });
    const backend = new PiBackend({ spawn: spawnFn as never });

    await expect(backend.run(baseRequest)).rejects.toThrow(ProcessCliProcessError);
  });

  it('throws ProcessCliTimeoutError when the process hangs', async () => {
    const { child, killedSignals } = fakeChildProcess();
    const spawnFn = vi.fn(() => child);
    const backend = new PiBackend({ spawn: spawnFn as never, killGraceMs: 10 });

    await expect(
      backend.run({ ...baseRequest, limits: { maxTokens: 1000, timeoutMs: 20 } }),
    ).rejects.toThrow(ProcessCliTimeoutError);
    expect(killedSignals).toContain('SIGTERM');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/backends/src/pi/pi-backend.test.ts`
Expected: FAIL — `Cannot find module './pi-backend'`.

- [ ] **Step 3: Implement (adjust per Task 1's findings if they diverged from this hypothesis)**

```ts
// packages/backends/src/pi/pi-backend.ts
import type { AgentRunResult, BackendRunRequest } from '@agentops/contracts';
import { ProcessCliBackend, type ProcessCliBackendOptions } from '../process-cli-backend';

export interface PiBackendOptions {
  executablePath?: string;
  spawn?: ProcessCliBackendOptions['spawn'];
  env?: NodeJS.ProcessEnv;
  maxTurns?: number;
  killGraceMs?: number;
}

interface PiJsonResult {
  is_error?: boolean;
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  duration_ms?: number;
}

const AUTH_ERROR_PATTERN = /(invalid|expired).{0,30}(api key|token)/i;

export class PiBackend extends ProcessCliBackend {
  private readonly maxTurns: number;

  constructor(opts: PiBackendOptions = {}) {
    super({
      executablePath: opts.executablePath ?? 'pi',
      spawn: opts.spawn,
      env: opts.env,
      killGraceMs: opts.killGraceMs,
    });
    this.maxTurns = opts.maxTurns ?? 30;
  }

  protected buildArgs(req: BackendRunRequest): string[] {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--model',
      req.model,
      '--max-turns',
      String(this.maxTurns),
      '--dangerously-skip-permissions',
    ];
    if (req.effort) {
      args.push('--effort', req.effort);
    }
    return args;
  }

  protected parseOutput(stdout: string, stderr: string, elapsedMs: number): AgentRunResult {
    let parsed: PiJsonResult | undefined;
    try {
      parsed = JSON.parse(stdout) as PiJsonResult;
    } catch {
      parsed = undefined;
    }

    if (!parsed || typeof parsed.result !== 'string') {
      return { output: stdout || stderr, tokensIn: 0, tokensOut: 0, wallMs: elapsedMs };
    }

    return {
      output: parsed.result,
      tokensIn: parsed.usage?.input_tokens ?? 0,
      tokensOut: parsed.usage?.output_tokens ?? 0,
      wallMs: parsed.duration_ms ?? elapsedMs,
    };
  }

  protected isAuthError(stderr: string): boolean {
    return AUTH_ERROR_PATTERN.test(stderr);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/backends/src/pi/pi-backend.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Export it**

`packages/backends/src/index.ts`:

```ts
export * from './agent-backend';
export * from './stub/stub-backend';
export * from './process-cli-backend';
export * from './claude/claude-backend';
export * from './pi/pi-backend';
```

- [ ] **Step 6: Commit**

```bash
git add packages/backends/src/pi/pi-backend.ts packages/backends/src/pi/pi-backend.test.ts packages/backends/src/index.ts
git commit -m "feat(backends): add PiBackend (pending Task 1 CLI-contract verification)"
```

---

### Task 5: Full local verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full gate**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e
```

Expected: all green. `pnpm e2e` isn't expected to exercise `PiBackend`/`ClaudeBackend` at all (the e2e suite is `stub`-only per AGENTS.md hard rule 5) — this run is confirming the refactor in Task 3 didn't regress anything else.

- [ ] **Step 2: Commit if the gate required any fixes**

```bash
git add -A
git commit -m "chore: fix lint/typecheck fallout from pi backend"
```

(Skip if Step 1 was already green.)

---

### Task 6: Open the PR, pass CI, and resolve the Bugbot review

**Files:** none (integration / review).

> Sequential and partly asynchronous — CI and Bugbot run on the remote PR.
> **HARD GATE: Do not mark this task complete until ALL Bugbot comments are
> resolved (fixed or replied to) AND CI is green. Check with
> `gh pr view --json reviews,comments` before claiming done.**

- [ ] **Step 1: Sync the latest `main`**

```bash
git fetch origin
git merge origin/main
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e   # resolve conflicts + commit first if any; fix fallout
```

- [ ] **Step 2: Push and open the PR**

```bash
git status --short && git rev-parse --abbrev-ref HEAD   # clean tree, on feature branch (not main)
git push -u origin HEAD
gh pr create --base main --fill --title "feat: pi backend (shared ProcessCliBackend base)"
```

- [ ] **Step 3: Subagent code review**

REQUIRED SUB-SKILL: `requesting-code-review`. Dispatch a code reviewer subagent (BASE_SHA = merge-base with `main`, HEAD_SHA = HEAD). Fix Critical and Important findings, commit, push, then proceed.

- [ ] **Step 4: Make every CI check pass**

```bash
gh pr checks --watch
```
On failure: `gh run view --log-failed`, reproduce locally, fix, commit, push, re-watch. Do not proceed while red.

- [ ] **Step 5: Wait for the Bugbot review**

```bash
gh pr view --json reviews,comments
gh pr comment --body "bugbot run"   # only if it hasn't reviewed yet
```

- [ ] **Step 6: Address each Bugbot comment**

REQUIRED SUB-SKILL: `receiving-code-review`. Verify before acting — reply to false positives; TDD-fix real findings, commit each referencing the finding, push once.

**Then mark each addressed thread resolved** (completion is gated on the unresolved-thread count, not just on having replied/fixed):

```bash
gh api graphql -f query='query($o:String!,$r:String!,$p:Int!){repository(owner:$o,name:$r){pullRequest(number:$p){reviewThreads(first:100){nodes{id isResolved path comments(first:1){nodes{body}}}}}}}' -F o=<owner> -F r=<repo> -F p=<number>
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=<thread-id>
```

**After pushing:** return to Step 4 (re-watch CI), then Step 5 (wait for re-review). Loop until Bugbot reports no unresolved comments.

- [ ] **Step 7: Final verification**

```bash
gh pr checks                          # all green
gh pr view --json reviews,comments    # no comment left unaddressed
pnpm lint && pnpm typecheck && pnpm test && pnpm test:policies-coverage && pnpm e2e   # suite green locally
```
Confirm no unresolved review threads remain, then mark this task complete.
