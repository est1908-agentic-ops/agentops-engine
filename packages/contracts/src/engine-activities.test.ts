import { describe, it, expectTypeOf } from 'vitest';
import type { EngineActivities } from './engine-activities';
import type {
  CleanupRepositorySessionRequest,
  CreateRepositorySessionRequest,
  RepositorySession,
} from './repository-session';

describe('EngineActivities', () => {
  it('exposes the minimal delegatable surface', () => {
    expectTypeOf<EngineActivities>().toHaveProperty('runAgent');
    expectTypeOf<EngineActivities>().toHaveProperty('createIssue');
    expectTypeOf<EngineActivities>().toHaveProperty('getIssue');
    expectTypeOf<EngineActivities>().toHaveProperty('createRepositorySession');
    expectTypeOf<EngineActivities>().toHaveProperty('cleanupRepositorySession');
  });

  it('uses repository-session contract types for lifecycle methods', () => {
    expectTypeOf<EngineActivities['createRepositorySession']>().toEqualTypeOf<
      (req: CreateRepositorySessionRequest) => Promise<RepositorySession>
    >();
    expectTypeOf<EngineActivities['cleanupRepositorySession']>().toEqualTypeOf<
      (req: CleanupRepositorySessionRequest) => Promise<void>
    >();
  });
});
