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
function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function parseLinearIssueEvent(payload: unknown): LinearIssueEvent | null {
  const body = payload as LinearIssueWebhookPayload;
  if (body == null || typeof body !== 'object') {
    return null;
  }
  if (body.type !== 'Issue') {
    return null;
  }
  if (body.action !== 'create' && body.action !== 'update') {
    return null;
  }
  const identifier = body.data?.identifier;
  // Untrusted external payload -- `identifier` is only cast, never validated,
  // so a webhook sender putting a non-string here (legal JSON, e.g. a number
  // or object) must not reach identifier.indexOf below.
  if (typeof identifier !== 'string' || identifier.length === 0) {
    return null;
  }
  const separatorIndex = identifier.indexOf('-');
  if (separatorIndex <= 0) {
    return null;
  }
  const labelIds = asStringArray(body.data?.labelIds);
  // Linear's `updatedFrom` carries only the fields that changed in this
  // particular delivery -- if `labelIds` isn't a key on it at all, labels
  // didn't change, and the previous set equals the current set. Falling back
  // to `[]` instead would conflate "labels unchanged" with "labels used to
  // be empty," making an unrelated edit (title, state, assignee, ...) on an
  // already-labeled issue look like a fresh "labeled" event and re-trigger
  // devCycle under the same (already-completed) workflow id.
  const updatedFromHasLabelIds =
    body.action === 'update' && body.updatedFrom != null && 'labelIds' in body.updatedFrom;
  const previousLabelIds =
    body.action !== 'update'
      ? undefined
      : updatedFromHasLabelIds
        ? asStringArray(body.updatedFrom?.labelIds)
        : labelIds;
  return {
    teamKey: identifier.slice(0, separatorIndex),
    identifier,
    title: typeof body.data?.title === 'string' ? body.data.title : '',
    labelIds,
    previousLabelIds,
    webhookTimestamp: typeof body.webhookTimestamp === 'number' ? body.webhookTimestamp : undefined,
  };
}

// Linear's Issue webhook never carries a label *name* -- only `labelIds`
// (UUIDs) -- so the configured trigger label is matched by id, not by name
// like GitHub's TRIGGER_LABEL. True for both a fresh `update` that adds the
// label and a `create` where the issue already carries it; false if the
// label was already present before this particular change (some other field
// changed, not a fresh "labeled" event).
export function matchesLinearTriggerLabel(
  event: LinearIssueEvent,
  triggerLabelId: string,
): boolean {
  if (!event.labelIds.includes(triggerLabelId)) {
    return false;
  }
  if (event.previousLabelIds !== undefined && event.previousLabelIds.includes(triggerLabelId)) {
    return false;
  }
  return true;
}
