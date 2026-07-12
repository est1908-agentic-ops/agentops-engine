import { describe, expect, it, vi } from 'vitest';
import type { GitCommandRunner } from '../git/git-command-runner';
import type { GithubClient } from './github-client';
import { GithubScmPort } from './github-scm-port';

function fakeClient(): GithubClient {
  return {
    rest: {
      issues: { get: vi.fn(), createComment: vi.fn(), addLabels: vi.fn() },
      pulls: { create: vi.fn(), get: vi.fn(), list: vi.fn() },
      repos: { get: vi.fn(), getContent: vi.fn() },
      checks: { listForRef: vi.fn() },
    },
    graphql: vi.fn(),
  } as unknown as GithubClient;
}

function fakeGit(): { git: GitCommandRunner; calls: Array<{ args: string[]; cwd: string }> } {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  return {
    git: {
      run: vi.fn(async (args: string[], opts: { cwd: string }) => {
        calls.push({ args, cwd: opts.cwd });
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    },
    calls,
  };
}

describe('GithubScmPort — openPr', () => {
  it('fetches the default branch and opens a PR against it', async () => {
    const client = fakeClient();
    (client.rest.repos.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { default_branch: 'main' } });
    (client.rest.pulls.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { number: 7, html_url: 'https://github.com/octocat/hello-world/pull/7' },
    });
    const { git } = fakeGit();
    const scm = new GithubScmPort(client, git);

    const result = await scm.openPr({ repo: 'octocat/hello-world', branch: 'agentops/t1', title: 'T', body: 'B' });

    expect(client.rest.repos.get).toHaveBeenCalledWith({ owner: 'octocat', repo: 'hello-world' });
    expect(client.rest.pulls.create).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'hello-world',
      head: 'agentops/t1',
      base: 'main',
      title: 'T',
      body: 'B',
    });
    expect(result).toEqual({ prRef: 'octocat/hello-world#7', url: 'https://github.com/octocat/hello-world/pull/7' });
  });

  it('reuses the existing open PR when create 422s because one already exists for the branch (idempotent retry)', async () => {
    const client = fakeClient();
    (client.rest.repos.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { default_branch: 'main' } });
    (client.rest.pulls.create as ReturnType<typeof vi.fn>).mockRejectedValue({
      status: 422,
      message: 'A pull request already exists for octocat:agentops/t1.',
    });
    (client.rest.pulls.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ number: 7, html_url: 'https://github.com/octocat/hello-world/pull/7' }],
    });
    const { git } = fakeGit();
    const scm = new GithubScmPort(client, git);

    const result = await scm.openPr({ repo: 'octocat/hello-world', branch: 'agentops/t1', title: 'T', body: 'B' });

    expect(client.rest.pulls.list).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'hello-world',
      head: 'octocat:agentops/t1',
      state: 'open',
    });
    expect(result).toEqual({ prRef: 'octocat/hello-world#7', url: 'https://github.com/octocat/hello-world/pull/7' });
  });

  it('rethrows the 422 if create conflicts but no matching open PR is found', async () => {
    const client = fakeClient();
    (client.rest.repos.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { default_branch: 'main' } });
    const conflict = { status: 422, message: 'Validation failed' };
    (client.rest.pulls.create as ReturnType<typeof vi.fn>).mockRejectedValue(conflict);
    (client.rest.pulls.list as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [] });
    const { git } = fakeGit();
    const scm = new GithubScmPort(client, git);

    await expect(
      scm.openPr({ repo: 'octocat/hello-world', branch: 'agentops/t1', title: 'T', body: 'B' }),
    ).rejects.toBe(conflict);
  });

  it('rethrows non-422 errors from create without attempting a PR lookup', async () => {
    const client = fakeClient();
    (client.rest.repos.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { default_branch: 'main' } });
    const serverError = { status: 500 };
    (client.rest.pulls.create as ReturnType<typeof vi.fn>).mockRejectedValue(serverError);
    const { git } = fakeGit();
    const scm = new GithubScmPort(client, git);

    await expect(
      scm.openPr({ repo: 'octocat/hello-world', branch: 'agentops/t1', title: 'T', body: 'B' }),
    ).rejects.toBe(serverError);
    expect(client.rest.pulls.list).not.toHaveBeenCalled();
  });
});

describe('GithubScmPort — readFile', () => {
  it('decodes base64 content', async () => {
    const client = fakeClient();
    (client.rest.repos.getContent as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { content: Buffer.from('# demo').toString('base64') },
    });
    const { git } = fakeGit();
    const scm = new GithubScmPort(client, git);

    const content = await scm.readFile('octocat/hello-world', 'README.md');

    expect(client.rest.repos.getContent).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'hello-world',
      path: 'README.md',
    });
    expect(content).toBe('# demo');
  });

  it('returns null on a 404', async () => {
    const client = fakeClient();
    (client.rest.repos.getContent as ReturnType<typeof vi.fn>).mockRejectedValue({ status: 404 });
    const { git } = fakeGit();
    const scm = new GithubScmPort(client, git);

    await expect(scm.readFile('octocat/hello-world', 'nope.json')).resolves.toBeNull();
  });

  it('rethrows on a non-404 error', async () => {
    const client = fakeClient();
    (client.rest.repos.getContent as ReturnType<typeof vi.fn>).mockRejectedValue({ status: 500 });
    const { git } = fakeGit();
    const scm = new GithubScmPort(client, git);

    await expect(scm.readFile('octocat/hello-world', 'x.json')).rejects.toMatchObject({ status: 500 });
  });
});

