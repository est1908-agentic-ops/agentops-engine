import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { handleAdd, handleList, handleMove, handleDone } from './main';

describe('GTD CLI', () => {
  let tempDir: string;
  let filePath: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtd-cli-test-'));
    filePath = path.join(tempDir, 'tasks.md');
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleSpy.mockRestore();
    try {
      await fs.rm(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('add command', () => {
    it('adds a task with just text', async () => {
      await handleAdd(['Buy milk'], filePath);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Added: Buy milk'));
    });

    it('adds a task with --list option', async () => {
      await handleAdd(['Buy milk', '--list', 'next'], filePath);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Added: Buy milk'));

      await handleList(['--list', 'next'], filePath);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Buy milk'));
    });

    it('adds a task with all metadata', async () => {
      await handleAdd(
        ['Ship release', '--list', 'next', '--context', '@laptop', '--project', '+release', '--due', '2026-07-20'],
        filePath,
      );
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Added: Ship release'));

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toContain('@laptop');
      expect(content).toContain('+release');
      expect(content).toContain('!2026-07-20');
    });

    it('rejects invalid --list value', async () => {
      await expect(handleAdd(['Buy milk', '--list', 'bogus'], filePath)).rejects.toThrow();
    });

    it('requires text', async () => {
      await expect(handleAdd([], filePath)).rejects.toThrow();
    });
  });

  describe('list command', () => {
    it('lists all tasks', async () => {
      await handleAdd(['Task 1'], filePath);
      await handleAdd(['Task 2', '--list', 'next'], filePath);

      consoleSpy.mockClear();
      await handleList([], filePath);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Task 1'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Task 2'));
    });

    it('filters by list', async () => {
      await handleAdd(['Task 1'], filePath);
      await handleAdd(['Task 2', '--list', 'next'], filePath);

      consoleSpy.mockClear();
      await handleList(['--list', 'next'], filePath);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Task 2'));
    });

    it('shows [x] for completed tasks', async () => {
      const store = await import('./gtd-store').then((m) => new m.GtdStore(filePath));
      const task = await store.add('Buy milk');
      await store.complete(task.id);

      consoleSpy.mockClear();
      await handleList([], filePath);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[x]'));
    });

    it('shows no tasks message when empty', async () => {
      consoleSpy.mockClear();
      await handleList([], filePath);

      expect(consoleSpy).toHaveBeenCalledWith('No tasks');
    });

    it('rejects invalid --list value', async () => {
      await expect(handleList(['--list', 'bogus'], filePath)).rejects.toThrow();
    });
  });

  describe('move command', () => {
    it('moves a task to a different list', async () => {
      await handleAdd(['Task 1'], filePath);

      const store = await import('./gtd-store').then((m) => new m.GtdStore(filePath));
      const tasks = await store.list();
      const id = tasks[0].id;

      consoleSpy.mockClear();
      await handleMove([id, 'next'], filePath);
      expect(consoleSpy).toHaveBeenCalledWith(`Moved task ${id} to next`);

      const updated = await store.list('next');
      expect(updated).toHaveLength(1);
      expect(updated[0].text).toBe('Task 1');
    });

    it('rejects invalid list', async () => {
      await expect(handleMove(['id', 'bogus'], filePath)).rejects.toThrow();
    });

    it('requires both arguments', async () => {
      await expect(handleMove(['id'], filePath)).rejects.toThrow();
      await expect(handleMove([], filePath)).rejects.toThrow();
    });
  });

  describe('done command', () => {
    it('marks a task as done', async () => {
      await handleAdd(['Task 1'], filePath);

      const store = await import('./gtd-store').then((m) => new m.GtdStore(filePath));
      const tasks = await store.list();
      const id = tasks[0].id;

      consoleSpy.mockClear();
      await handleDone([id], filePath);
      expect(consoleSpy).toHaveBeenCalledWith(`Completed task ${id}`);

      const done = await store.list('done');
      expect(done).toHaveLength(1);
      expect(done[0].done).toBe(true);
    });

    it('requires an id', async () => {
      await expect(handleDone([], filePath)).rejects.toThrow();
    });
  });
});
