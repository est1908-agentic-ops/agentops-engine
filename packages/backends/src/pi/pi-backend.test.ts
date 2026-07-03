import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { BackendRunRequest } from '@agentops/contracts';
import { createPiCliSpec } from './pi-backend';
import { ProcessCliAuthError, ProcessCliProcessError, ProcessCliTimeoutError, ProcessCliRunner } from '../process-cli-runner';

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
  '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
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
    expect(result).toEqual({ output: 'ok', tokensIn: 0, tokensOut: 0, wallMs: expect.any(Number) });
  });

  it('returns raw text with zero tokens when stdout is not valid JSONL (never throws)', async () => {
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

    const result = await backend.run(baseRequest);

    expect(result.output).toBe('not json');
    expect(result.tokensIn).toBe(0);
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
