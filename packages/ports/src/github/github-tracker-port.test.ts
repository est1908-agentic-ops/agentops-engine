import { describe, expect, it, vi } from 'vitest';
import type { GithubClient } from './github-client';
import { GithubTrackerPort } from './github-tracker-port';

function fakeClient(overrides: Partial<GithubClient['rest']> = {}): GithubClient {
  return {
    rest: {
      issues: {
        get: vi.fn(),
        createComment: vi.fn(),
        addLabels: vi.fn(),
        removeLabel: vi.fn(),
        create: vi.fn(),
        ...overrides.issues,
      },
      pulls: { create: vi.fn(), get: vi.fn(), ...overrides.pulls },
      repos: { get: vi.fn(), getContent: vi.fn(), ...overrides.repos },
      checks: { listForRef: vi.fn(), ...overrides.checks },
    },
    graphql: vi.fn(),
  } as unknown as GithubClient;
}

describe('GithubTrackerPort', () => {
  it('getIssue fetches and maps to the Issue shape', async () => {
    const client = fakeClient({
      issues: {
        get: vi.fn().mockResolvedValue({
          data: { title: 'Bug', body: 'It is broken', labels: ['bug', { name: 'p1' }] },
        }),
      } as never,
    });
    const tracker = new GithubTrackerPort(client);

    const issue = await tracker.getIssue('octocat/hello-world#42');

    expect(issue).toEqual({ ref: 'octocat/hello-world#42', title: 'Bug', body: 'It is broken', labels: ['bug', 'p1'] });
    expect(client.rest.issues.get).toHaveBeenCalledWith({ owner: 'octocat', repo: 'hello-world', issue_number: 42 });
  });

  it('getIssue defaults a null body to an empty string', async () => {
    const client = fakeClient({
      issues: { get: vi.fn().mockResolvedValue({ data: { title: 'T', body: null, labels: [] } }) } as never,
    });
    const tracker = new GithubTrackerPort(client);

    const issue = await tracker.getIssue('o/r#1');

    expect(issue.body).toBe('');
  });

  it('comment posts to the issue comments endpoint', async () => {
    const client = fakeClient();
    const tracker = new GithubTrackerPort(client);

    await tracker.comment('octocat/hello-world#42', 'hello');

    expect(client.rest.issues.createComment).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'hello-world',
      issue_number: 42,
      body: 'hello',
    });
  });

  it('label adds the label', async () => {
    const client = fakeClient();
    const tracker = new GithubTrackerPort(client);

    await tracker.label('octocat/hello-world#42', 'bug');

    expect(client.rest.issues.addLabels).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'hello-world',
      issue_number: 42,
      labels: ['bug'],
    });
  });

  it('throws a clear error on a malformed ref before ever calling the client', async () => {
    const client = fakeClient();
    const tracker = new GithubTrackerPort(client);

    await expect(tracker.getIssue('not-a-ref')).rejects.toThrow(/expected "owner\/repo#number"/);
    expect(client.rest.issues.get).not.toHaveBeenCalled();
  });

  it('removeLabel calls issues.removeLabel with owner/repo/number/name', async () => {
    const removeLabel = vi.fn().mockResolvedValue({});
    const client = fakeClient({ issues: { removeLabel } as never });
    const port = new GithubTrackerPort(client);
    await port.removeLabel('o/r#7', 'agent:working');
    expect(removeLabel).toHaveBeenCalledWith({ owner: 'o', repo: 'r', issue_number: 7, name: 'agent:working' });
  });

  it('createIssue calls issues.create and returns owner/repo#number + html_url', async () => {
    const create = vi.fn().mockResolvedValue({ data: { number: 7, html_url: 'https://x/7' } });
    const client = fakeClient({ issues: { create } as never });
    const port = new GithubTrackerPort(client);
    const res = await port.createIssue({ repo: 'o/r', title: 'T', body: 'B', labels: ['bug'] });
    expect(create).toHaveBeenCalledWith({ owner: 'o', repo: 'r', title: 'T', body: 'B', labels: ['bug'] });
    expect(res).toEqual({ ref: 'o/r#7', url: 'https://x/7' });
  });
});
