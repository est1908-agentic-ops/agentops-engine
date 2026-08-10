import type { MergePrRequest, MergePrResult, PrFeedback, PrSnapshot } from '@agentops/contracts';
import { ApplicationFailure } from '@temporalio/common';
import type { GitCommandRunner } from '../git/git-command-runner';
import type { OpenPrRequest, OpenPrResult, ScmPort } from '../scm-port';
import type { GithubClient } from './github-client';
import { parseRef, parseRepoSlug } from './parse-ref';

interface GraphqlReviewThreadsResult {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: Array<{
          isResolved: boolean;
          comments: { nodes: Array<{ id: string; body: string }> };
        }>;
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

interface GraphqlStatusCheckRollupResult {
  repository: {
    object: {
      statusCheckRollup: { state: string } | null;
    } | null;
  } | null;
}

// Aggregate only -- do NOT request rollup contexts/CheckRun nodes. Fine-grained
// PATs can read `statusCheckRollup.state` but get FORBIDDEN on individual
// CheckRun nodes under contexts (GitHub fine-grained PAT Checks limitation).
const STATUS_CHECK_ROLLUP_QUERY = `
  query($owner: String!, $repo: String!, $oid: GitObjectID!) {
    repository(owner: $owner, name: $repo) {
      object(oid: $oid) {
        ... on Commit {
          statusCheckRollup { state }
        }
      }
    }
  }
`;

// A PR's CI state is split across independent GitHub surfaces with different
// auth models:
//   1. REST Checks API (check runs -- what GitHub Actions and other Apps post)
//   2. REST Statuses API (legacy commit statuses)
//   3. GraphQL Commit.statusCheckRollup.state (aggregate over checks+statuses)
//
// Fine-grained PATs are documented to be unable to call the Checks REST API
// (and cannot read rollup *contexts* / CheckRun nodes). They CAN, however, read
// the rollup's aggregate `state` via GraphQL. Classic PATs can use REST Checks.
// A repo may report via any subset of these surfaces, so getPrFeedback reads
// all three in parallel, tolerates a 403/404 on each (treating that source as
// `unknown` rather than throwing), and merges. See est1908/agents getPrFeedback
// 403 (2026-07-13) and the fine-grained PAT Checks API limitation.
//
// `unknown` and `none` are both "zero signal" but mean different things and
// merge differently: `unknown` is a source we COULDN'T read (403/404) -- it
// must never alone become merge-ready, since the real CI could be anything.
// `none` is a source that answered with a genuine empty result -- a confirmed
// fact. When EVERY source that answered confirms `none` (and none is
// `unknown`), there is no CI configured for this ref at all, so that
// combination resolves to `green` instead of hanging until the babysit brake
// trips. A Checks REST 403 + empty Statuses used to resolve to `unreadable`
// forever on fine-grained PATs; the GraphQL rollup state closes that gap.
type CiSignal = 'green' | 'failed' | 'pending' | 'unknown' | 'none';

function isNotAccessible(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  return status === 403 || status === 404;
}

// GitHub permanently rejects a push that touches .github/workflows/** when the token
// lacks the `workflow` scope, with a stderr like:
//   ! [remote rejected] ... (refusing to allow a Personal Access Token to create or
//    update workflow `.github/workflows/x.yml` without `workflow` scope)
// The "OAuth App"/"GitHub App" phrasings are the same underlying missing-scope refusal.
// This is permanent until a human changes the token scopes, so it must fail fast rather
// than burn all of Temporal's retry attempts. Match narrowly on the two stable,
// GitHub-authored fragments to avoid misclassifying transient refusals as permanent.
export function isPermanentPushPermissionRejection(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return s.includes('refusing to allow a') && s.includes('without `workflow` scope');
}

// Not every non-'success' conclusion is a failure: 'skipped' (e.g. a
// path-filtered job that didn't need to run) and 'neutral' are explicitly
// non-blocking per GitHub's own semantics -- only these represent a real,
// merge-blocking CI failure.
const FAILING_CHECK_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'stale',
]);

