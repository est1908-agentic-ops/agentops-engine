import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { SpawnCommandRunner } from './spawn-command-runner';

function fakeSpawn(exitCode: number, stdout: string, stderr: string) {
  const calls: { command: string; options: unknown }[] = [];
  const spawnFn = vi.fn((command: string, options: unknown) => {
    calls.push({ command, options });
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      child.emit('close', exitCode);
    });
    return child;
  });
  return { spawnFn, calls };
}

describe('SpawnCommandRunner', () => {
  it('runs the given command string through a shell with the given cwd', async () => {
    const { spawnFn, calls } = fakeSpawn(0, 'ok', '');
    const runner = new SpawnCommandRunner({ spawn: spawnFn as never });

    await runner.run('pnpm install', { cwd: '/tmp/workspace' });

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('pnpm install');
    expect((calls[0].options as { cwd: string; shell: boolean }).cwd).toBe('/tmp/workspace');
    expect((calls[0].options as { shell: boolean }).shell).toBe(true);
  });

  it('resolves with stdout, stderr, and exit code on any exit (never throws itself)', async () => {
    const { spawnFn } = fakeSpawn(1, 'partial output', 'command not found');
    const runner = new SpawnCommandRunner({ spawn: spawnFn as never });

    const result = await runner.run('nonsense', { cwd: '/tmp/workspace' });

    expect(result).toEqual({ stdout: 'partial output', stderr: 'command not found', exitCode: 1 });
  });

  it('resolves (never hangs, never throws) when the process itself fails to spawn', async () => {
    const spawnFn = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        child.emit('error', new Error('spawn sh ENOENT'));
      });
      return child;
    });
    const runner = new SpawnCommandRunner({ spawn: spawnFn as never });

    const result = await runner.run('pnpm install', { cwd: '/does/not/exist' });

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('spawn sh ENOENT');
    expect(result.spawnFailed).toBe(true);
  });

  it('does not set spawnFailed when the command itself runs and merely exits non-zero', async () => {
    const { spawnFn } = fakeSpawn(127, '', 'sh: pnpm: command not found');
    const runner = new SpawnCommandRunner({ spawn: spawnFn as never });

    const result = await runner.run('pnpm install', { cwd: '/tmp/workspace' });

    expect(result.exitCode).toBe(127);
    expect(result.spawnFailed).toBeUndefined();
  });
});
