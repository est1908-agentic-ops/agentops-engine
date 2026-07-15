import {
  AGENTOPS_MANAGED_LABEL,
  AUTO_MERGE_DISABLE_LABEL,
  AUTO_MERGE_LABEL,
} from '@agentops/contracts';

export type PrLandingEvent = {
  kind: 'enroll' | 'wake';
  repo: string;
  prRef: string;
  headBranch: string;
  labels: string[];
  managed: boolean;
};

interface GithubPullRequestPayload {
  action?: string;
  label?: { name?: string };
  pull_request?: {
    number?: number;
    head?: { ref?: string };
    labels?: Array<{ name?: string }>;
  };
  repository?: { full_name?: string };
}

interface GithubPrReviewPayload {
  action?: string;
  pull_request?: {
    number?: number;
    head?: { ref?: string };
    labels?: Array<{ name?: string }>;
  };
  repository?: { full_name?: string };
}

function currentLabels(payload: GithubPullRequestPayload | GithubPrReviewPayload): string[] {
  return (payload.pull_request?.labels ?? []).map((label) => label.name ?? '').filter(Boolean);
}

function buildEvent(
  kind: PrLandingEvent['kind'],
  payload: GithubPullRequestPayload | GithubPrReviewPayload,
): PrLandingEvent | null {
  const repo = payload.repository?.full_name;
  const prNumber = payload.pull_request?.number;
  const headBranch = payload.pull_request?.head?.ref;
  if (!repo || prNumber === undefined || !headBranch) {
    return null;
  }
  const labels = currentLabels(payload);
  const managed = labels.includes(AGENTOPS_MANAGED_LABEL);
  return {
    kind,
    repo,
    prRef: `${repo}#${prNumber}`,
    headBranch,
    labels,
    managed,
  };
}

export function parsePrLandingEvent(
  githubEvent: string | undefined,
  payload: unknown,
): PrLandingEvent | null {
  const body = payload as GithubPullRequestPayload & GithubPrReviewPayload;

  if (githubEvent === 'pull_request') {
    const labelName = body.label?.name;
    if (body.action === 'labeled' && labelName === AUTO_MERGE_LABEL) {
      return buildEvent('enroll', body);
    }
    if (
      (body.action === 'labeled' && labelName === AUTO_MERGE_DISABLE_LABEL) ||
      (body.action === 'unlabeled' &&
        (labelName === AUTO_MERGE_LABEL || labelName === AUTO_MERGE_DISABLE_LABEL))
    ) {
      return buildEvent('wake', body);
    }
    return null;
  }

  if (githubEvent === 'pull_request_review' && body.action === 'submitted') {
    const labels = currentLabels(body);
    if (labels.includes(AGENTOPS_MANAGED_LABEL) || labels.includes(AUTO_MERGE_LABEL)) {
      return buildEvent('wake', body);
    }
  }

  return null;
}
