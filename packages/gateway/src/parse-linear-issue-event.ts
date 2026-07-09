export interface LinearIssueEvent {
  teamKey: string; // derived from data.identifier's prefix, e.g. "ENG-123" -> "ENG"
  identifier: string; // e.g. "ENG-123"
  title: string;
  labelIds: string[];
  previousLabelIds: string[] | undefined; // undefined on `create` -- no prior state to compare
  webhookTimestamp: number | undefined;
}

interface LinearIssueWebhookPayload {
  action?: string;
  type?: string;
  data?: { identifier?: string; title?: string; labelIds?: string[] };
  updatedFrom?: { labelIds?: string[] };
  webhookTimestamp?: number;
}

// Unlike GitHub (which needs the X-GitHub-Event header to know what kind of
// event a delivery carries), every Linear webhook payload self-describes its
// resource via `type` -- there's no separate header to gate on here.
//
// Deliberately NOT filtered by trigger label here: which label id triggers a
// task is a per-*project* setting (ResolvedProjectEntry.linearTriggerLabelId),
// but the project can only be resolved from this event's teamKey -- so
// project lookup has to happen between parsing and label-matching. See
// matchesLinearTriggerLabel and docs/superpowers/specs/2026-07-09-linear-trigger-design.md.
export function parseLinearIssueEvent(payload: unknown): LinearIssueEvent | null {
  const body = payload as LinearIssueWebhookPayload;
  if (body.type !== 'Issue') {
    return null;
  }
  if (body.action !== 'create' && body.action !== 'update') {
    return null;
  }
  const identifier = body.data?.identifier;
  if (!identifier) {
    return null;
  }
  const separatorIndex = identifier.indexOf('-');
  if (separatorIndex <= 0) {
    return null;
  }
  return {
    teamKey: identifier.slice(0, separatorIndex),
    identifier,
    title: body.data?.title ?? '',
    labelIds: body.data?.labelIds ?? [],
    previousLabelIds: body.action === 'update' ? body.updatedFrom?.labelIds ?? [] : undefined,
    webhookTimestamp: body.webhookTimestamp,
  };
}

// Linear's Issue webhook never carries a label *name* -- only `labelIds`
// (UUIDs) -- so the configured trigger label is matched by id, not by name
// like GitHub's TRIGGER_LABEL. True for both a fresh `update` that adds the
// label and a `create` where the issue already carries it; false if the
// label was already present before this particular change (some other field
// changed, not a fresh "labeled" event).
export function matchesLinearTriggerLabel(event: LinearIssueEvent, triggerLabelId: string): boolean {
  if (!event.labelIds.includes(triggerLabelId)) {
    return false;
  }
  if (event.previousLabelIds !== undefined && event.previousLabelIds.includes(triggerLabelId)) {
    return false;
  }
  return true;
}
