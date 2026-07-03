import { describe, expect, it } from 'vitest';
import { MemoryTrackerPort } from './memory-tracker';

describe('MemoryTrackerPort', () => {
  it('returns a seeded issue by ref', async () => {
    const tracker = new MemoryTrackerPort();
    tracker.seedIssue({ ref: 'issue-1', title: 'Bug', body: 'It breaks', labels: ['bug'] });
    await expect(tracker.getIssue('issue-1')).resolves.toEqual({
      ref: 'issue-1',
      title: 'Bug',
      body: 'It breaks',
      labels: ['bug'],
    });
  });

  it('throws for an unknown issue ref', async () => {
    const tracker = new MemoryTrackerPort();
    await expect(tracker.getIssue('missing')).rejects.toThrow();
  });

  it('records comments in order and exposes them for assertions', async () => {
    const tracker = new MemoryTrackerPort();
    await tracker.comment('issue-1', 'first');
    await tracker.comment('issue-1', 'second');
    expect(tracker.getComments('issue-1')).toEqual(['first', 'second']);
  });

  it('records labels without duplicates', async () => {
    const tracker = new MemoryTrackerPort();
    await tracker.label('issue-1', 'needs-triage');
    await tracker.label('issue-1', 'needs-triage');
    expect(tracker.getLabels('issue-1')).toEqual(['needs-triage']);
  });
});
