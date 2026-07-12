export interface PushEvent {
  repo: string;
}

interface GithubPushPayload {
  repository?: { full_name?: string };
}

export function parsePushEvent(githubEvent: string | undefined, payload: unknown): PushEvent | null {
  if (githubEvent !== 'push') {
    return null;
  }
  const repo = (payload as GithubPushPayload).repository?.full_name;
  if (!repo) {
    return null;
  }
  return { repo };
}