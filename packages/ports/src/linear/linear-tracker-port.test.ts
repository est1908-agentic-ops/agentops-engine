import { describe, expect, it, vi } from 'vitest';
import type { LinearClient, LinearIssueData } from './linear-client';
import { LinearTrackerPort } from './linear-tracker-port';

function fakeClient(overrides: Partial<LinearClient> = {}): LinearClient {
  return {
    getIssue: vi.fn(),
    createComment: vi.fn(),
    findLabelId: vi.fn(),
    setLabelIds: vi.fn(),
    ...overrides,
  };
}

const issue: LinearIssueData = {
  id: 'issue-uuid',
  identifier: 'ENG-123',
  title: 'Fix the thing',
  description: 'body text',
  labelIds: ['existing-label-uuid'],
  labelNames: ['bug'],
};

describe('LinearTrackerPort', () => {
  it('rejects a non-linear ref', async () => {
    const port = new LinearTrackerPort(fakeClient());
    await expect(port.getIssue('octocat/hello-world#1')).rejects.toThrow(
      /expected a "linear:" ref/,
    );
  });

  it('getIssue maps a linear ref to an Issue', async () => {
    const client = fakeClient({ getIssue: vi.fn().mockResolvedValue(issue) });
    const port = new LinearTrackerPort(client);

    const result = await port.getIssue('linear:ENG-123');

    expect(client.getIssue).toHaveBeenCalledWith('ENG-123');
    expect(result).toEqual({
      ref: 'linear:ENG-123',
      title: 'Fix the thing',
      body: 'body text',
      labels: ['bug'],
    });
  });

  it('comment resolves the issue id and posts through the client', async () => {
    const client = fakeClient({ getIssue: vi.fn().mockResolvedValue(issue) });
    const port = new LinearTrackerPort(client);

    await port.comment('linear:ENG-123', 'PR opened');

    expect(client.createComment).toHaveBeenCalledWith('issue-uuid', 'PR opened');
  });

  it('label merges the resolved label id into the existing set', async () => {
    const client = fakeClient({
      getIssue: vi.fn().mockResolvedValue(issue),
      findLabelId: vi.fn().mockResolvedValue('agentops-label-uuid'),
    });
    const port = new LinearTrackerPort(client);

    await port.label('linear:ENG-123', 'agentops');

    expect(client.findLabelId).toHaveBeenCalledWith('ENG', 'agentops');
    expect(client.setLabelIds).toHaveBeenCalledWith('issue-uuid', [
      'existing-label-uuid',
      'agentops-label-uuid',
    ]);
  });

  it('label is a no-op when the issue already carries the label', async () => {
    const client = fakeClient({
      getIssue: vi.fn().mockResolvedValue(issue),
      findLabelId: vi.fn().mockResolvedValue('existing-label-uuid'),
    });
    const port = new LinearTrackerPort(client);

    await port.label('linear:ENG-123', 'bug');

    expect(client.setLabelIds).not.toHaveBeenCalled();
  });

  it('label throws when the named label does not exist for the team', async () => {
    const client = fakeClient({
      getIssue: vi.fn().mockResolvedValue(issue),
      findLabelId: vi.fn().mockResolvedValue(null),
    });
    const port = new LinearTrackerPort(client);

    await expect(port.label('linear:ENG-123', 'missing')).rejects.toThrow(
      /no label named "missing"/,
    );
  });
});
