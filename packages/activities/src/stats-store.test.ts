import { describe, expect, it } from 'vitest';
import { InMemoryStatsStore } from './stats-store';

describe('InMemoryStatsStore', () => {
  it('records and returns run stats in insertion order', async () => {
    const store = new InMemoryStatsStore();
    await store.record({
      taskId: 't1',
      stage: 'implement',
      backend: 'stub',
      model: 'stub-v1',
      tokensIn: 10,
      tokensOut: 5,
      wallMs: 100,
      outcome: 'pass',
    });
    const all = await store.all();
    expect(all).toHaveLength(1);
    expect(all[0].stage).toBe('implement');
  });
});
