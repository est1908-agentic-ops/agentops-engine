import type { Issue } from '@agentops/contracts';
export type { Issue };

export interface CreateIssueRequest {
  repo: string;
  title: string;
  body: string;
  labels: string[];
}

export interface CreatedIssue {
  ref: string;
  url: string;
}

export interface TrackerPort {
  getIssue(ref: string): Promise<Issue>;
  comment(ref: string, body: string): Promise<void>;
  label(ref: string, label: string): Promise<void>;
  removeLabel(ref: string, label: string): Promise<void>;
  createIssue(req: CreateIssueRequest): Promise<CreatedIssue>;
}
