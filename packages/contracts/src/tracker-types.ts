export const DEFAULT_TRIGGER_LABEL = 'agentops';

export interface Issue {
  ref: string;
  title: string;
  body: string;
  labels: string[];
}
export interface CreateIssueInput {
  repo: string;
  project: string;
  title: string;
  body: string;
  labels: string[];
  dedupeFingerprint?: string;
}
export interface CreateIssueResult {
  ref: string;
  url: string;
  deduped: boolean;
}
