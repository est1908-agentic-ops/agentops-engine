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
    const { data: prData } = await this.client.rest.pulls.create({
      owner,
      repo,
      head: req.branch,
      base: repoData.default_branch,
      title: req.title,
      body: req.body,
    });
    return { prRef: `${owner}/${repo}#${prData.number}`, url: prData.html_url };
  }

  async getPrFeedback(prRef: string): Promise<PrFeedback> {
    const { owner, repo, number } = parseRef(prRef);
    const { data: pr } = await this.client.rest.pulls.get({ owner, repo, pull_number: number });
    const { data: checksData } = await this.client.rest.checks.listForRef({ owner, repo, ref: pr.head.sha });
    const ciStatus = mapCiStatus(checksData.check_runs);

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

  async push(workspaceRef: string, branch: string, _contentHash: string): Promise<void> {
    const result = await this.git.run(['push', 'origin', branch], { cwd: workspaceRef });
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
