import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { SpawnGitCommandRunner } from './spawn-git-command-runner';

function fakeSpawn(exitCode: number, stdout: string, stderr: string) {
  const calls: { command: string; args: string[]; options: unknown }[] = [];
  const spawnFn = vi.fn((command: string, args: string[], options: unknown) => {
    calls.push({ command, args, options });
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

describe('SpawnGitCommandRunner', () => {
  it('prepends the auth header config override when a token is available', async () => {
    const { spawnFn, calls } = fakeSpawn(0, 'ok', '');
    const runner = new SpawnGitCommandRunner({
      spawn: spawnFn as never,
      authToken: () => 'secret-token',
    });

    await runner.run(['fetch', 'origin'], { cwd: '/tmp/repo' });

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('git');
    expect(calls[0].args).toEqual([
      '-c',
      'http.extraHeader=Authorization: Basic ' +
        Buffer.from('x-access-token:secret-token').toString('base64'),
      'fetch',
      'origin',
    ]);
    expect((calls[0].options as { env: NodeJS.ProcessEnv }).env?.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('omits the config override entirely when no token is available', async () => {
    const { spawnFn, calls } = fakeSpawn(0, 'ok', '');
    const runner = new SpawnGitCommandRunner({ spawn: spawnFn as never });

    await runner.run(['worktree', 'list'], { cwd: '/tmp/repo' });

    expect(calls[0].args).toEqual(['worktree', 'list']);
  });

  it('resolves with stdout, stderr, and exit code on any exit (never throws itself)', async () => {
    const { spawnFn } = fakeSpawn(1, 'partial output', 'fatal: not a git repository');
    const runner = new SpawnGitCommandRunner({ spawn: spawnFn as never });

    const result = await runner.run(['status'], { cwd: '/tmp/repo' });

    expect(result).toEqual({ stdout: 'partial output', stderr: 'fatal: not a git repository', exitCode: 1 });
  });

  it('runs with the given cwd', async () => {
    const { spawnFn, calls } = fakeSpawn(0, '', '');
    const runner = new SpawnGitCommandRunner({ spawn: spawnFn as never });

    await runner.run(['status'], { cwd: '/tmp/some-repo' });

    expect((calls[0].options as { cwd: string }).cwd).toBe('/tmp/some-repo');
  });

  it('resolves (never hangs, never throws) when the process itself fails to spawn', async () => {
    const spawnFn = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        child.emit('error', new Error('spawn git ENOENT'));
      });
      return child;
    });
    const runner = new SpawnGitCommandRunner({ spawn: spawnFn as never });

    const result = await runner.run(['status'], { cwd: '/does/not/exist' });

    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('spawn git ENOENT');
    expect(result.spawnFailed).toBe(true);
  });

  it('does not set spawnFailed when git itself runs and merely exits non-zero', async () => {
    const { spawnFn } = fakeSpawn(128, '', 'fatal: could not read Username for https://github.com');
    const runner = new SpawnGitCommandRunner({ spawn: spawnFn as never });

    const result = await runner.run(['fetch', 'origin'], { cwd: '/tmp/repo' });

    expect(result.exitCode).toBe(128);
    expect(result.spawnFailed).toBeUndefined();
  });
});
