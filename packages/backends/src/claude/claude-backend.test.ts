import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { BackendRunRequest } from '@agentops/contracts';
import { ClaudeBackendAuthError, ClaudeBackendProcessError, ClaudeBackendTimeoutError, createClaudeCliSpec } from './claude-backend';
import { ProcessCliRunner } from '../process-cli-runner';

const baseRequest: BackendRunRequest = {
  taskId: 't1',
  stage: 'implement',
  attempt: 1,
  callIndex: 1,
  backend: 'claude',
  model: 'claude-sonnet-5',
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
  child.stdin = {
    write: (chunk: string) => {
      stdinWrites.push(chunk);
    },
    end: () => {},
  };
  const killedSignals: (string | undefined)[] = [];
  child.kill = (signal?: string) => {
    killedSignals.push(signal);
  };
  return { child, killedSignals, stdinWrites };
}

describe('ClaudeBackend', () => {
  it('spawns claude with the expected flags and pipes the prompt via stdin, not argv', async () => {
    const { child, stdinWrites } = fakeChildProcess();
    const calls: { command: string; args: string[] }[] = [];
    const spawnFn = vi.fn((command: string, args: string[]) => {
      calls.push({ command, args });
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 2 }, duration_ms: 10 }));
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ProcessCliRunner(createClaudeCliSpec(), { spawn: spawnFn as never });

    await backend.run(baseRequest);

    expect(calls[0].command).toBe('claude');
    expect(calls[0].args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--model',
      'claude-sonnet-5',
      '--max-turns',
      '30',
      '--dangerously-skip-permissions',
    ]);
    expect(stdinWrites.join('')).toBe('do the thing');
  });

  it('adds --effort when the request specifies one', async () => {
    const { child } = fakeChildProcess();
    const calls: string[][] = [];
    const spawnFn = vi.fn((_command: string, args: string[]) => {
      calls.push(args);
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 1 }));
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ProcessCliRunner(createClaudeCliSpec(), { spawn: spawnFn as never });

    await backend.run({ ...baseRequest, effort: 'high' });

    expect(calls[0]).toContain('--effort');
    expect(calls[0][calls[0].indexOf('--effort') + 1]).toBe('high');
  });

  it('maps valid JSON output to AgentRunResult', async () => {
    const { child } = fakeChildProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end(
          JSON.stringify({ is_error: false, result: 'final text', usage: { input_tokens: 12, output_tokens: 34 }, duration_ms: 999 }),
        );
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ProcessCliRunner(createClaudeCliSpec(), { spawn: spawnFn as never });

    const result = await backend.run(baseRequest);

    expect(result).toEqual({ output: 'final text', tokensIn: 12, tokensOut: 34, wallMs: 999 });
  });

  it('returns raw text with zero tokens when stdout is not valid JSON (never throws)', async () => {
    const { child } = fakeChildProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end('not json at all');
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ProcessCliRunner(createClaudeCliSpec(), { spawn: spawnFn as never });

    const result = await backend.run(baseRequest);

    expect(result.output).toBe('not json at all');
    expect(result.tokensIn).toBe(0);
    expect(result.tokensOut).toBe(0);
  });

  it('returns is_error:true JSON output as a normal result (verdict parsing happens downstream)', async () => {
    const { child } = fakeChildProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end(
          JSON.stringify({ is_error: true, result: 'hit an internal snag', usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 5 }),
        );
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ProcessCliRunner(createClaudeCliSpec(), { spawn: spawnFn as never });

    const result = await backend.run(baseRequest);

    expect(result.output).toBe('hit an internal snag');
  });

  it('throws ClaudeBackendProcessError when the process exits nonzero with no stdout at all', async () => {
    const { child } = fakeChildProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end('');
        child.stderr.end('fatal: bad flag');
        child.emit('close', 1);
      });
      return child;
    });
    const backend = new ProcessCliRunner(createClaudeCliSpec(), { spawn: spawnFn as never });

    await expect(backend.run(baseRequest)).rejects.toThrow(ClaudeBackendProcessError);
  });

  it('throws ClaudeBackendAuthError when stderr matches a known auth-failure pattern', async () => {
    const { child } = fakeChildProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end('');
        child.stderr.end('Error: invalid api key');
        child.emit('close', 1);
      });
      return child;
    });
    const backend = new ProcessCliRunner(createClaudeCliSpec(), { spawn: spawnFn as never });

    await expect(backend.run(baseRequest)).rejects.toThrow(ClaudeBackendAuthError);
  });

  it('throws ClaudeBackendTimeoutError and sends SIGTERM when the process outlives the timeout', async () => {
    const { child, killedSignals } = fakeChildProcess();
    const spawnFn = vi.fn(() => child);
    const backend = new ProcessCliRunner(createClaudeCliSpec(), { spawn: spawnFn as never, killGraceMs: 10 });

    await expect(backend.run({ ...baseRequest, limits: { maxTokens: 1000, timeoutMs: 20 } })).rejects.toThrow(
      ClaudeBackendTimeoutError,
    );
    expect(killedSignals).toContain('SIGTERM');
  });
});
