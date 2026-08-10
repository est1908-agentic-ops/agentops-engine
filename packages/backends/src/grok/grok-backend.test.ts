import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { BackendRunRequest } from '@agentops/contracts';
import {
  GrokBackendAuthError,
  GrokBackendProcessError,
  createGrokCliSpec,
} from './grok-backend';
import { RateLimitError, SessionLimitError } from '../provider-rate-limit';
import { ProcessCliRunner } from '../process-cli-runner';

const baseRequest: BackendRunRequest = {
  taskId: 't1',
  stage: 'implement',
  attempt: 1,
  callIndex: 1,
  backend: 'grok',
  model: 'grok-4.5',
  workspaceRef: '/tmp/ws',
  limits: { maxTokens: 1000, timeoutMs: 5000 },
  prompt: 'do the thing',
};

function streamJson(
  result: Record<string, unknown>,
  leading: Record<string, unknown>[] = [{ type: 'system', subtype: 'init', session_id: 's1' }],
): string {
  return [...leading, { type: 'result', subtype: 'success', ...result }]
    .map((event) => JSON.stringify(event))
    .join('\n');
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

describe('GrokBackend', () => {
  it('spawns grok with stdin prompt file, streaming output, and write-stage permissions', async () => {
    const { child, stdinWrites } = fakeChildProcess();
    const calls: { command: string; args: string[] }[] = [];
    const spawnFn = vi.fn((command: string, args: string[]) => {
      calls.push({ command, args });
      queueMicrotask(() => {
        child.stdout.end(
          streamJson({
            is_error: false,
            result: 'ok',
            usage: { input_tokens: 1, output_tokens: 2 },
            duration_ms: 10,
          }),
        );
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ProcessCliRunner(createGrokCliSpec(), { spawn: spawnFn as never });

    await backend.run(baseRequest);

    expect(calls[0].command).toBe('grok');
    expect(calls[0].args).toEqual([
      '--prompt-file',
      '/dev/stdin',
      '--output-format',
      'streaming-messages-json',
      '--no-auto-update',
      '--model',
      'grok-4.5',
      '--permission-mode',
      'bypassPermissions',
    ]);
    expect(stdinWrites.join('')).toBe('do the thing');
  });

  it('uses plan permission mode for read-only stages and forwards effort', async () => {
    const { child } = fakeChildProcess();
    const calls: { command: string; args: string[] }[] = [];
    const spawnFn = vi.fn((command: string, args: string[]) => {
      calls.push({ command, args });
      queueMicrotask(() => {
        child.stdout.end(
          streamJson({
            is_error: false,
            result: 'ok',
            usage: { input_tokens: 1, output_tokens: 1 },
            duration_ms: 5,
          }),
        );
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ProcessCliRunner(createGrokCliSpec(), { spawn: spawnFn as never });

    await backend.run({
      ...baseRequest,
      stage: 'bughunt',
      effort: 'high',
    });

    expect(calls[0].args).toEqual(
      expect.arrayContaining(['--permission-mode', 'plan', '--effort', 'high']),
    );
  });

  it('parses the terminal result event for output and tokens', async () => {
    const { child } = fakeChildProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end(
          streamJson({
            is_error: false,
            result: 'investigation complete',
            usage: { input_tokens: 11, output_tokens: 22 },
            duration_ms: 33,
          }),
        );
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ProcessCliRunner(createGrokCliSpec(), { spawn: spawnFn as never });

    const result = await backend.run(baseRequest);

    expect(result).toEqual({
      output: 'investigation complete',
      tokensIn: 11,
      tokensOut: 22,
      wallMs: 33,
    });
  });

  it('throws SessionLimitError when is_error carries a usage-window cap', async () => {
    const { child } = fakeChildProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end(
          streamJson({
            is_error: true,
            result: "You've hit your weekly limit · resets Aug 11, 7pm (UTC)",
            usage: { input_tokens: 1, output_tokens: 1 },
            duration_ms: 5,
          }),
        );
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ProcessCliRunner(createGrokCliSpec(), { spawn: spawnFn as never });

    let error: unknown;
    try {
      await backend.run(baseRequest);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(SessionLimitError);
    expect(error).not.toBeInstanceOf(GrokBackendProcessError);
  });

  it('throws RateLimitError when is_error carries a 429 rate-limit phrasing', async () => {
    const { child } = fakeChildProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end(
          streamJson({
            is_error: true,
            result: '429 Too Many Requests: fair usage policy rate limit',
            usage: { input_tokens: 1, output_tokens: 1 },
            duration_ms: 5,
          }),
        );
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ProcessCliRunner(createGrokCliSpec(), { spawn: spawnFn as never });

    await expect(backend.run(baseRequest)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('throws GrokBackendAuthError when stderr matches an auth failure', async () => {
    const { child } = fakeChildProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end('');
        child.stderr.end('Failed to authenticate: invalid API key');
        child.emit('close', 1);
      });
      return child;
    });
    const backend = new ProcessCliRunner(createGrokCliSpec(), { spawn: spawnFn as never });

    await expect(backend.run(baseRequest)).rejects.toBeInstanceOf(GrokBackendAuthError);
  });

  it('throws ProcessCliProcessError when no result event is produced', async () => {
    const { child } = fakeChildProcess();
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.end('not json at all\n');
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    });
    const backend = new ProcessCliRunner(createGrokCliSpec(), { spawn: spawnFn as never });

    await expect(backend.run(baseRequest)).rejects.toBeInstanceOf(GrokBackendProcessError);
  });
});
