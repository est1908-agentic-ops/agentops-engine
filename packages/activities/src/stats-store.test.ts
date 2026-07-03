import { describe, expect, it } from 'vitest';
import { InMemoryStatsStore } from './stats-store';

describe('InMemoryStatsStore', () => {
  it('records and returns run stats in insertion order', () => {
    const store = new InMemoryStatsStore();
    store.record({
      taskId: 't1',
      stage: 'implement',
      backend: 'stub',
      model: 'stub-v1',
      tokensIn: 10,
      tokensOut: 5,
      wallMs: 100,
      outcome: 'pass',
    });
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0].stage).toBe('implement');
  });
});
