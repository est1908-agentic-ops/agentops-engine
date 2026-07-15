import { describe, expect, it } from 'vitest';
import { parsePrLandingEvent } from './parse-pr-landing-event';

const basePayload = {
  pull_request: {
    number: 7,
    head: { ref: 'feature/x' },
    labels: [{ name: 'agentops:managed' }],
  },
  repository: { full_name: 'octocat/hello-world' },
};

describe('parsePrLandingEvent', () => {
  it('enrolls on automerge labeled', () => {
    const event = parsePrLandingEvent('pull_request', {
      action: 'labeled',
      label: { name: 'automerge' },
      ...basePayload,
    });
    expect(event).toMatchObject({ kind: 'enroll', prRef: 'octocat/hello-world#7', managed: true });
  });

  it('wakes on automerge:disable labeled', () => {
    const event = parsePrLandingEvent('pull_request', {
      action: 'labeled',
      label: { name: 'automerge:disable' },
      ...basePayload,
    });
    expect(event?.kind).toBe('wake');
  });

  it('wakes on automerge unlabeled', () => {
    const event = parsePrLandingEvent('pull_request', {
      action: 'unlabeled',
      label: { name: 'automerge' },
      ...basePayload,
    });
    expect(event?.kind).toBe('wake');
  });

  it('wakes on submitted review when managed', () => {
    const event = parsePrLandingEvent('pull_request_review', {
      action: 'submitted',
      ...basePayload,
    });
    expect(event?.kind).toBe('wake');
  });

  it('ignores submitted review without managed or automerge labels', () => {
    const event = parsePrLandingEvent('pull_request_review', {
      action: 'submitted',
      pull_request: { number: 7, head: { ref: 'feature/x' }, labels: [] },
      repository: { full_name: 'octocat/hello-world' },
    });
    expect(event).toBeNull();
  });
});