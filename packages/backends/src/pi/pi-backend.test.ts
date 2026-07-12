import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { BackendRunRequest } from '@agentops/contracts';
import { createPiCliSpec } from './pi-backend';
import { ProcessCliAuthError, ProcessCliProcessError, ProcessCliTimeoutError, ProcessCliRunner } from '../process-cli-runner';
import { RateLimitError, SessionLimitError } from '../provider-rate-limit';

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

const piJsonlOutput = [
  '{"type":"session","version":3,"id":"s1","timestamp":"2026-07-03T00:00:00.000Z","cwd":"/tmp/ws"}',
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input":12,"output":34}}}',
].join('\n');

describe('PiBackend', () => {
  it('spawns pi with the expected flags and pipes the prompt via stdin', async () => {
    const { child, stdinWrites } = fakeChildProcess();
    const calls: { command: string; args: string[] }[] = [];
    const spawnFn = vi.fn((command: string, args: string[]) => {
      calls.push({ command, args });
      queueMicrotask(() => {
        child.stdout.end(piJsonlOutput);
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ProcessCliRunner(createPiCliSpec(), { spawn: spawnFn as never });

    const result = await backend.run(baseRequest);

    expect(calls[0].command).toBe('pi');
    expect(calls[0].args).toEqual(['--print', '--mode', 'json', '--model', 'pi-default', '--no-session']);
    expect(stdinWrites.join('')).toBe('do the thing');
    expect(result).toEqual({ output: 'ok', tokensIn: 12, tokensOut: 34, wallMs: expect.any(Number) });
  });

  it('throws ProcessCliProcessError when stdout is not valid JSONL', async () => {
    const { child } = fakeChildProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end('not json');
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ProcessCliRunner(createPiCliSpec(), { spawn: spawnFn as never });

    await expect(backend.run(baseRequest)).rejects.toThrow(ProcessCliProcessError);
  });

  it('throws ProcessCliProcessError when the last assistant turn ends with stopReason "error", even though pi exits 0', async () => {
    const { child } = fakeChildProcess();
    const errorJsonl = [
      '{"type":"session","version":3,"id":"s1","timestamp":"2026-07-03T00:00:00.000Z","cwd":"/tmp/ws"}',
      '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"401 token expired or incorrect"}}',
    ].join('\n');
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end(errorJsonl);
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ProcessCliRunner(createPiCliSpec(), { spawn: spawnFn as never });

    let error: unknown;
    try {
      await backend.run(baseRequest);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ProcessCliProcessError);
    expect((error as Error).message).toMatch(/401 token expired or incorrect/);
  });

  it('throws ProcessCliProcessError when the last assistant turn ends "aborted"', async () => {
    const { child } = fakeChildProcess();
    const abortedJsonl = [
      '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"aborted"}}',
    ].join('\n');
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end(abortedJsonl);
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ProcessCliRunner(createPiCliSpec(), { spawn: spawnFn as never });

    await expect(backend.run(baseRequest)).rejects.toThrow(ProcessCliProcessError);
  });

  it('throws RateLimitError (not ProcessCliProcessError) when the error message matches a provider rate-limit pattern', async () => {
    const { child } = fakeChildProcess();
    const errorMessage =
      "429 Your account's current usage pattern does not comply with the Fair Usage Policy, and your request frequency has been limited.";
    const rateLimitedJsonl = JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage },
    });
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end(rateLimitedJsonl);
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ProcessCliRunner(createPiCliSpec(), { spawn: spawnFn as never });

    let error: unknown;
    try {
      await backend.run(baseRequest);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).not.toBeInstanceOf(ProcessCliProcessError);
  });

  it('throws SessionLimitError when the error message matches a session-limit pattern', async () => {
    const { child } = fakeChildProcess();
    const errorMessage = "You've hit your session limit · resets 9:30am (UTC)";
    const sessionLimitJsonl = JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage },
    });
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end(sessionLimitJsonl);
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ProcessCliRunner(createPiCliSpec(), { spawn: spawnFn as never });

    let error: unknown;
    try {
      await backend.run(baseRequest);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(SessionLimitError);
    expect(error).not.toBeInstanceOf(RateLimitError);
  });

  it('throws ProcessCliAuthError when stderr matches the auth-failure pattern', async () => {
    const { child } = fakeChildProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end('');
        child.stderr.end('No API key found for google');
        child.emit('close', 1);
      });
      return child;
    });
    const backend = new ProcessCliRunner(createPiCliSpec(), { spawn: spawnFn as never });

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
    const backend = new ProcessCliRunner(createPiCliSpec(), { spawn: spawnFn as never });

    await expect(backend.run(baseRequest)).rejects.toThrow(ProcessCliProcessError);
  });

  it('throws ProcessCliTimeoutError when the process hangs', async () => {
    const { child, killedSignals } = fakeChildProcess();
    const spawnFn = vi.fn(() => child);
    const backend = new ProcessCliRunner(createPiCliSpec(), { spawn: spawnFn as never, killGraceMs: 10 });

    await expect(
      backend.run({ ...baseRequest, limits: { maxTokens: 1000, timeoutMs: 20 } }),
    ).rejects.toThrow(ProcessCliTimeoutError);
    expect(killedSignals).toContain('SIGTERM');
  });
});
