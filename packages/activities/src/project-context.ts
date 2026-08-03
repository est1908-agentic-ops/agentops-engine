import { AsyncLocalStorage } from 'node:async_hooks';
import { ApplicationFailure } from '@temporalio/common';
import { normalizeRepo } from '@agentops/ports';

export interface ProjectCallContext {
  project?: string;
}

// Populated by the engine worker's activity-inbound interceptor from the
// PROJECT_HEADER_KEY header for the duration of each activity execution.
export const projectContext = new AsyncLocalStorage<ProjectCallContext>();

export function getCallerProject(): string | undefined {
  return projectContext.getStore()?.project;
}

function normalizedRepositoryName(repo: string): string {
  return normalizeRepo(repo).toLowerCase();
}

/**
 * Ensures the project stamped on the current activity invocation may read
 * every requested repository. This is deliberately a pure, all-or-nothing
 * guard: callers must pass it before creating a workspace or touching a port.
 */
export function assertProjectCanReadRepositories<
  T extends { project: string; repo: string; readRepositories: string[] },
>(repos: string[], registry: T[]): T {
  if (repos.length === 0) {
    throw ApplicationFailure.nonRetryable(
      'repository read request must include at least one repository',
      'ProjectAuthorizationError',
    );
  }

  const callerProject = getCallerProject();
  if (!callerProject) {
    throw ApplicationFailure.nonRetryable(
      `missing caller project context for repository read request: ${repos.join(', ')}`,
      'ProjectAuthorizationError',
    );
  }

  const callerEntry = registry.find((entry) => entry.project === callerProject);
  if (!callerEntry) {
    throw ApplicationFailure.nonRetryable(
      `project "${callerProject}" is not registered to read requested repositories: ${repos.join(', ')}`,
      'ProjectAuthorizationError',
    );
  }

  const requestedRepositories = repos.map(normalizedRepositoryName);
  const seen = new Set<string>();
  for (const repo of requestedRepositories) {
    if (seen.has(repo)) {
      throw ApplicationFailure.nonRetryable(
        `project "${callerProject}" requested duplicate repository "${repo}"`,
        'ProjectAuthorizationError',
      );
    }
    seen.add(repo);
  }

  const allowedRepositories = new Set([
    normalizedRepositoryName(callerEntry.repo),
    ...callerEntry.readRepositories.map(normalizedRepositoryName),
  ]);
  const deniedRepository = requestedRepositories.find((repo) => !allowedRepositories.has(repo));
  if (deniedRepository) {
    throw ApplicationFailure.nonRetryable(
      `project "${callerProject}" is not authorized to read repository "${deniedRepository}"`,
      'ProjectAuthorizationError',
    );
  }

  return callerEntry;
}

// Rejects a repo-touching activity whose caller project does not own the repo.
// Absent caller project => engine-internal/trusted call (no cross-project
// claim to check). Unregistered repo => the engine holds no scoped token for
// it, so downstream fails naturally; no need to reject here. Only a *mismatch*
// between a stamped project and a registered repo's owner is an authz failure
// (this catches accidental cross-project action). SP2 design §7.2/§7.3.
export function assertProjectOwnsRepo(
  repo: string,
  registry: { project: string; repo: string }[],
): void {
  const claimed = getCallerProject();
  if (!claimed) return;
  const target = normalizeRepo(repo);
  const owner = registry.find((e) => normalizeRepo(e.repo) === target)?.project;
  if (owner && owner !== claimed) {
    throw ApplicationFailure.nonRetryable(
      `project "${claimed}" is not authorized to act on repo "${repo}" (owned by "${owner}")`,
      'ProjectAuthorizationError',
    );
  }
}
