import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FlockRepositorySessionCoordinator,
  LocalRepositorySessionCoordinator,
  repositorySessionFlockArgs,
} from './repository-session-coordinator';

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'agentops-session-lock-'));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('LocalRepositorySessionCoordinator', () => {
  it('shares its default keyed state across independent coordinator instances', async () => {
    const first = new LocalRepositorySessionCoordinator();
    const second = new LocalRepositorySessionCoordinator();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstEntered!: () => void;
    const enteredFirst = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let entered = 0;
    const one = first.withLock('default-state', async () => {
      entered++;
      firstEntered();
      await held;
    });
    await enteredFirst;
    const two = second.withLock('default-state', async () => {
      entered++;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(entered).toBe(1);
    release();
    await Promise.all([one, two]);
  });

  it('serializes independent coordinators sharing the same local state', async () => {
    const state = new Map<string, Promise<void>>();
    const first = new LocalRepositorySessionCoordinator(state);
    const second = new LocalRepositorySessionCoordinator(state);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const one = first.withLock('same', async () => {
      entered++;
      await held;
    });
    await Promise.resolve();
    const two = second.withLock('same', async () => {
      entered++;
    });
    await Promise.resolve();
    expect(entered).toBe(1);
    release();
    await Promise.all([one, two]);
    expect(entered).toBe(2);
  });

  it('abandons an aborted waiter without admitting it after the holder releases', async () => {
    const coordinator = new LocalRepositorySessionCoordinator();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const holderEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let waiterRan = false;
    const holder = coordinator.withLock('same', async () => {
      entered();
      await held;
    });
    await holderEntered;
    const controller = new AbortController();
    const waiter = coordinator.withLock(
      'same',
      async () => {
        waiterRan = true;
      },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(waiter).rejects.toMatchObject({ nonRetryable: false });
    release();
    await holder;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(waiterRan).toBe(false);
  });
});

describe('FlockRepositorySessionCoordinator', () => {
  it('waits for an operation to settle after unexpected helper loss', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      kill: () => true,
    });
    const coordinator = new FlockRepositorySessionCoordinator(
      '/fake/flock',
      1_000,
      () => child as never,
    );
    let release!: () => void;
    const delayedOperation = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const operationEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let observedLoss = false;
    let settled = false;
    const held = coordinator
      .withLock(join(root(), 'lock'), async (signal) => {
        signal?.addEventListener('abort', () => {
          observedLoss = true;
        });
        entered();
        await delayedOperation;
      })
      .finally(() => {
        settled = true;
      });
    process.nextTick(() => child.stdout.write('AGENTOPS_REPOSITORY_SESSION_LOCK_ACQUIRED\n'));
    await operationEntered;
    child.exitCode = 1;
    child.emit('exit', 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(observedLoss).toBe(true);
    expect(settled).toBe(false);
    release();
    await expect(held).rejects.toMatchObject({
      nonRetryable: false,
      message: expect.stringContaining('lost'),
    });
  });

  it('uses a fixed child protocol after flock acquires the stable lock file', () => {
    expect(repositorySessionFlockArgs('/locks/a.lock', 1_500)).toEqual([
      '--exclusive',
      '--timeout',
      '1.5',
      '/locks/a.lock',
      process.execPath,
      '-e',
      expect.stringContaining('AGENTOPS_REPOSITORY_SESSION_LOCK_ACQUIRED'),
    ]);
  });

  it('rejects a symlink lock path and never removes a regular lock file', async () => {
    const directory = root();
    const target = join(directory, 'target');
    const lock = join(directory, 'lock');
    symlinkSync(target, lock);
    const coordinator = new FlockRepositorySessionCoordinator();
    await expect(coordinator.withLock(lock, async () => undefined)).rejects.toMatchObject({
      nonRetryable: true,
    });
    expect(lstatSync(lock).isSymbolicLink()).toBe(true);
  });

  it('rejects a non-regular lock path', async () => {
    const lock = join(root(), 'lock');
    mkdirSync(lock);
    await expect(
      new FlockRepositorySessionCoordinator().withLock(lock, async () => undefined),
    ).rejects.toMatchObject({
      nonRetryable: true,
    });
    expect(lstatSync(lock).isDirectory()).toBe(true);
  });

  it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/flock'))(
    'serializes independent coordinators and abandons an aborted waiter',
    async () => {
      const lock = join(root(), 'locks', 'session.lock');
      const first = new FlockRepositorySessionCoordinator();
      const second = new FlockRepositorySessionCoordinator();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let firstEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        firstEntered = resolve;
      });
      let secondEntered = false;
      const holder = first.withLock(lock, async () => {
        firstEntered();
        await held;
      });
      await entered;
      const controller = new AbortController();
      const waiter = second.withLock(
        lock,
        async () => {
          secondEntered = true;
        },
        { signal: controller.signal },
      );
      controller.abort();
      await expect(waiter).rejects.toMatchObject({ nonRetryable: false });
      release();
      await holder;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(secondEntered).toBe(false);
      expect(lstatSync(lock).isFile()).toBe(true);
    },
  );

  it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/flock'))(
    'hands the unchanged stable file to a successor after release',
    async () => {
      const lock = join(root(), 'locks', 'session.lock');
      const first = new FlockRepositorySessionCoordinator();
      const second = new FlockRepositorySessionCoordinator();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const firstEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const holder = first.withLock(lock, async () => {
        entered();
        await held;
      });
      await firstEntered;
      const successor = second.withLock(lock, async () => undefined);
      release();
      await Promise.all([holder, successor]);
      expect(lstatSync(lock).isFile()).toBe(true);
    },
  );

  it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/flock'))(
    'keeps flock held when an acquired operation ignores cancellation',
    async () => {
      const lock = join(root(), 'locks', 'session.lock');
      const holderCoordinator = new FlockRepositorySessionCoordinator();
      const successorCoordinator = new FlockRepositorySessionCoordinator();
      const controller = new AbortController();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const acquired = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let successorEntered = false;
      const holder = holderCoordinator.withLock(
        lock,
        async () => {
          entered();
          await held;
        },
        { signal: controller.signal },
      );
      await acquired;
      const successor = successorCoordinator.withLock(lock, async () => {
        successorEntered = true;
      });
      controller.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(successorEntered).toBe(false);
      release();
      await Promise.all([holder, successor]);
      expect(successorEntered).toBe(true);
      expect(lstatSync(lock).isFile()).toBe(true);
    },
  );
});