describe('GithubScmPort — push', () => {
  it('force-pushes origin <branch> in the given workspace, with no token handling here', async () => {
    const client = fakeClient();
    const { git, calls } = fakeGit();
    const scm = new GithubScmPort(client, git);

    await scm.push('octocat/hello-world', '/tmp/workspace', 'agentops/t1', 'hash-1');

    expect(calls).toEqual([{ args: ['push', '--force', 'origin', 'agentops/t1'], cwd: '/tmp/workspace' }]);
  });

  it('throws if the push fails', async () => {
    const client = fakeClient();
    const git: GitCommandRunner = { run: vi.fn().mockResolvedValue({ stdout: '', stderr: 'rejected', exitCode: 1 }) };
    const scm = new GithubScmPort(client, git);

    await expect(scm.push('octocat/hello-world', '/tmp/workspace', 'agentops/t1', 'hash-1')).rejects.toThrow(/rejected/);
  });
});

describe('GithubScmPort — getPrFeedback', () => {
  function setupPrFeedback(overrides: {
    checkRuns?: Array<{ status: string; conclusion: string | null }>;
    reviewThreads?: Array<{ isResolved: boolean; comments: { nodes: Array<{ id: string; body: string }> } }>;
  }) {
    const client = fakeClient();
    (client.rest.pulls.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { head: { sha: 'abc123' } } });
    (client.rest.checks.listForRef as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { check_runs: overrides.checkRuns ?? [] },
    });
    (client.graphql as ReturnType<typeof vi.fn>).mockResolvedValue({
      repository: { pullRequest: { reviewThreads: { nodes: overrides.reviewThreads ?? [] } } },
    });
    const { git } = fakeGit();
    return new GithubScmPort(client, git);
  }

  it('maps all-completed, all-success check runs to green', async () => {
    const scm = setupPrFeedback({
      checkRuns: [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'success' },
      ],
    });

    const feedback = await scm.getPrFeedback('octocat/hello-world#7');

    expect(feedback.ciStatus).toBe('green');
  });

  it('maps any incomplete check run to pending', async () => {
    const scm = setupPrFeedback({
      checkRuns: [
        { status: 'in_progress', conclusion: null },
        { status: 'completed', conclusion: 'success' },
      ],
    });

    const feedback = await scm.getPrFeedback('octocat/hello-world#7');

    expect(feedback.ciStatus).toBe('pending');
  });

  it('maps a completed-but-failed check run to failed', async () => {
    const scm = setupPrFeedback({
      checkRuns: [{ status: 'completed', conclusion: 'failure' }],
    });

    const feedback = await scm.getPrFeedback('octocat/hello-world#7');

    expect(feedback.ciStatus).toBe('failed');
  });

  it('maps zero check runs to pending, not a vacuous green', async () => {
    const scm = setupPrFeedback({ checkRuns: [] });

    const feedback = await scm.getPrFeedback('octocat/hello-world#7');

    expect(feedback.ciStatus).toBe('pending');
  });

  it('degrades to pending (not a hard failure) when the token cannot read checks (403)', async () => {
    const client = fakeClient();
    (client.rest.pulls.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { head: { sha: 'abc123' } } });
    (client.rest.checks.listForRef as ReturnType<typeof vi.fn>).mockRejectedValue({
      status: 403,
      message: 'Resource not accessible by personal access token',
    });
    (client.graphql as ReturnType<typeof vi.fn>).mockResolvedValue({
      repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [{ id: 'c1', body: 'fix this' }] } }] } } },
    });
    const { git } = fakeGit();
    const scm = new GithubScmPort(client, git);

    const feedback = await scm.getPrFeedback('octocat/hello-world#7');

    // CI unknown -> pending (never merge_ready), but the rest of the feedback still comes through.
    expect(feedback.ciStatus).toBe('pending');
    expect(feedback.unresolvedThreads).toBe(1);
  });

  it('still propagates a non-403 error from the checks API', async () => {
    const client = fakeClient();
    (client.rest.pulls.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { head: { sha: 'abc123' } } });
    (client.rest.checks.listForRef as ReturnType<typeof vi.fn>).mockRejectedValue({ status: 500, message: 'server error' });
    const { git } = fakeGit();
    const scm = new GithubScmPort(client, git);

    await expect(scm.getPrFeedback('octocat/hello-world#7')).rejects.toMatchObject({ status: 500 });
  });

  it('counts unresolved review threads via GraphQL, not REST', async () => {
    const scm = setupPrFeedback({
      checkRuns: [{ status: 'completed', conclusion: 'success' }],
      reviewThreads: [
        { isResolved: false, comments: { nodes: [{ id: 'c1', body: 'fix this' }] } },
        { isResolved: true, comments: { nodes: [{ id: 'c2', body: 'looks good now' }] } },
      ],
    });

    const feedback = await scm.getPrFeedback('octocat/hello-world#7');

    expect(feedback.unresolvedThreads).toBe(1);
    expect(feedback.comments).toEqual([
      { id: 'c1', body: 'fix this', resolved: false },
      { id: 'c2', body: 'looks good now', resolved: true },
    ]);
  });

  it('fetches the PR head SHA before querying checks', async () => {
    const client = fakeClient();
    (client.rest.pulls.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { head: { sha: 'sha-xyz' } } });
    (client.rest.checks.listForRef as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { check_runs: [] } });
    (client.graphql as ReturnType<typeof vi.fn>).mockResolvedValue({
      repository: { pullRequest: { reviewThreads: { nodes: [] } } },
    });
    const { git } = fakeGit();
    const scm = new GithubScmPort(client, git);

    await scm.getPrFeedback('octocat/hello-world#7');

    expect(client.rest.pulls.get).toHaveBeenCalledWith({ owner: 'octocat', repo: 'hello-world', pull_number: 7 });
    expect(client.rest.checks.listForRef).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'hello-world',
      ref: 'sha-xyz',
    });
  });
});