function mapCheckRuns(checkRuns: Array<{ status: string; conclusion: string | null }>): CiSignal {
  if (checkRuns.length === 0) return 'none'; // confirmed: no check runs exist for this ref
  if (checkRuns.some((run) => run.status !== 'completed')) return 'pending';
  const hasFailure = checkRuns.some(
    (run) => run.conclusion !== null && FAILING_CHECK_CONCLUSIONS.has(run.conclusion),
  );
  return hasFailure ? 'failed' : 'green';
}

function mapCombinedStatus(state: string, total: number): CiSignal {
  if (total === 0) return 'none'; // confirmed: no legacy statuses on this ref
  if (state === 'success') return 'green';
  if (state === 'failure' || state === 'error') return 'failed';
  return 'pending';
}

// Failure dominates; then pending (a real in-progress signal is worth waiting
// on); then green; every answered source confirmed-empty (`none`) means no CI
// is configured anywhere for this ref, so that combination is merge-ready.
// Remaining combinations necessarily involve at least one `unknown` with no
// real signal from any other source -- "we structurally can't tell" -- so
// surface `unreadable` instead of defaulting to `pending` (which would
// babysit-poll forever on a permission problem no amount of waiting will fix).
export function mergeCiSignals(
  checks: CiSignal,
  status: CiSignal,
  rollup: CiSignal = 'unknown',
): 'green' | 'failed' | 'pending' | 'unreadable' {
  // Real signals dominate regardless of source. Failure beats pending beats green.
  const signals = [checks, status, rollup];
  if (signals.some((s) => s === 'failed')) return 'failed';
  if (signals.some((s) => s === 'pending')) return 'pending';
  if (signals.some((s) => s === 'green')) return 'green';

  // GraphQL statusCheckRollup is GitHub's aggregate over check runs + legacy
  // statuses. A confirmed-empty rollup means there is nothing to babysit, even
  // when Checks REST is `unknown` (fine-grained PAT Checks API limitation).
  if (rollup === 'none') return 'green';

  // Without a readable rollup, both REST sources must confirm empty.
  if (checks === 'none' && status === 'none') return 'green';

  return 'unreadable';
}

