export interface IssueLabeledEvent {
  repo: string; // "owner/repo"
  issueRef: string; // "owner/repo#N"
  issueNumber: number;
  title: string;
}

interface GithubIssuesWebhookPayload {
  action?: string;
  label?: { name?: string };
  issue?: { number?: number; title?: string };
  repository?: { full_name?: string };
}

// Only the "issues" webhook's "labeled" action, and only for the configured
// trigger label — a repo's webhook may be subscribed to far more event types
// than this gateway acts on; everything else is silently not-our-concern,
// not an error.
export function parseIssueLabeledEvent(
  githubEvent: string | undefined,
  payload: unknown,
  triggerLabel: string,
): IssueLabeledEvent | null {
  if (githubEvent !== 'issues') {
    return null;
  }
  const body = payload as GithubIssuesWebhookPayload;
  if (body.action !== 'labeled') {
    return null;
  }
  if (body.label?.name !== triggerLabel) {
    return null;
  }
  const repo = body.repository?.full_name;
  const issueNumber = body.issue?.number;
  if (!repo || issueNumber === undefined) {
    return null;
  }
  return {
    repo,
    issueRef: `${repo}#${issueNumber}`,
    issueNumber,
    title: body.issue?.title ?? '',
  };
}
