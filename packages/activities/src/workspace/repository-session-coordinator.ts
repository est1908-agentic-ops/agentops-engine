import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { WorkspaceError } from './workspace-error';

export interface RepositorySessionLockOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RepositorySessionCoordinator {
  withLock<T>(
    key: string,
    operation: (signal?: AbortSignal) => Promise<T>,
    options?: RepositorySessionLockOptions,
  ): Promise<T>;
}

export const DEFAULT_REPOSITORY_SESSION_LOCK_TIMEOUT_MS = 25 * 60 * 1000;

const ACQUIRED_SENTINEL = 'AGENTOPS_REPOSITORY_SESSION_LOCK_ACQUIRED\n';
// This program contains no caller-provided input. flock execs it only once the
// kernel lock has been acquired; stdin closing (including worker death) releases
// the lock by making the helper exit.
const HOLD_LOCK_HELPER =
  "process.stdout.write('AGENTOPS_REPOSITORY_SESSION_LOCK_ACQUIRED\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));";
const localRepositorySessionLockTails = new Map<string, Promise<void>>();

export function repositorySessionFlockArgs(lockPath: string, timeoutMs: number): string[] {
  return [
    '--exclusive',
    '--timeout',
    String(Math.max(0.001, timeoutMs / 1000)),
    lockPath,
    process.execPath,
    '-e',
    HOLD_LOCK_HELPER,
  ];
}

export class LocalRepositorySessionCoordinator implements RepositorySessionCoordinator {
  constructor(private readonly tails = localRepositorySessionLockTails) {}

  async withLock<T>(
    key: string,
    operation: (signal?: AbortSignal) => Promise<T>,
    options: RepositorySessionLockOptions = {},
  ): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = previous.catch(() => {}).then(() => gate);
    this.tails.set(key, tail);
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    try {
      await this.waitFor(previous, options);
      return await operation(options.signal);
    } finally {
      release();
    }
  }

  private waitFor(waiter: Promise<void>, options: RepositorySessionLockOptions): Promise<void> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_REPOSITORY_SESSION_LOCK_TIMEOUT_MS;
    if (options.signal?.aborted)
      return Promise.reject(new WorkspaceError('repository session lock acquisition cancelled'));
    return new Promise((resolveWait, rejectWait) => {
      const timeout = setTimeout(
        () => finish(new WorkspaceError('repository session lock acquisition timed out')),
        timeoutMs,
      );
      const onAbort = () =>
        finish(new WorkspaceError('repository session lock acquisition cancelled'));
      const finish = (error?: WorkspaceError) => {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', onAbort);
        if (error) rejectWait(error);
        else resolveWait();
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      void waiter.then(
        () => finish(),
        () => finish(),
      );
    });
  }
}

export class FlockRepositorySessionCoordinator implements RepositorySessionCoordinator {
  constructor(
    private readonly flockPath = '/usr/bin/flock',
    private readonly defaultTimeoutMs = DEFAULT_REPOSITORY_SESSION_LOCK_TIMEOUT_MS,
  ) {}

  async withLock<T>(
    lockPath: string,
    operation: (signal?: AbortSignal) => Promise<T>,
    options: RepositorySessionLockOptions = {},
  ): Promise<T> {
    await this.ensureStableLockFile(lockPath);
    const child = await this.acquire(
      lockPath,
      options.timeoutMs ?? this.defaultTimeoutMs,
      options.signal,
    );
    try {
      // Once acquired, cancellation is deliberately only propagated to the
      // operation. Releasing here would let a clone that ignores cancellation
      // continue without its kernel lock.
      return await operation(options.signal);
    } finally {
      const exited =
        child.exitCode !== null
          ? Promise.resolve()
          : new Promise<void>((resolveChild) => child.once('exit', () => resolveChild()));
      child.stdin?.end();
      await exited;
    }
  }

  private async ensureStableLockFile(lockPath: string): Promise<void> {
    const parent = dirname(lockPath);
    await mkdir(parent, { recursive: true });
    const parentEntry = await lstat(parent);
    if (parentEntry.isSymbolicLink() || !parentEntry.isDirectory()) {
      throw new WorkspaceError('repository session lock parent is not a real directory', true);
    }
    let handle;
    try {
      handle = await open(
        lockPath,
        constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      const entry = await handle.stat();
      if (!entry.isFile())
        throw new WorkspaceError('repository session lock is not a regular file', true);
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError('repository session lock is not a regular non-symlink file', true);
    } finally {
      await handle?.close();
    }
  }

  private acquire(
    lockPath: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ChildProcess> {
    if (signal?.aborted)
      return Promise.reject(new WorkspaceError('repository session lock acquisition cancelled'));
    return new Promise((resolveAcquire, rejectAcquire) => {
      const child = spawn(
        this.flockPath,
        repositorySessionFlockArgs(resolve(lockPath), timeoutMs),
        {
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let settled = false;
      const fail = (message: string, nonRetryable = false) => {
        if (settled) return;
        settled = true;
        child.kill();
        rejectAcquire(new WorkspaceError(message, nonRetryable));
      };
      const onAbort = () => fail('repository session lock acquisition cancelled');
      signal?.addEventListener('abort', onAbort, { once: true });
      child.once('error', () =>
        fail(`repository session flock executable is unavailable: ${this.flockPath}`, true),
      );
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout === ACQUIRED_SENTINEL && !settled) {
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          resolveAcquire(child);
        } else if (!ACQUIRED_SENTINEL.startsWith(stdout)) {
          fail('repository session flock helper produced an invalid protocol response', true);
        }
      });
      child.once('exit', (code) => {
        if (!settled) {
          signal?.removeEventListener('abort', onAbort);
          fail(
            code === 1
              ? 'repository session lock acquisition timed out'
              : 'repository session flock exited before acquisition',
          );
        }
      });
    });
  }
}
