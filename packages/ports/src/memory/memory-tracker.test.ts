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

  it('removeLabel drops a label; getLabels reflects it', async () => {
    const t = new MemoryTrackerPort();
    await t.label('o/r#1', 'agent:working');
    await t.removeLabel('o/r#1', 'agent:working');
    expect(t.getLabels('o/r#1')).not.toContain('agent:working');
  });

  it('removeLabel on a missing label is a no-op', async () => {
    const t = new MemoryTrackerPort();
    await expect(t.removeLabel('o/r#1', 'nope')).resolves.toBeUndefined();
  });

  it('createIssue stores the issue and returns a ref retrievable via getIssue', async () => {
    const t = new MemoryTrackerPort();
    const created = await t.createIssue({ repo: 'o/r', title: 'Bug', body: 'b', labels: ['bug'] });
    expect(created.ref).toMatch(/^o\/r#\d+$/);
    const issue = await t.getIssue(created.ref);
    expect(issue).toMatchObject({ title: 'Bug', labels: ['bug'] });
  });
});
