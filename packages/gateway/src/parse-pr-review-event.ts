import { isValidGitRefName } from '@agentops/contracts';

export interface PrReviewEvent {
  repo: string;
  prRef: string; // owner/repo#N
  prNumber: number;
  reviewBody: string;
  action: string;
  headBranch?: string; // the branch the PR head is on, for repair workspace
  hasAgentopsLabel: boolean;
}

interface GithubPrReviewPayload {
  action?: string;
  review?: { body?: string };
  pull_request?: {
    number?: number;
    labels?: Array<{ name?: string }>;
    head?: { ref?: string };
  };
  repository?: { full_name?: string };
}

export function parsePrReviewEvent(
  githubEvent: string | undefined,
  payload: unknown,
): PrReviewEvent | null {
  if (githubEvent !== 'pull_request_review') {
    return null;
  }
  const body = payload as GithubPrReviewPayload;
  if (body.action !== 'submitted') {
    return null;
  }
  const repo = body.repository?.full_name;
  const prNumber = body.pull_request?.number;
  const reviewBody = body.review?.body ?? '';
  const headBranch = body.pull_request?.head?.ref;
  const hasAgentopsLabel = !!body.pull_request?.labels?.some((l) => l.name === 'agentops');
  if (!repo || prNumber === undefined) {
    return null;
  }
  if (headBranch !== undefined && !isValidGitRefName(headBranch)) {
    return null;
  }
  const prRef = `${repo}#${prNumber}`;
  return {
    repo,
    prRef,
    prNumber,
    reviewBody,
    action: body.action,
    headBranch,
    hasAgentopsLabel,
  };
}
