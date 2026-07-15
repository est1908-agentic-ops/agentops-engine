import { describe, expect, it } from 'vitest';
import { parsePushEvent } from './parse-push-event';

describe('parsePushEvent', () => {
  it('extracts the repo from a push payload', () => {
    expect(parsePushEvent('push', { repository: { full_name: 'o/r' } })).toEqual({ repo: 'o/r' });
  });

  it('ignores non-push events', () => {
    expect(parsePushEvent('issues', { repository: { full_name: 'o/r' } })).toBeNull();
  });
});
