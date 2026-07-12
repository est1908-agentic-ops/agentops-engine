import { describe, it, expect } from 'vitest';
import { PROJECT_HEADER_KEY, readProjectFromMemo } from './project-identity';

describe('project identity', () => {
  it('has a stable header key', () => {
    expect(PROJECT_HEADER_KEY).toBe('x-agentops-project');
  });
  it('reads project from a memo, undefined when absent', () => {
    expect(readProjectFromMemo({ project: 'acme' })).toBe('acme');
    expect(readProjectFromMemo({})).toBeUndefined();
    expect(readProjectFromMemo(undefined)).toBeUndefined();
  });
});
