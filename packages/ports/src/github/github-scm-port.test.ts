import { describe, expect, it, vi } from 'vitest';
import type { GitCommandRunner } from '../git/git-command-runner';
import type { GithubClient } from './github-client';
import { GithubScmPort } from './github-scm-port';

function fakeClient(): GithubClient {
  return {
    rest: {
      issues: { get: vi.fn(), createComment: vi.fn(), addLabels: vi.fn() },
      pulls: { create: vi.fn(), get: vi.fn(), list: vi.fn() },
      repos: { get: vi.fn(), getContent: vi.fn(), getCombinedStatusForRef: vi.fn() },
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
      data: { total_count: (overrides.checkRuns ?? []).length, check_runs: overrides.checkRuns ?? [] },
    });
    // Default: no legacy commit statuses -> `unknown`, so these cases are driven
    // by the check-runs signal alone (preserving the original assertions).
    (client.rest.repos.getCombinedStatusForRef as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { state: 'pending', total_count: 0 },
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

  // Independent control of both CI sources for the merge/permission cases.
  function setupCi(opts: {
    checks?: { data: unknown } | Error;
    status?: { data: unknown } | Error;
  }) {
    const client = fakeClient();
    (client.rest.pulls.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { head: { sha: 'abc123' } } });
    const wire = (fn: ReturnType<typeof vi.fn>, v?: { data: unknown } | Error) => {
      if (v instanceof Error) fn.mockRejectedValue(v);
      else if (v) fn.mockResolvedValue(v);
    };
    wire(client.rest.checks.listForRef as ReturnType<typeof vi.fn>, opts.checks);
    wire(client.rest.repos.getCombinedStatusForRef as ReturnType<typeof vi.fn>, opts.status);
    (client.graphql as ReturnType<typeof vi.fn>).mockResolvedValue({
      repository: { pullRequest: { reviewThreads: { nodes: [] } } },
    });
    const { git } = fakeGit();
    return new GithubScmPort(client, git);
  }
  const forbidden = Object.assign(new Error('Resource not accessible by personal access token'), { status: 403 });

  it('degrades to pending (never throws) when BOTH check-runs and statuses are inaccessible (403)', async () => {
    const scm = setupCi({ checks: forbidden, status: forbidden });
    const feedback = await scm.getPrFeedback('octocat/hello-world#7');
    expect(feedback.ciStatus).toBe('pending');
  });

  it('falls back to the Statuses API when the Checks API is 403', async () => {
    const scm = setupCi({
      checks: forbidden,
      status: { data: { state: 'success', total_count: 2 } },
    });
    expect((await scm.getPrFeedback('octocat/hello-world#7')).ciStatus).toBe('green');
  });

  it('reports failed when the Statuses API says failure even though checks are inaccessible', async () => {
    const scm = setupCi({
      checks: forbidden,
      status: { data: { state: 'failure', total_count: 1 } },
    });
    expect((await scm.getPrFeedback('octocat/hello-world#7')).ciStatus).toBe('failed');
  });

  it('a failure in either source dominates a green in the other', async () => {
    const scm = setupCi({
      checks: { data: { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success' }] } },
      status: { data: { state: 'failure', total_count: 1 } },
    });
    expect((await scm.getPrFeedback('octocat/hello-world#7')).ciStatus).toBe('failed');
  });

  it('still propagates a non-403 error (e.g. 500) so Temporal can retry', async () => {
    const scm = setupCi({
      checks: Object.assign(new Error('server error'), { status: 500 }),
      status: { data: { state: 'success', total_count: 1 } },
    });
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
    (client.rest.checks.listForRef as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { total_count: 0, check_runs: [] } });
    (client.rest.repos.getCombinedStatusForRef as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { state: 'pending', total_count: 0 } });
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
