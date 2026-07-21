import { describe, expect, it } from 'vitest';
import { parsePrReviewEvent } from './parse-pr-review-event';

describe('parsePrReviewEvent', () => {
  const basePayload = {
    action: 'submitted',
    review: { body: 'please fix the foo' },
    pull_request: {
      number: 42,
      labels: [{ name: 'agentops' }],
      head: { ref: 'agentops/fix-foo' },
    },
    repository: { full_name: 'octocat/hello-world' },
  };

  it('parses a matching pull_request_review/submitted with agentops label', () => {
    const event = parsePrReviewEvent('pull_request_review', basePayload);
    expect(event).toEqual({
      repo: 'octocat/hello-world',
      prRef: 'octocat/hello-world#42',
      prNumber: 42,
      reviewBody: 'please fix the foo',
      action: 'submitted',
      headBranch: 'agentops/fix-foo',
      hasAgentopsLabel: true,
    });
  });

  it('ignores non pull_request_review events', () => {
    expect(parsePrReviewEvent('issues', basePayload)).toBeNull();
    expect(parsePrReviewEvent(undefined, basePayload)).toBeNull();
  });

  it('ignores non-submitted actions', () => {
    expect(
      parsePrReviewEvent('pull_request_review', { ...basePayload, action: 'edited' }),
    ).toBeNull();
  });

  it('sets hasAgentopsLabel false when label missing', () => {
    const noLabel = {
      ...basePayload,
      pull_request: { ...basePayload.pull_request, labels: [] },
    };
    const event = parsePrReviewEvent('pull_request_review', noLabel);
    expect(event?.hasAgentopsLabel).toBe(false);
  });

  it('handles missing review body', () => {
    const noBody = { ...basePayload, review: {} };
    const event = parsePrReviewEvent('pull_request_review', noBody);
    expect(event?.reviewBody).toBe('');
  });

  it('rejects events with hostile branch names', () => {
    const hostile = {
      ...basePayload,
      pull_request: { ...basePayload.pull_request, head: { ref: '--upload-pack=/tmp/x' } },
    };
    expect(parsePrReviewEvent('pull_request_review', hostile)).toBeNull();
  });

  it('rejects events with leading-dash branch names', () => {
    const leadingDash = {
      ...basePayload,
      pull_request: { ...basePayload.pull_request, head: { ref: '-x' } },
    };
    expect(parsePrReviewEvent('pull_request_review', leadingDash)).toBeNull();
  });

  it('accepts events with missing headBranch', () => {
    const noHeadBranch = {
      ...basePayload,
      pull_request: {
        ...basePayload.pull_request,
        head: { ref: undefined },
      },
    };
    const event = parsePrReviewEvent('pull_request_review', noHeadBranch);
    expect(event?.prRef).toBe('octocat/hello-world#42');
    expect(event?.headBranch).toBeUndefined();
  });
});
