import { describe, expect, it } from 'vitest';
import { GtdListSchema, GtdTaskSchema, GtdDocumentSchema } from './gtd-task';

describe('GtdListSchema', () => {
  it('accepts all valid GTD lists', () => {
    for (const list of ['inbox', 'next', 'waiting', 'someday', 'done']) {
      expect(GtdListSchema.parse(list)).toBe(list);
    }
  });

  it('rejects invalid list names', () => {
    expect(() => GtdListSchema.parse('bogus')).toThrow();
  });
});

describe('GtdTaskSchema', () => {
  it('accepts a valid task', () => {
    const task = {
      id: 'abc123',
      text: 'Buy milk',
      list: 'inbox',
      done: false,
    };
    expect(GtdTaskSchema.parse(task)).toEqual(task);
  });

  it('accepts a task with all optional fields', () => {
    const task = {
      id: 'k2p9',
      text: 'Ship the release @laptop +release !2026-07-20',
      list: 'next',
      context: '@laptop',
      project: '+release',
      due: '2026-07-20',
      done: false,
    };
    expect(GtdTaskSchema.parse(task)).toEqual(task);
  });

  it('rejects a task with an invalid due date', () => {
    const task = {
      id: 'x',
      text: 'Task',
      list: 'inbox',
      due: '2026-13-40',
      done: false,
    };
    expect(() => GtdTaskSchema.parse(task)).toThrow();
  });

  it('rejects a task with a non-date due value', () => {
    const task = {
      id: 'x',
      text: 'Task',
      list: 'inbox',
      due: 'not-a-date',
      done: false,
    };
    expect(() => GtdTaskSchema.parse(task)).toThrow();
  });

  it('rejects a task without an id', () => {
    const task = {
      text: 'Task',
      list: 'inbox',
      done: false,
    };
    expect(() => GtdTaskSchema.parse(task)).toThrow();
  });

  it('rejects a task with an invalid list', () => {
    const task = {
      id: 'x',
      text: 'Task',
      list: 'bogus',
      done: false,
    };
    expect(() => GtdTaskSchema.parse(task)).toThrow();
  });
});

describe('GtdDocumentSchema', () => {
  it('accepts a document with tasks and preserved blocks', () => {
    const doc = {
      tasks: [
        {
          id: 'a1b2',
          text: 'Buy milk',
          list: 'inbox',
          done: false,
        },
        {
          id: 'c3d4',
          text: 'Ship release',
          list: 'next',
          context: '@laptop',
          done: false,
        },
      ],
      preserved: [
        {
          content: '## Custom section\n\nSome notes',
          position: 'trailing',
        },
      ],
    };
    expect(GtdDocumentSchema.parse(doc)).toEqual(doc);
  });

  it('accepts an empty document', () => {
    const doc = {
      tasks: [],
      preserved: [],
    };
    expect(GtdDocumentSchema.parse(doc)).toEqual(doc);
  });
});
