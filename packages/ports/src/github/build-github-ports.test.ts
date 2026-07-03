import { describe, expect, it, vi } from 'vitest';
import type { GitCommandRunner } from '../git/git-command-runner';
import { createGithubPorts } from './build-github-ports';
import { GithubScmPort } from './github-scm-port';
import { GithubTrackerPort } from './github-tracker-port';

function fakeGit(): GitCommandRunner {
  return { run: vi.fn() };
}

describe('createGithubPorts', () => {
  it('returns a GithubScmPort and GithubTrackerPort sharing one Octokit client', () => {
    // Also proves construction never makes a network call: Octokit's constructor only
    // sets up auth headers, no request is issued until a rest.*/graphql() call is made —
    // this synchronous call would throw or hang otherwise.
    const { scm, tracker } = createGithubPorts('fake-token', fakeGit());

    expect(scm).toBeInstanceOf(GithubScmPort);
    expect(tracker).toBeInstanceOf(GithubTrackerPort);
  });
});
