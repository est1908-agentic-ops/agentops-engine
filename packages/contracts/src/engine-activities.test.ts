import { describe, it, expectTypeOf } from 'vitest';
import type { EngineActivities } from './engine-activities';

describe('EngineActivities', () => {
  it('exposes the minimal delegatable surface', () => {
    expectTypeOf<EngineActivities>().toHaveProperty('runAgent');
    expectTypeOf<EngineActivities>().toHaveProperty('createIssue');
    expectTypeOf<EngineActivities>().toHaveProperty('getIssue');
  });
});
