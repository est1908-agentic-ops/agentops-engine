import type { Issue, TrackerPort, CreateIssueRequest, CreatedIssue } from '../tracker-port';

export class MemoryTrackerPort implements TrackerPort {
  private readonly issues = new Map<string, Issue>();
  private readonly comments = new Map<string, string[]>();
  private readonly labels = new Map<string, Set<string>>();
  private readonly created: CreatedIssue[] = [];
  private seq = 0;

  seedIssue(issue: Issue): void {
    this.issues.set(issue.ref, issue);
  }

  async getIssue(ref: string): Promise<Issue> {
    const issue = this.issues.get(ref);
    if (!issue) {
      throw new Error(`MemoryTrackerPort: unknown issue "${ref}"`);
    }
    return issue;
  }

  async comment(ref: string, body: string): Promise<void> {
    const existing = this.comments.get(ref) ?? [];
    existing.push(body);
    this.comments.set(ref, existing);
  }

  async label(ref: string, label: string): Promise<void> {
    const existing = this.labels.get(ref) ?? new Set<string>();
    existing.add(label);
    this.labels.set(ref, existing);
  }

  async removeLabel(ref: string, label: string): Promise<void> {
    this.labels.get(ref)?.delete(label);
  }

  async createIssue(req: CreateIssueRequest): Promise<CreatedIssue> {
    this.seq += 1;
    const ref = `${req.repo}#${this.seq}`;
    this.issues.set(ref, { ref, title: req.title, body: req.body, labels: [...req.labels] });
    const created = { ref, url: `memory://${ref}` };
    this.created.push(created);
    return created;
  }

  getComments(ref: string): string[] {
    return this.comments.get(ref) ?? [];
  }

  getLabels(ref: string): string[] {
    return Array.from(this.labels.get(ref) ?? []);
  }

  listCreated(): CreatedIssue[] {
    return [...this.created];
  }
}
