import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { GtdStore } from './gtd-store';

describe('GtdStore', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gtd-test-'));
    filePath = path.join(tempDir, 'tasks.md');
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('adds a task to a new file', async () => {
    const store = new GtdStore(filePath);
    const task = await store.add('Buy milk');

    expect(task).toMatchObject({
      text: 'Buy milk',
      list: 'inbox',
      done: false,
    });
    expect(task.id).toBeTruthy();

    const exists = await fs.access(filePath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it('lists all tasks', async () => {
    const store = new GtdStore(filePath);
    await store.add('Task 1');
    await store.add('Task 2', { list: 'next' });

    const tasks = await store.list();
    expect(tasks).toHaveLength(2);
    expect(tasks[0].text).toBe('Task 1');
    expect(tasks[1].text).toBe('Task 2');
  });

  it('filters tasks by list', async () => {
    const store = new GtdStore(filePath);
    await store.add('Task 1', { list: 'inbox' });
    await store.add('Task 2', { list: 'next' });

    const inboxTasks = await store.list('inbox');
    expect(inboxTasks).toHaveLength(1);
    expect(inboxTasks[0].text).toBe('Task 1');
  });

  it('moves a task to a different list', async () => {
    const store = new GtdStore(filePath);
    const task = await store.add('Task 1');

    await store.move(task.id, 'next');

    const tasks = await store.list();
    const moved = tasks.find((t) => t.text === 'Task 1');
    expect(moved?.list).toBe('next');
  });

  it('completes a task', async () => {
    const store = new GtdStore(filePath);
    const task = await store.add('Task 1');

    await store.complete(task.id);

    const tasks = await store.list();
    const completed = tasks.find((t) => t.text === 'Task 1');
    expect(completed?.done).toBe(true);
    expect(completed?.list).toBe('done');
  });

  it('preserves unknown sections through add', async () => {
    const store = new GtdStore(filePath);
    await store.add('Task 1');

    const content = await fs.readFile(filePath, 'utf-8');
    const updated = content.replace('## Done', '## Done\n\n## Projects\n- Custom project notes');
    await fs.writeFile(filePath, updated, 'utf-8');

    await store.add('Task 2');

    const finalContent = await fs.readFile(filePath, 'utf-8');
    expect(finalContent).toContain('## Projects');
    expect(finalContent).toContain('Custom project notes');
  });

  it('does not leave a temp file after write', async () => {
    const store = new GtdStore(filePath);
    await store.add('Task 1');

    const files = await fs.readdir(tempDir);
    expect(files).toEqual(['tasks.md']);
  });

  it('throws when moving a non-existent task', async () => {
    const store = new GtdStore(filePath);
    await expect(store.move('nonexistent', 'done')).rejects.toThrow();
  });

  it('throws when completing a non-existent task', async () => {
    const store = new GtdStore(filePath);
    await expect(store.complete('nonexistent')).rejects.toThrow();
  });

  it('handles metadata when adding tasks', async () => {
    const store = new GtdStore(filePath);
    const task = await store.add('Ship release', {
      list: 'next',
      context: '@laptop',
      project: '+release',
      due: '2026-07-20',
    });

    expect(task).toMatchObject({
      text: 'Ship release',
      context: '@laptop',
      project: '+release',
      due: '2026-07-20',
    });

    const content = await fs.readFile(filePath, 'utf-8');
    expect(content).toContain('@laptop');
    expect(content).toContain('+release');
    expect(content).toContain('!2026-07-20');
  });
});
