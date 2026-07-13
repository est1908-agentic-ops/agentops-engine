import { describe, expect, it } from 'vitest';
import { PrFeedbackSchema, feedbackHash } from './pr-feedback';

const feedback = (overrides: Partial<Parameters<typeof PrFeedbackSchema.parse>[0]> = {}) =>
  PrFeedbackSchema.parse({
    ciStatus: 'failed',
    unresolvedThreads: 1,
    comments: [{ id: 'c1', body: 'fix this', resolved: false }],
    ...overrides,
  });

describe('PrFeedbackSchema', () => {
  it('parses a feedback record', () => {
    expect(feedback().ciStatus).toBe('failed');
  });

  it('accepts unreadable as a ciStatus (a source is structurally unreadable, e.g. a 403 on the Checks API)', () => {
    expect(feedback({ ciStatus: 'unreadable' }).ciStatus).toBe('unreadable');
  });
});

describe('feedbackHash', () => {
  it('is stable for identical feedback', () => {
    expect(feedbackHash(feedback())).toBe(feedbackHash(feedback()));
  });

  it('changes when ciStatus changes', () => {
    expect(feedbackHash(feedback({ ciStatus: 'green', unresolvedThreads: 0, comments: [] }))).not.toBe(
      feedbackHash(feedback()),
    );
  });

  it('is insensitive to comment ordering', () => {
    const a = feedback({
      comments: [
        { id: 'c1', body: 'x', resolved: false },
        { id: 'c2', body: 'y', resolved: false },
      ],
    });
    const b = feedback({
      comments: [
        { id: 'c2', body: 'y', resolved: false },
        { id: 'c1', body: 'x', resolved: false },
      ],
    });
    expect(feedbackHash(a)).toBe(feedbackHash(b));
  });

  it('ignores already-resolved comments', () => {
    const withResolved = feedback({
      comments: [
        { id: 'c1', body: 'x', resolved: false },
        { id: 'c2', body: 'stale', resolved: true },
      ],
    });
    const withoutResolved = feedback({ comments: [{ id: 'c1', body: 'x', resolved: false }] });
    expect(feedbackHash(withResolved)).toBe(feedbackHash(withoutResolved));
  });
});
