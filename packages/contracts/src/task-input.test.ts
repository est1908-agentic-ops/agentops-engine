import { describe, expect, it } from 'vitest';
import { TaskInputSchema } from './task-input';

const config = {
  fastVerifyCommands: [],
  fullVerifyCommands: [],
  stages: {},
  routing: {},
  brakes: { maxIterations: 6, maxTokens: 200_000, maxBabysitRounds: 5 },
};

describe('TaskInputSchema', () => {
  it('parses a task with an issueRef', () => {
    const parsed = TaskInputSchema.parse({
      taskId: 'task-1',
      project: 'demo',
      repo: 'demo/repo',
      issueRef: 'issue-42',
      goal: 'Add a widget',
      config,
    });
    expect(parsed.issueRef).toBe('issue-42');
  });

  it('allows issueRef to be omitted for ad-hoc goal-driven tasks', () => {
    const parsed = TaskInputSchema.parse({
      taskId: 'task-2',
      project: 'demo',
      repo: 'demo/repo',
      goal: 'Localize strings',
      config,
    });
    expect(parsed.issueRef).toBeUndefined();
  });

  it('accepts an input with no config (prompt-started run)', () => {
    const parsed = TaskInputSchema.parse({
      taskId: 't-1',
      project: 'demo',
      repo: 'demo/repo',
      goal: 'Add a widget',
    });
    expect(parsed.config).toBeUndefined();
  });
});
