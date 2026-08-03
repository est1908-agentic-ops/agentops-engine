import { describe, it, expect } from 'vitest';
import { ApplicationFailure } from '@temporalio/common';
import type { ResolvedProjectEntry } from '@agentops/contracts';
import {
  projectContext,
  getCallerProject,
  assertProjectOwnsRepo,
  assertProjectCanReadRepositories,
} from './project-context';

const registry = [
  { project: 'acme', repo: 'acme/web' },
  { project: 'globex', repo: 'globex/api' },
];

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

const resolvedRegistry: ResolvedProjectEntry[] = [
  {
    project: 'hub',
    repo: 'flair-hr/employee-hub-monorepo',
    readRepositories: ['flair-hr/shared-contracts'],
    trackerType: 'github',
    token: 'hub-token',
  },
  {
    project: 'other',
    repo: 'flair-hr/other',
    readRepositories: [],
    trackerType: 'github',
    token: 'other-token',
  },
];

function expectAuthorizationFailure(action: () => unknown, message: RegExp): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ApplicationFailure);
  expect((thrown as ApplicationFailure).type).toBe('ProjectAuthorizationError');
  expect((thrown as ApplicationFailure).nonRetryable).toBe(true);
  expect((thrown as Error).message).toMatch(message);
  expect((thrown as Error).message).not.toContain('hub-token');
  expect((thrown as Error).message).not.toContain('other-token');
}

describe('repository-session authorization guard', () => {
  it('rejects an empty repository request', () => {
    projectContext.run({ project: 'hub' }, () => {
      expectAuthorizationFailure(
        () => assertProjectCanReadRepositories([], resolvedRegistry),
        /at least one repository/i,
      );
    });
  });

  it('allows the calling project to read its primary repository', () => {
    projectContext.run({ project: 'hub' }, () => {
      const entry = assertProjectCanReadRepositories(
        ['flair-hr/employee-hub-monorepo'],
        resolvedRegistry,
      );

      expect(entry).toBe(resolvedRegistry[0]);
      expect(entry.token).toBe('hub-token');
    });
  });

  it('allows repositories explicitly listed in readRepositories', () => {
    projectContext.run({ project: 'hub' }, () => {
      expect(
        assertProjectCanReadRepositories(['flair-hr/shared-contracts'], resolvedRegistry),
      ).toBe(resolvedRegistry[0]);
    });
  });

  it('rejects the whole requested set when one repository is unauthorized', () => {
    projectContext.run({ project: 'hub' }, () => {
      expectAuthorizationFailure(
        () =>
          assertProjectCanReadRepositories(
            ['flair-hr/employee-hub-monorepo', 'flair-hr/other'],
            resolvedRegistry,
          ),
        /hub.*flair-hr\/other/i,
      );
    });
  });

  it('rejects requests without caller project context', () => {
    expectAuthorizationFailure(
      () => assertProjectCanReadRepositories(['flair-hr/employee-hub-monorepo'], resolvedRegistry),
      /caller project.*flair-hr\/employee-hub-monorepo/i,
    );
  });

  it('rejects an unknown caller project', () => {
    projectContext.run({ project: 'missing' }, () => {
      expectAuthorizationFailure(
        () =>
          assertProjectCanReadRepositories(['flair-hr/employee-hub-monorepo'], resolvedRegistry),
        /missing.*flair-hr\/employee-hub-monorepo/i,
      );
    });
  });

  it('compares repositories case-insensitively while preserving project identity', () => {
    projectContext.run({ project: 'hub' }, () => {
      expect(
        assertProjectCanReadRepositories(
          ['FLAIR-HR/EMPLOYEE-HUB-MONOREPO', 'FLAIR-HR/SHARED-CONTRACTS'],
          resolvedRegistry,
        ),
      ).toBe(resolvedRegistry[0]);
    });

    projectContext.run({ project: 'HUB' }, () => {
      expectAuthorizationFailure(
        () =>
          assertProjectCanReadRepositories(['flair-hr/employee-hub-monorepo'], resolvedRegistry),
        /HUB.*flair-hr\/employee-hub-monorepo/i,
      );
    });
  });

  it('rejects duplicate requested repositories for direct callers', () => {
    projectContext.run({ project: 'hub' }, () => {
      expectAuthorizationFailure(
        () =>
          assertProjectCanReadRepositories(
            ['flair-hr/shared-contracts', 'FLAIR-HR/SHARED-CONTRACTS'],
            resolvedRegistry,
          ),
        /hub.*duplicate.*flair-hr\/shared-contracts/i,
      );
    });
  });
});
