import type { Issue, TrackerPort, CreateIssueRequest, CreatedIssue } from '../tracker-port';
import { parseTrackerRef } from '../tracker-ref';
import type { LinearClient } from './linear-client';

function requireLinearRef(ref: string): { teamKey: string; identifier: string } {
  const parsed = parseTrackerRef(ref);
  if (parsed.kind !== 'linear') {
    throw new Error(`LinearTrackerPort: expected a "linear:" ref, got "${ref}"`);
  }
  return parsed;
}

export class LinearTrackerPort implements TrackerPort {
  constructor(private readonly client: LinearClient) {}

  async getIssue(ref: string): Promise<Issue> {
    const { identifier } = requireLinearRef(ref);
    const issue = await this.client.getIssue(identifier);
    return { ref, title: issue.title, body: issue.description ?? '', labels: issue.labelNames };
  }

  async comment(ref: string, body: string): Promise<void> {
    const { identifier } = requireLinearRef(ref);
    const issue = await this.client.getIssue(identifier);
    await this.client.createComment(issue.id, body);
  }

  // Not on devCycle's hot path today (see the design doc's non-goals) --
  // implemented to match GithubTrackerPort's additive semantics rather than
  // stubbed: Linear's issueUpdate replaces the full labelIds set, so this
  // reads the issue's current labels first and merges the new one in.
  //
  // This read-then-write is NOT race-safe, unlike GitHub's atomic addLabels:
  // a concurrent label() call, or a human editing labels in the Linear UI
  // between the read and the write, can silently lose a label. Low blast
  // radius while nothing calls label() on the hot path -- revisit (version
  // check or retry-on-conflict) before anything wires this up for real.
  async label(ref: string, label: string): Promise<void> {
    const { teamKey, identifier } = requireLinearRef(ref);
    const issue = await this.client.getIssue(identifier);
    const labelId = await this.client.findLabelId(teamKey, label);
    if (!labelId) {
      throw new Error(`LinearTrackerPort.label: no label named "${label}" found for team "${teamKey}"`);
    }
    if (issue.labelIds.includes(labelId)) {
      return;
    }
    await this.client.setLabelIds(issue.id, [...issue.labelIds, labelId]);
  }

  // Idempotent to match GithubTrackerPort.removeLabel's swallowed 404s: an
  // unknown team label or a label the issue never carried is a no-op. This is
  // important because devCycle can call dropAgentWorking() when agent:working
  // was never applied, and that cleanup must not fail successful work.
  //
  // Like label(), this is a read-then-write operation. Linear's issueUpdate
  // replaces the complete labelIds set, so a concurrent label edit between
  // these calls can be lost; this method is not atomic.
  async removeLabel(ref: string, label: string): Promise<void> {
    const { teamKey, identifier } = requireLinearRef(ref);
    const labelId = await this.client.findLabelId(teamKey, label);
    if (!labelId) {
      return;
    }
    const issue = await this.client.getIssue(identifier);
    if (!issue.labelIds.includes(labelId)) {
      return;
    }
    await this.client.setLabelIds(
      issue.id,
      issue.labelIds.filter((current) => current !== labelId),
    );
  }

  async createIssue(_req: CreateIssueRequest): Promise<CreatedIssue> {
    throw new Error('LinearTrackerPort.createIssue not implemented (SP1 focuses on GitHub trackers)');
  }
}
