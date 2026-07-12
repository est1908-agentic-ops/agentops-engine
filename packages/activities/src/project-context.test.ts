import { describe, it, expect } from 'vitest';
import { ApplicationFailure } from '@temporalio/common';
import { projectContext, getCallerProject, assertProjectOwnsRepo } from './project-context';

const registry = [{ project: 'acme', repo: 'acme/web' }, { project: 'globex', repo: 'globex/api' }];

describe('project authorization guard', () => {
  it('allows when the caller project owns the repo', () => {
    projectContext.run({ project: 'acme' }, () => {
      expect(() => assertProjectOwnsRepo('acme/web', registry)).not.toThrow();
    });
  });
  it('rejects a mismatched project', () => {
    projectContext.run({ project: 'acme' }, () => {
      expect(() => assertProjectOwnsRepo('globex/api', registry)).toThrow(ApplicationFailure);
    });
  });
  it('allows when no caller project is present (engine-internal/trusted)', () => {
    expect(getCallerProject()).toBeUndefined();
    expect(() => assertProjectOwnsRepo('globex/api', registry)).not.toThrow();
  });
  it('allows an unregistered repo (no scoped token exists anyway)', () => {
    projectContext.run({ project: 'acme' }, () => {
      expect(() => assertProjectOwnsRepo('nobody/repo', registry)).not.toThrow();
    });
  });
});