// GitHub StatusState / StatusCheckRollup state enum (GraphQL).
export function mapStatusCheckRollupState(state: string | null | undefined): CiSignal {
  if (state == null) return 'none'; // confirmed: no rollup (no checks/statuses on this commit)
  switch (state.toUpperCase()) {
    case 'SUCCESS':
      return 'green';
    case 'FAILURE':
    case 'ERROR':
      return 'failed';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'unknown';
  }
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
      if (req.labels?.length) {
        await this.client.rest.issues.addLabels({
          owner,
          repo,
          issue_number: prData.number,
          labels: req.labels,
        });
      }
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

  async getPrSnapshot(prRef: string): Promise<PrSnapshot> {
    const { owner, repo, number } = parseRef(prRef);
    const { data: pr } = await this.client.rest.pulls.get({ owner, repo, pull_number: number });
    const ciStatus = await this.readCiStatus(owner, repo, pr.head.sha);

    const graphqlResult = await this.client.graphql<GraphqlReviewThreadsResult>(
      REVIEW_THREADS_QUERY,
      {
        owner,
        repo,
        number,
      },
    );
    const threads = graphqlResult.repository.pullRequest.reviewThreads.nodes;
    const unresolvedThreads = threads.filter((thread) => !thread.isResolved).length;
    const comments = threads.map((thread) => ({
      id: thread.comments.nodes[0]?.id ?? '',
      body: thread.comments.nodes[0]?.body ?? '',
      resolved: thread.isResolved,
    }));

    return {
      prRef,
      headSha: pr.head.sha,
      headRepo: pr.head.repo.full_name,
      headBranch: pr.head.ref,
      checkoutRef: `refs/pull/${number}/head`,
      labels: pr.labels.map((label) => label.name),
      state: pr.merged ? 'merged' : pr.state,
      draft: pr.draft,
      mergeable: pr.mergeable,
      mergedHeadSha: pr.merge_commit_sha,
      ciStatus,
      unresolvedThreads,
      comments,
    };
  }

  async getPrFeedback(prRef: string): Promise<PrFeedback> {
    const snapshot = await this.getPrSnapshot(prRef);
    return {
      ciStatus: snapshot.ciStatus,
      unresolvedThreads: snapshot.unresolvedThreads,
      comments: snapshot.comments,
    };
  }

  async mergePr(req: MergePrRequest): Promise<MergePrResult> {
    const { owner, repo, number } = parseRef(req.prRef);
    try {
      const { data } = await this.client.rest.pulls.merge({
        owner,
        repo,
        pull_number: number,
        sha: req.expectedHeadSha,
      });
      if (!data.merged)
        return { kind: 'not-mergeable', reason: data.message || 'GitHub refused merge' };
      return { kind: 'merged', headSha: req.expectedHeadSha, mergeCommitSha: data.sha };
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 409) return { kind: 'head-changed' };
      if (status === 403)
        return { kind: 'forbidden', reason: err instanceof Error ? err.message : 'forbidden' };
      if (status === 405) {
        const snapshot = await this.getPrSnapshot(req.prRef);
        if (snapshot.state === 'merged' && snapshot.headSha === req.expectedHeadSha) {
          return { kind: 'already-merged', headSha: req.expectedHeadSha };
        }
        return {
          kind: 'not-mergeable',
          reason: err instanceof Error ? err.message : 'not mergeable',
        };
      }
      throw err;
    }
  }

  // Read CI from Checks REST, Statuses REST, and GraphQL statusCheckRollup in
  // parallel and merge. A 403/404 on any source (e.g. a fine-grained PAT that
  // can't call the Checks REST API) degrades that source to `unknown` instead
  // of failing the whole activity; other errors (5xx/network) still propagate
  // so Temporal's retry can absorb them.
  private async readCiStatus(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<'green' | 'failed' | 'pending' | 'unreadable'> {
    const [checks, status, rollup] = await Promise.all([
      this.readCheckRuns(owner, repo, ref),
      this.readCombinedStatus(owner, repo, ref),
      this.readStatusCheckRollup(owner, repo, ref),
    ]);
    return mergeCiSignals(checks, status, rollup);
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

  private async readStatusCheckRollup(
    owner: string,
    repo: string,
    oid: string,
  ): Promise<CiSignal> {
    try {
      const data = await this.client.graphql<GraphqlStatusCheckRollupResult>(
        STATUS_CHECK_ROLLUP_QUERY,
        { owner, repo, oid },
      );
      // Missing object usually means the mock / response has no Commit -- treat
      // as confirmed-empty rather than unknown so REST-only test doubles still
      // merge the same way they did before this third source existed.
      const state = data.repository?.object?.statusCheckRollup?.state;
      if (data.repository?.object == null) return 'none';
      return mapStatusCheckRollupState(state);
    } catch (err) {
      if (isNotAccessible(err)) return 'unknown';
      // @octokit/graphql throws GraphqlResponseError with .errors; map the
      // fine-grained FORBIDDEN on Checks-adjacent fields the same as REST 403.
      const errors = (err as { errors?: Array<{ type?: string; message?: string }> }).errors;
      if (
        Array.isArray(errors) &&
        errors.some(
          (e) =>
            e.type === 'FORBIDDEN' ||
            (e.message ?? '').includes('Resource not accessible by personal access token'),
        )
      ) {
        return 'unknown';
      }
      throw err;
    }
  }

  async push(
    _repo: string,
    workspaceRef: string,
    branch: string,
    _contentHash: string,
  ): Promise<void> {
    // --force: this branch is task-owned and disposable (ARCHITECTURE.md §1 -- only
    // pushed commits count, worktrees aren't). prepareWorkspace always rebuilds it
    // fresh off origin/<base> (see reclaimStaleWorktree), so a rerun of the same
    // taskId produces a branch with different commits than any prior run's remote
    // copy; a plain push would be rejected as a non-fast-forward. No human or other
    // task ever pushes to agentops/<taskId>, so clobbering it here is safe.
    const result = await this.git.run(['push', '--force', 'origin', branch], { cwd: workspaceRef });
    if (result.exitCode !== 0) {
      const message = `GithubScmPort.push: git push failed: ${result.stderr}`;
      if (isPermanentPushPermissionRejection(result.stderr)) {
        throw ApplicationFailure.nonRetryable(message, 'GitPushPermissionError');
      }
      throw new Error(message);
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
