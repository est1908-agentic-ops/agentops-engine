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

// A PR's CI state is split across two independent GitHub APIs with different
// auth models: the Checks API (check runs -- what GitHub Actions and other Apps
// post) and the legacy Statuses API (commit statuses). A personal access token
// frequently CAN'T read the Checks API at all ("Resource not accessible by
// personal access token", 403) because it's App-oriented, and a repo may report
// via one API or the other. So getPrFeedback reads BOTH, tolerates a 403/404 on
// either (treating that source as `unknown` rather than throwing), and merges.
// See est1908/agents getPrFeedback 403 (2026-07-13).
//
// `unknown` and `none` are both "zero signal" but mean different things and
// merge differently: `unknown` is a source we COULDN'T read (403/404, or GitHub
// itself defaulting an empty combined-status to "pending") -- it must never
// become merge-ready, since the real CI could be anything. `none` is a source
// that answered with a genuine 200 reporting zero check runs / zero statuses --
// a confirmed fact, not a gap. When BOTH sources confirm `none`, there is no CI
// configured for this ref at all, and nothing will ever arrive to babysit-poll
// for, so that combination resolves to `green` instead of hanging until the
// babysit brake trips. See est1908/agents PR #5 (2026-07-13): zero check runs
// (Checks API 403'd -> unknown) and zero statuses (confirmed `none`) -- that
// PR still correctly resolves to `unreadable` rather than `green`, since one
// side remains unreadable and its real state could be anything.
type CiSignal = 'green' | 'failed' | 'pending' | 'unknown' | 'none';

function isNotAccessible(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  return status === 403 || status === 404;
}

// Not every non-'success' conclusion is a failure: 'skipped' (e.g. a
// path-filtered job that didn't need to run) and 'neutral' are explicitly
// non-blocking per GitHub's own semantics -- only these represent a real,
// merge-blocking CI failure.
const FAILING_CHECK_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'stale']);

function mapCheckRuns(checkRuns: Array<{ status: string; conclusion: string | null }>): CiSignal {
  if (checkRuns.length === 0) return 'none'; // confirmed: no check runs exist for this ref
  if (checkRuns.some((run) => run.status !== 'completed')) return 'pending';
  const hasFailure = checkRuns.some((run) => run.conclusion !== null && FAILING_CHECK_CONCLUSIONS.has(run.conclusion));
  return hasFailure ? 'failed' : 'green';
}

function mapCombinedStatus(state: string, total: number): CiSignal {
  if (total === 0) return 'none'; // confirmed: no legacy statuses on this ref
  if (state === 'success') return 'green';
  if (state === 'failure' || state === 'error') return 'failed';
  return 'pending';
}

// Failure dominates; then pending (a real signal from the other side means CI
// is genuinely still running -- worth waiting on); then green; two
// confirmed-empty sources (`none`) mean no CI is configured anywhere for this
// ref, so that combination is merge-ready too. Every remaining combination
// necessarily involves an `unknown` paired with `none` or another `unknown`
// (see the exhaustive case analysis: anything with `failed`/`pending`/`green`
// is already handled above) -- i.e. neither source gave a real signal at all.
// That's not "still running," it's "we structurally can't tell" (e.g. a token
// that can't read the Checks API, see est1908/agents getPrFeedback 403
// (2026-07-13)) -- retrying won't change it, so surface it distinctly as
// `unreadable` instead of defaulting to `pending`, which would babysit-poll
// forever on a permission problem no amount of waiting will fix.
export function mergeCiSignals(a: CiSignal, b: CiSignal): 'green' | 'failed' | 'pending' | 'unreadable' {
  if (a === 'failed' || b === 'failed') return 'failed';
  if (a === 'pending' || b === 'pending') return 'pending';
  if (a === 'green' || b === 'green') return 'green';
  if (a === 'none' && b === 'none') return 'green';
  return 'unreadable';
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
        ...(req.labels && { labels: req.labels }),
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

  // Read CI from the Checks API and the Statuses API in parallel and merge. A
  // 403/404 on either (e.g. a PAT that can't read check runs) degrades that
  // source to `unknown` instead of failing the whole activity; other errors
  // (5xx/network) still propagate so Temporal's retry can absorb them.
  private async readCiStatus(owner: string, repo: string, ref: string): Promise<'green' | 'failed' | 'pending' | 'unreadable'> {
    const [checks, status] = await Promise.all([
      this.readCheckRuns(owner, repo, ref),
      this.readCombinedStatus(owner, repo, ref),
    ]);
    return mergeCiSignals(checks, status);
  }

  private async readCheckRuns(owner: string, repo: string, ref: string): Promise<CiSignal> {
    try {
      const { data } = await this.client.rest.checks.listForRef({ owner, repo, ref });
      const total = data.total_count ?? data.check_runs.length;
      return total === 0 ? 'none' : mapCheckRuns(data.check_runs);
    } catch (err) {
      if (isNotAccessible(err)) return 'unknown';
      throw err;
    }
  }

  private async readCombinedStatus(owner: string, repo: string, ref: string): Promise<CiSignal> {
    try {
      const { data } = await this.client.rest.repos.getCombinedStatusForRef({ owner, repo, ref });
      return mapCombinedStatus(data.state, data.total_count);
    } catch (err) {
      if (isNotAccessible(err)) return 'unknown';
      throw err;
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
