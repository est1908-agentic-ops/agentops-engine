import fs from 'fs/promises';
import path from 'path';
import { GtdDocument, GtdList, GtdTask } from '@agentops/contracts';
import { parse, serialize } from './markdown-store';

export class GtdStore {
  private filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath || process.env.GTD_FILE || './tasks.md';
  }

  private async loadDocument(): Promise<GtdDocument> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8');
      return parse(content);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return {
          tasks: [],
          preserved: [],
        };
      }
      throw error;
    }
  }

  private async saveDocument(doc: GtdDocument): Promise<void> {
    const content = serialize(doc);
    const dir = path.dirname(this.filePath);
    const tempPath = path.join(dir, `.${path.basename(this.filePath)}.tmp`);

    try {
      await fs.writeFile(tempPath, content, 'utf-8');
      await fs.rename(tempPath, this.filePath);
    } catch (error) {
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  async add(text: string, options?: { list?: GtdList; context?: string; project?: string; due?: string }): Promise<GtdTask> {
    const doc = await this.loadDocument();
    const list = options?.list || 'inbox';

    const task: GtdTask = {
      id: '',
      text,
      list,
      context: options?.context,
      project: options?.project,
      due: options?.due,
      done: false,
    };

    doc.tasks.push(task);
    await this.saveDocument(doc);

    const updatedDoc = await this.loadDocument();
    const addedTask = updatedDoc.tasks.find((t) => t.text === text && t.list === list);
    if (!addedTask) {
      throw new Error('Failed to add task');
    }

    return addedTask;
  }

  async list(filterList?: GtdList): Promise<GtdTask[]> {
    const doc = await this.loadDocument();
    if (filterList) {
      return doc.tasks.filter((t) => t.list === filterList);
    }
    return doc.tasks;
  }

  async move(id: string, list: GtdList): Promise<void> {
    const doc = await this.loadDocument();
    const task = doc.tasks.find((t) => t.id === id);
    if (!task) {
      throw new Error(`Task with id ${id} not found`);
    }
    task.list = list;
    await this.saveDocument(doc);
  }

  async complete(id: string): Promise<void> {
    const doc = await this.loadDocument();
    const task = doc.tasks.find((t) => t.id === id);
    if (!task) {
      throw new Error(`Task with id ${id} not found`);
    }
    task.done = true;
    task.list = 'done';
    await this.saveDocument(doc);
  }
}
