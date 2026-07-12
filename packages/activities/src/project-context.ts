import { AsyncLocalStorage } from 'node:async_hooks';
import { ApplicationFailure } from '@temporalio/common';
import { normalizeRepo } from '@agentops/ports';

export interface ProjectCallContext { project?: string }

// Populated by the engine worker's activity-inbound interceptor from the
// PROJECT_HEADER_KEY header for the duration of each activity execution.
export const projectContext = new AsyncLocalStorage<ProjectCallContext>();

export function getCallerProject(): string | undefined {
  return projectContext.getStore()?.project;
}

// Rejects a repo-touching activity whose caller project does not own the repo.
// Absent caller project => engine-internal/trusted call (no cross-project
// claim to check). Unregistered repo => the engine holds no scoped token for
// it, so downstream fails naturally; no need to reject here. Only a *mismatch*
// between a stamped project and a registered repo's owner is an authz failure
// (this catches accidental cross-project action). SP2 design §7.2/§7.3.
export function assertProjectOwnsRepo(repo: string, registry: { project: string; repo: string }[]): void {
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
