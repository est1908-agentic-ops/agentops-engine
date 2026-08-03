import type { Issue, TrackerPort, CreateIssueRequest, CreatedIssue } from '../tracker-port';
import type { GithubClient } from './github-client';
import { parseRef, parseRepoSlug } from './parse-ref';

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

  async removeLabel(ref: string, label: string): Promise<void> {
    const { owner, repo, number } = parseRef(ref);
    await this.client.rest.issues
      .removeLabel({ owner, repo, issue_number: number, name: label })
      .catch((err: unknown) => {
        if ((err as { status?: number }).status !== 404) throw err;
      });
  }

  async createIssue(req: CreateIssueRequest): Promise<CreatedIssue> {
    const { owner, repo } = parseRepoSlug(req.repo);
    const { data } = await this.client.rest.issues.create({
      owner,
      repo,
      title: req.title,
      body: req.body,
      labels: req.labels,
    });
    return { ref: `${req.repo}#${data.number}`, url: data.html_url };
  }
}
