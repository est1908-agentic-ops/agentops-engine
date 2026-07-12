import type { PrFeedback } from '@agentops/contracts';
import type { GitCommandRunner } from '../git/git-command-runner';
import type { OpenPrRequest, OpenPrResult, ScmPort } from '../scm-port';
import type { GithubClient } from './github-client';
import { parseRef, parseRepoSlug } from './parse-ref';

interface GraphqlReviewThreadsResult {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: Array<{ isResolved: boolean; comments: { nodes: Array<{ id: string; body: string }> } }>;
      };
    };
  };
}

const REVIEW_THREADS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
          nodes { isResolved comments(first: 1) { nodes { id body } } }
        }
      }
    }
  }
`;

function mapCiStatus(checkRuns: Array<{ status: string; conclusion: string | null }>): 'pending' | 'green' | 'failed' {
  if (checkRuns.length === 0 || checkRuns.some((run) => run.status !== 'completed')) {
    return 'pending';
  }
  return checkRuns.every((run) => run.conclusion === 'success') ? 'green' : 'failed';
}

export class GithubScmPort implements ScmPort {
  constructor(
    private readonly client: GithubClient,
    private readonly git: GitCommandRunner,
  ) {}

  async openPr(req: OpenPrRequest): Promise<OpenPrResult> {
    const { owner, repo } = parseRepoSlug(req.repo);
    const { data: repoData } = await this.client.rest.repos.get({ owner, repo });
    try {
      const { data: prData } = await this.client.rest.pulls.create({
        owner,
        repo,
        head: req.branch,
        base: repoData.default_branch,
        title: req.title,
        body: req.body,
      });
      return { prRef: `${owner}/${repo}#${prData.number}`, url: prData.html_url };
    } catch (err) {
      // req.branch is deterministic per task, so a Temporal retry of this same activity call
      // (create succeeded at GitHub but the activity failed before returning) reissues the
      // identical create and GitHub reports 422 "already exists" -- reuse that PR instead of
      // failing every retry.
      if ((err as { status?: number }).status !== 422) {
        throw err;
      }
      const { data: existing } = await this.client.rest.pulls.list({
        owner,
        repo,
        head: `${owner}:${req.branch}`,
        state: 'open',
      });
      const pr = existing[0];
      if (!pr) {
        throw err;
      }
      return { prRef: `${owner}/${repo}#${pr.number}`, url: pr.html_url };
    }
  }

  async getPrFeedback(prRef: string): Promise<PrFeedback> {
    const { owner, repo, number } = parseRef(prRef);
    const { data: pr } = await this.client.rest.pulls.get({ owner, repo, pull_number: number });
    const ciStatus = await this.readCiStatus(owner, repo, pr.head.sha);

    const graphqlResult = await this.client.graphql<GraphqlReviewThreadsResult>(REVIEW_THREADS_QUERY, {
      owner,
      repo,
      number,
    });
    const threads = graphqlResult.repository.pullRequest.reviewThreads.nodes;
    const unresolvedThreads = threads.filter((thread) => !thread.isResolved).length;
    const comments = threads.map((thread) => ({
      id: thread.comments.nodes[0]?.id ?? '',
      body: thread.comments.nodes[0]?.body ?? '',
      resolved: thread.isResolved,
    }));

    return { ciStatus, unresolvedThreads, comments };
  }

  // A token without the Checks:Read permission gets 403 "Resource not accessible
  // by personal access token" from the check-runs API. That's an environment
  // limitation, not a CI failure -- treat CI status as unknown ('pending') so
  // the PR-babysit loop keeps its normal bounded behavior (waiting -> braked
  // after maxBabysitRounds) instead of hard-failing the whole workflow on a PR it
  // already opened and pushed. 'pending' is never mergeable, so this can't
  // launder an unknown CI state into a false merge. Any non-403 error (a real
  // API/network failure) still propagates. See est1908/agents devcycle
  // (getPrFeedback 403, 2026-07-13).
  private async readCiStatus(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<'pending' | 'green' | 'failed'> {
    try {
      const { data } = await this.client.rest.checks.listForRef({ owner, repo, ref });
      return mapCiStatus(data.check_runs);
    } catch (err) {
      if ((err as { status?: number }).status !== 403) {
        throw err;
      }
      console.warn(
        JSON.stringify({
          event: 'pr-feedback-checks-forbidden',
          repo: `${owner}/${repo}`,
          ref,
          message: 'token lacks Checks:Read permission -- treating CI status as pending',
        }),
      );
      return 'pending';
    }
  }

  async push(_repo: string, workspaceRef: string, branch: string, _contentHash: string): Promise<void> {
    // --force: this branch is task-owned and disposable (ARCHITECTURE.md §1 -- only
    // pushed commits count, worktrees aren't). prepareWorkspace always rebuilds it
    // fresh off origin/<base> (see reclaimStaleWorktree), so a rerun of the same
    // taskId produces a branch with different commits than any prior run's remote
    // copy; a plain push would be rejected as a non-fast-forward. No human or other
    // task ever pushes to agentops/<taskId>, so clobbering it here is safe.
    const result = await this.git.run(['push', '--force', 'origin', branch], { cwd: workspaceRef });
    if (result.exitCode !== 0) {
      throw new Error(`GithubScmPort.push: git push failed: ${result.stderr}`);
    }
  }

  async readFile(repo: string, path: string): Promise<string | null> {
    const { owner, repo: repoName } = parseRepoSlug(repo);
    try {
      const { data } = await this.client.rest.repos.getContent({ owner, repo: repoName, path });
      return data.content ? Buffer.from(data.content, 'base64').toString('utf8') : null;
    } catch (err) {
      if ((err as { status?: number }).status === 404) {
        return null;
      }
      throw err;
    }
  }
}
