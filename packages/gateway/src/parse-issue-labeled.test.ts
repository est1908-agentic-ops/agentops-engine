import { describe, expect, it } from 'vitest';
import { parseIssueLabeledEvent } from './parse-issue-labeled';

const TRIGGER_LABEL = 'agentops';

function labeledPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'labeled',
    label: { name: TRIGGER_LABEL },
    issue: { number: 42, title: 'Add a widget' },
    repository: { full_name: 'octocat/hello-world' },
    ...overrides,
  };
}

describe('parseIssueLabeledEvent', () => {
  it('parses a matching issues/labeled event', () => {
    const event = parseIssueLabeledEvent('issues', labeledPayload(), TRIGGER_LABEL);
    expect(event).toEqual({
      repo: 'octocat/hello-world',
      issueRef: 'octocat/hello-world#42',
      issueNumber: 42,
      title: 'Add a widget',
    });
  });

  it('ignores events that are not the "issues" event type', () => {
    expect(parseIssueLabeledEvent('pull_request', labeledPayload(), TRIGGER_LABEL)).toBeNull();
    expect(parseIssueLabeledEvent(undefined, labeledPayload(), TRIGGER_LABEL)).toBeNull();
  });

  it('ignores issues events whose action is not "labeled"', () => {
    expect(parseIssueLabeledEvent('issues', labeledPayload({ action: 'opened' }), TRIGGER_LABEL)).toBeNull();
    expect(parseIssueLabeledEvent('issues', labeledPayload({ action: 'closed' }), TRIGGER_LABEL)).toBeNull();
  });

  it('ignores a labeled event for a different label', () => {
    const event = parseIssueLabeledEvent(
      'issues',
      labeledPayload({ label: { name: 'bug' } }),
      TRIGGER_LABEL,
    );
    expect(event).toBeNull();
  });

  it('ignores a malformed payload missing required fields', () => {
    expect(parseIssueLabeledEvent('issues', labeledPayload({ repository: undefined }), TRIGGER_LABEL)).toBeNull();
    expect(parseIssueLabeledEvent('issues', labeledPayload({ issue: undefined }), TRIGGER_LABEL)).toBeNull();
    expect(parseIssueLabeledEvent('issues', {}, TRIGGER_LABEL)).toBeNull();
  });

  it('defaults a missing issue title to an empty string', () => {
    const event = parseIssueLabeledEvent(
      'issues',
      labeledPayload({ issue: { number: 42, title: undefined } }),
      TRIGGER_LABEL,
    );
    expect(event?.title).toBe('');
  });
});
