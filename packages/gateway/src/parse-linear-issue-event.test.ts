import { describe, expect, it } from 'vitest';
import { matchesLinearTriggerLabel, parseLinearIssueEvent } from './parse-linear-issue-event';

const TRIGGER_LABEL_ID = 'label-uuid-1';

describe('parseLinearIssueEvent', () => {
  it('parses an update event', () => {
    const event = parseLinearIssueEvent({
      type: 'Issue',
      action: 'update',
      data: {
        identifier: 'ENG-123',
        title: 'Fix the thing',
        labelIds: [TRIGGER_LABEL_ID, 'other'],
      },
      updatedFrom: { labelIds: ['other'] },
      webhookTimestamp: 123,
    });

    expect(event).toEqual({
      teamKey: 'ENG',
      identifier: 'ENG-123',
      title: 'Fix the thing',
      labelIds: [TRIGGER_LABEL_ID, 'other'],
      previousLabelIds: ['other'],
      webhookTimestamp: 123,
    });
  });

  it('parses a create event with no previousLabelIds', () => {
    const event = parseLinearIssueEvent({
      type: 'Issue',
      action: 'create',
      data: { identifier: 'ENG-1', title: 'New', labelIds: [TRIGGER_LABEL_ID] },
    });

    expect(event).toEqual({
      teamKey: 'ENG',
      identifier: 'ENG-1',
      title: 'New',
      labelIds: [TRIGGER_LABEL_ID],
      previousLabelIds: undefined,
      webhookTimestamp: undefined,
    });
  });

  it('ignores a non-Issue payload type', () => {
    expect(parseLinearIssueEvent({ type: 'Comment', action: 'create', data: {} })).toBeNull();
  });

  it('ignores a remove action', () => {
    expect(
      parseLinearIssueEvent({ type: 'Issue', action: 'remove', data: { identifier: 'ENG-1' } }),
    ).toBeNull();
  });

  it('ignores a malformed identifier with no team-key separator', () => {
    expect(
      parseLinearIssueEvent({ type: 'Issue', action: 'create', data: { identifier: 'malformed' } }),
    ).toBeNull();
  });

  it('ignores a payload missing an identifier', () => {
    expect(parseLinearIssueEvent({ type: 'Issue', action: 'create', data: {} })).toBeNull();
  });

  it('does not throw and returns null for a non-string identifier (adversarial/malformed payload)', () => {
    expect(() =>
      parseLinearIssueEvent({ type: 'Issue', action: 'create', data: { identifier: 12345 } }),
    ).not.toThrow();
    expect(
      parseLinearIssueEvent({ type: 'Issue', action: 'create', data: { identifier: 12345 } }),
    ).toBeNull();
    expect(
      parseLinearIssueEvent({
        type: 'Issue',
        action: 'create',
        data: { identifier: { foo: 'bar' } },
      }),
    ).toBeNull();
    expect(
      parseLinearIssueEvent({ type: 'Issue', action: 'create', data: { identifier: ['ENG-1'] } }),
    ).toBeNull();
  });

  it('treats previousLabelIds as unchanged (equal to current), not empty, when updatedFrom omits labelIds', () => {
    // An update to an unrelated field (title/state/assignee/...) on an
    // already-labeled issue carries no `labelIds` key on updatedFrom at all
    // -- Linear's updatedFrom only lists fields that actually changed.
    const event = parseLinearIssueEvent({
      type: 'Issue',
      action: 'update',
      data: { identifier: 'ENG-123', title: 'Renamed', labelIds: [TRIGGER_LABEL_ID] },
      updatedFrom: { title: 'Old title' },
    });

    expect(event?.previousLabelIds).toEqual([TRIGGER_LABEL_ID]);
  });
});

describe('matchesLinearTriggerLabel', () => {
  const baseEvent = {
    teamKey: 'ENG',
    identifier: 'ENG-1',
    title: 't',
    webhookTimestamp: undefined,
  };

  it('matches a create where the issue already carries the trigger label', () => {
    const event = { ...baseEvent, labelIds: [TRIGGER_LABEL_ID], previousLabelIds: undefined };
    expect(matchesLinearTriggerLabel(event, TRIGGER_LABEL_ID)).toBe(true);
  });

  it('matches an update that adds the trigger label', () => {
    const event = {
      ...baseEvent,
      labelIds: [TRIGGER_LABEL_ID, 'other'],
      previousLabelIds: ['other'],
    };
    expect(matchesLinearTriggerLabel(event, TRIGGER_LABEL_ID)).toBe(true);
  });

  it('does not match when the trigger label is absent', () => {
    const event = { ...baseEvent, labelIds: ['other'], previousLabelIds: [] };
    expect(matchesLinearTriggerLabel(event, TRIGGER_LABEL_ID)).toBe(false);
  });

  it('does not match when the trigger label was already present before this update', () => {
    const event = {
      ...baseEvent,
      labelIds: [TRIGGER_LABEL_ID, 'new-unrelated'],
      previousLabelIds: [TRIGGER_LABEL_ID],
    };
    expect(matchesLinearTriggerLabel(event, TRIGGER_LABEL_ID)).toBe(false);
  });

  it('does not re-match (no devCycle re-trigger) for an unrelated edit to an already-labeled issue', () => {
    // Regression for the "updatedFrom omits labelIds" parsing fix above --
    // previousLabelIds equal to labelIds here means "labels didn't change".
    const event = {
      ...baseEvent,
      labelIds: [TRIGGER_LABEL_ID],
      previousLabelIds: [TRIGGER_LABEL_ID],
    };
    expect(matchesLinearTriggerLabel(event, TRIGGER_LABEL_ID)).toBe(false);
  });
});
