import { ActivityFailure, ApplicationFailure } from '@temporalio/workflow';

export function isGitPushPermissionFailure(err: unknown): boolean {
  return (
    err instanceof ActivityFailure &&
    err.cause instanceof ApplicationFailure &&
    err.cause.type === 'GitPushPermissionError'
  );
}
