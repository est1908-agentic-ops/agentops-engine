import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { SpawnCommandRunner, INIT_COMMAND_ENV_ALLOWLIST } from './spawn-command-runner';

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
  const originalEnv = { ...process.env };
  afterEach(() => {
    Object.assign(process.env, originalEnv);
  });

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

  it('scrubs the environment to exclude secrets and only include allowlisted vars', async () => {
    const { spawnFn, calls } = fakeSpawn(0, '', '');
    process.env.GITHUB_TOKEN = 'secret-should-not-leak';
    process.env.PATH = '/usr/bin:/bin';
    const runner = new SpawnCommandRunner({ spawn: spawnFn as never });

    await runner.run('echo test', { cwd: '/tmp/workspace' });

    const spawnedEnv = calls[0].options as { env: Record<string, string> };
    expect(spawnedEnv.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(spawnedEnv.env.PATH).toBe('/usr/bin:/bin');
    expect(Object.keys(spawnedEnv.env).every((key) => INIT_COMMAND_ENV_ALLOWLIST.includes(key))).toBe(true);
  });

  it('does not pass process.env by reference; uses a fresh object', async () => {
    const { spawnFn, calls } = fakeSpawn(0, '', '');
    process.env.PATH = '/usr/bin';
    const runner = new SpawnCommandRunner({ spawn: spawnFn as never });

    await runner.run('echo test', { cwd: '/tmp/workspace' });

    const spawnedEnv = calls[0].options as { env: Record<string, string> };
    expect(spawnedEnv.env).not.toBe(process.env);
  });

  it('respects the envAllowlist override in constructor', async () => {
    const { spawnFn, calls } = fakeSpawn(0, '', '');
    process.env.PATH = '/usr/bin';
    process.env.HOME = '/home/user';
    const runner = new SpawnCommandRunner({ spawn: spawnFn as never, envAllowlist: ['PATH'] });

    await runner.run('echo test', { cwd: '/tmp/workspace' });

    const spawnedEnv = calls[0].options as { env: Record<string, string> };
    expect(spawnedEnv.env).toHaveProperty('PATH');
    expect(spawnedEnv.env).not.toHaveProperty('HOME');
  });

  it('skips undefined allowlisted vars so the child does not get empty overrides', async () => {
    const { spawnFn, calls } = fakeSpawn(0, '', '');
    delete process.env.TZ;
    const runner = new SpawnCommandRunner({ spawn: spawnFn as never });

    await runner.run('echo test', { cwd: '/tmp/workspace' });

    const spawnedEnv = calls[0].options as { env: Record<string, string> };
    expect(spawnedEnv.env).not.toHaveProperty('TZ');
  });
});
