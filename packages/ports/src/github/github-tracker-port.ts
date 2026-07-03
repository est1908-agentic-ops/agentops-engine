import type { Issue, TrackerPort } from '../tracker-port';
import type { GithubClient } from './github-client';
import { parseRef } from './parse-ref';

export class GithubTrackerPort implements TrackerPort {
  constructor(private readonly client: GithubClient) {}

  async getIssue(ref: string): Promise<Issue> {
    const { owner, repo, number } = parseRef(ref);
    const { data } = await this.client.rest.issues.get({ owner, repo, issue_number: number });
    return {
      ref,
      title: data.title,
      body: data.body ?? '',
      labels: data.labels.map((label) => (typeof label === 'string' ? label : (label.name ?? ''))),
    };
  }

  async comment(ref: string, body: string): Promise<void> {
    const { owner, repo, number } = parseRef(ref);
    await this.client.rest.issues.createComment({ owner, repo, issue_number: number, body });
  }

  async label(ref: string, label: string): Promise<void> {
    const { owner, repo, number } = parseRef(ref);
    await this.client.rest.issues.addLabels({ owner, repo, issue_number: number, labels: [label] });
  }
}
