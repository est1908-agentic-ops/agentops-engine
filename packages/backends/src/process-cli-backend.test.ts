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

  it("delegates malformed output to parseOutput's own fallback (never throws on garbage)", async () => {
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
    const spawnFn = vi.fn(() => child);
    const backend = new TestCliBackend({ executablePath: 'test-cli', spawn: spawnFn as never, killGraceMs: 10 });

    await expect(
      backend.run({ ...baseRequest, limits: { maxTokens: 1000, timeoutMs: 20 } }),
    ).rejects.toThrow(ProcessCliTimeoutError);
    expect(killedSignals).toContain('SIGTERM');
  });
});
