import { describe, expect, it } from 'vitest';
import { matchPath } from './route';

describe('matchPath', () => {
  it('matches an exact literal path with no params', () => {
    expect(matchPath('/healthz', '/healthz')).toEqual({ params: {} });
  });

  it('returns null for a literal path that does not match', () => {
    expect(matchPath('/healthz', '/nope')).toBeNull();
  });

  it('extracts a single path param', () => {
    expect(matchPath('/api/platform/runs/:workflowId', '/api/platform/runs/platform-1')).toEqual({
      params: { workflowId: 'platform-1' },
    });
  });

  it('returns null when segment counts differ', () => {
    expect(matchPath('/api/platform/runs/:workflowId', '/api/platform/runs')).toBeNull();
    expect(matchPath('/api/platform/runs/:workflowId', '/api/platform/runs/a/b')).toBeNull();
  });

  it('returns null when a literal segment does not match, even with a param present', () => {
    expect(matchPath('/api/platform/runs/:workflowId', '/api/other/runs/platform-1')).toBeNull();
  });

  it('URL-decodes the param value', () => {
    expect(matchPath('/api/platform/runs/:workflowId', '/api/platform/runs/platform%2F1')).toEqual({
      params: { workflowId: 'platform/1' },
    });
  });

  it('returns null for a malformed percent-encoded param', () => {
    expect(matchPath('/api/platform/runs/:workflowId', '/api/platform/runs/platform%')).toBeNull();
  });
});
